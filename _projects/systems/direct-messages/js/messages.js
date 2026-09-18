/* Messages -- private one-to-one conversations.
 *
 * Signing in is required. A conversation is between two accounts and lives on
 * the server, so there is no offline or signed-out mode: without an account
 * there is nobody to be, and nowhere to deliver to. When the page cannot reach
 * an account it says why and stays inert rather than pretending to work.
 *
 * The conversation panel is the site's group-chat component -- same markup,
 * same classes, same styles (_sass/open-coding/chat-ui.scss), same rich-text
 * composer -- so Messages reads as part of the site rather than its own app.
 * Messages cannot be deleted.
 */

import { createRichComposer, renderRichMessage } from '../../chat/rich-text.js';
import { createLiveBackend } from './live.js';
import { ChatConnection } from './realtime.js';

const POLL_MS = 4000;
const MAX_ATTACHMENT_BYTES = 1048576;

const el = (id) => document.getElementById(id);

const state = {
  backend: null,
  me: null,
  active: null,
  messages: null,
  inbox: [],
  drafts: new Map(),
  generation: 0,
  search: 0,
  messageRequest: 0,
  inboxRequest: 0,
  sending: false,
  polling: null,
  loading: false,
  lastRead: null,
};

let connection = null;
let searchTimer = null;
let typingTimer = null;
let peerTypingTimer = null;

/* -- small helpers ---------------------------------------------------- */

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function setStatus(text, tone) {
  el('dmStatus').textContent = text;
  el('dmStatusPill').classList.remove('is-live', 'is-preview', 'is-error');
  if (tone) el('dmStatusPill').classList.add(tone);
}

function showNote(text) {
  el('dmNoteText').textContent = text;
  el('dmNote').hidden = false;
}

function showError(error) {
  // A session can expire mid-use; that is the signed-out state, not an error
  // to display over a page that no longer works.
  if (error.status === 401) { requireSignIn(); return; }
  el('dmError').textContent = error.message;
  el('dmError').hidden = false;
}

function clearError() {
  el('dmError').hidden = true;
}

function atBottom() {
  const log = el('dmMessages');
  return log.scrollHeight - log.scrollTop - log.clientHeight < 60;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

function dayLabel(date) {
  const diff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const formatTime = (date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function initialsFor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Same deterministic tint the group chat uses, so one person keeps one color.
function tintFor(name) {
  const text = String(name || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return `tint-${(hash % 5) + 1}`;
}

/* -- composer --------------------------------------------------------- */

const composer = createRichComposer({
  placeholder: 'Write a message…',
  maxLength: 4000,
  lists: false,
  onSubmit: () => submitMessage(),
  onInput: () => {
    if (state.active) state.drafts.set(state.active.id, composer.getHTML());
    if (!state.backend) return;
    if (!typingTimer) connection?.send('typingStart');
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typingTimer = null;
      connection?.send('typingStop');
    }, 1200);
  },
});

function setComposerEnabled(enabled) {
  composer.setEnabled(enabled);
  el('dmSend').disabled = !enabled;
}

// The composer tracks its own empty/placeholder state off `input` events, so
// writing a saved draft straight into the editor has to announce itself.
function restoreDraft(html) {
  composer.editor.innerHTML = html || '';
  composer.editor.dispatchEvent(new Event('input', { bubbles: true }));
}

/* -- message log ------------------------------------------------------ */

function emptyLog(title, hint, icon = 'fa-comments') {
  const wrap = node('div', undefined, 'chat-empty');
  const glyph = document.createElement('i');
  glyph.className = `fas ${icon}`;
  glyph.setAttribute('aria-hidden', 'true');
  wrap.append(glyph, node('p', title, 'chat-empty-title'), node('span', hint, 'chat-empty-hint'));
  return wrap;
}

// Rebuilds the whole log. Cheap at DM volumes, and it keeps day separators and
// sender grouping correct when polling replaces history wholesale.
function renderMessages(messages, forceScroll = false) {
  const unchanged = JSON.stringify(messages) === JSON.stringify(state.messages);
  const scroll = forceScroll || atBottom();
  state.messages = messages;

  if (!unchanged) {
    const log = el('dmMessages');
    if (!messages.length) {
      log.replaceChildren(emptyLog(
        'No messages yet',
        `Say hello to ${state.active.peer.name}. Only the two of you can read this.`,
        'fa-comment-dots',
      ));
    } else {
      const rows = [];
      let lastDayKey = null;
      let lastSender = null;
      let lastTime = 0;

      messages.forEach((message) => {
        const mine = message.uid === state.me.uid;
        const who = mine ? 'You' : (message.name || state.active.peer.name);
        const when = parseDate(message.date);

        let continued;
        if (when) {
          const key = String(startOfDay(when));
          if (key !== lastDayKey) {
            const separator = node('div', dayLabel(when), 'chat-day');
            separator.setAttribute('role', 'separator');
            rows.push(separator);
            lastDayKey = key;
            lastSender = null;
          }
          continued = who === lastSender && (when.getTime() - lastTime) < 5 * 60 * 1000;
          lastTime = when.getTime();
        } else {
          continued = who === lastSender;
        }

        const row = node('div', undefined, ['chat-msg', mine ? 'is-self' : '', continued ? 'is-continued' : '']
          .filter(Boolean).join(' '));

        const avatar = node('span', initialsFor(who), ['chat-avatar', mine ? '' : tintFor(who)].filter(Boolean).join(' '));
        avatar.setAttribute('aria-hidden', 'true');

        const main = node('div', undefined, 'chat-msg-main');
        const meta = node('div', undefined, 'chat-msg-meta');
        meta.append(node('span', who, 'chat-msg-sender'));
        if (when) {
          const time = node('time', formatTime(when), 'chat-msg-time');
          time.dateTime = message.date;
          meta.append(time);
        }

        const body = node('span', undefined, 'chat-msg-body');
        renderRichMessage(body, message.message);

        main.append(meta, body);
        row.append(avatar, main);
        rows.push(row);
        lastSender = who;
      });

      log.replaceChildren(...rows);
    }
  }

  if (scroll) el('dmMessages').scrollTop = el('dmMessages').scrollHeight;
  markRead().catch(showError);
}

async function refreshMessages(forceScroll = false) {
  const active = state.active;
  if (!active) return;
  const version = ++state.messageRequest;
  const generation = state.generation;
  const messages = await state.backend.history(active.id);
  if (version !== state.messageRequest || generation !== state.generation) return;
  if (state.active?.id !== active.id) return;
  renderMessages(messages, forceScroll);
}

async function markRead() {
  const conversation = state.active;
  const message = state.messages?.at(-1);
  if (!conversation || !message) return;
  if (document.hidden || !document.hasFocus() || !atBottom()) return;
  const key = `${conversation.id}:${message.id}`;
  if (state.lastRead === key) return;
  state.lastRead = key;
  await state.backend.read(conversation.id, message.id);
  if (state.active?.id !== conversation.id) return;
  await refreshInbox();
}

/* -- inbox and search -------------------------------------------------- */

function renderInbox() {
  const total = state.inbox.reduce((sum, item) => sum + item.unreadCount, 0);
  el('dmUnread').textContent = total ? String(total) : '';
  el('dmUnread').hidden = !total;
  document.title = `${total ? `(${total}) ` : ''}Messages`;

  if (!state.inbox.length) {
    el('dmInbox').replaceChildren(node('p', 'No conversations yet. Search for someone above.', 'dm-hint'));
    return;
  }

  el('dmInbox').replaceChildren(...state.inbox.map((conversation) => {
    const button = node('button', undefined, 'dm-inbox-item');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(conversation.id === state.active?.id));

    const avatar = node('span', initialsFor(conversation.peer.name), `chat-avatar ${tintFor(conversation.peer.name)}`);
    avatar.setAttribute('aria-hidden', 'true');

    const body = node('span', undefined, 'dm-inbox-body');
    const top = node('span', undefined, 'dm-inbox-top');
    top.append(node('span', conversation.peer.name, 'dm-inbox-name'));
    if (conversation.unreadCount) top.append(node('span', String(conversation.unreadCount), 'dm-badge'));
    // Message bodies are rich text; the inbox wants a one-line plain summary.
    const preview = node('span', undefined, 'dm-inbox-preview');
    if (conversation.lastMessage?.message) {
      const holder = document.createElement('div');
      renderRichMessage(holder, conversation.lastMessage.message);
      preview.textContent = holder.textContent.trim() || 'Attachment';
    } else {
      preview.textContent = 'Say hello';
    }
    body.append(top, node('span', `@${conversation.peer.uid}`, 'dm-inbox-uid'), preview);

    button.append(avatar, body);
    button.addEventListener('click', () => select(conversation).catch(showError));
    return button;
  }));
}

async function refreshInbox() {
  const version = ++state.inboxRequest;
  const generation = state.generation;
  const inbox = await state.backend.inbox();
  if (version !== state.inboxRequest || generation !== state.generation) return;
  state.inbox = inbox;
  renderInbox();
}

async function openWith(person, button) {
  button.disabled = true;
  try {
    const conversation = await state.backend.open(person.id);
    el('dmSearch').value = '';
    el('dmResults').replaceChildren();
    el('dmSearchStatus').textContent = 'Type at least two characters to find someone.';
    await select(conversation);
    await refreshInbox();
  } catch (error) {
    showError(error);
    button.disabled = false;
  }
}

async function searchPeople() {
  const query = el('dmSearch').value.trim();
  const version = ++state.search;
  el('dmResults').replaceChildren();
  if (query.length < 2) {
    el('dmSearchStatus').textContent = 'Type at least two characters to find someone.';
    return;
  }
  el('dmSearchStatus').textContent = 'Looking for people…';
  try {
    const people = await state.backend.search(query);
    if (version !== state.search) return;
    el('dmSearchStatus').textContent = people.length
      ? 'Choose a person to open your conversation.'
      : 'No people found. Try their username.';
    el('dmResults').replaceChildren(...people.map((person) => {
      const button = node('button', undefined, 'dm-person');
      button.type = 'button';
      const avatar = node('span', initialsFor(person.name), `chat-avatar ${tintFor(person.name)}`);
      avatar.setAttribute('aria-hidden', 'true');
      const body = node('span', undefined, 'dm-inbox-body');
      body.append(node('span', person.name, 'dm-inbox-name'), node('span', `@${person.uid}`, 'dm-inbox-uid'));
      button.append(avatar, body);
      button.addEventListener('click', () => openWith(person, button));
      return button;
    }));
  } catch (error) {
    if (version === state.search) showError(error);
  }
}

/* -- attachments (backend mode only) ---------------------------------- */

async function refreshFiles() {
  const active = state.active;
  if (!active || !state.backend) return;
  const generation = state.generation;
  const files = await state.backend.files(active.id);
  if (generation !== state.generation || state.active?.id !== active.id) return;
  el('dmFiles').replaceChildren(...files.map((file) => {
    const button = node('button', file.filename, 'dm-file');
    button.type = 'button';
    button.addEventListener('click', () => {
      const bytes = Uint8Array.from(atob(file.base64Data), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const link = node('a');
      link.href = url;
      link.download = file.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    return button;
  }));
}

/* -- conversation selection ------------------------------------------- */

async function select(conversation) {
  if (state.active?.id === conversation.id) return;
  if (state.active) state.drafts.set(state.active.id, composer.getHTML());
  connection?.send('typingStop');

  state.active = conversation;
  state.generation += 1;
  state.messages = null;
  state.lastRead = null;
  clearError();

  el('dmChatTitle').textContent = conversation.peer.name;
  el('dmChatSubtitle').textContent = `@${conversation.peer.uid} · private conversation`;
  const badge = el('dmPeerAvatar');
  badge.textContent = initialsFor(conversation.peer.name);
  badge.classList.add('dm-peer-badge');
  el('dmTyping').textContent = '';
  el('dmMessages').replaceChildren(emptyLog('Loading conversation…', 'One moment.', 'fa-spinner'));

  restoreDraft(state.drafts.get(conversation.id));
  setComposerEnabled(true);

  el('dmAttachments').hidden = false;
  el('dmFiles').replaceChildren();
  connection?.select(conversation.id);
  renderInbox();

  await refreshMessages(true);
  await refreshFiles().catch(showError);
  composer.focus();
}

/* -- sending ----------------------------------------------------------- */

async function submitMessage() {
  const active = state.active;
  if (!active || state.sending) return;
  if (composer.isEmpty() || composer.isOverLimit()) return;

  const html = composer.getHTML();
  state.sending = true;
  el('dmSend').disabled = true;
  clearError();
  try {
    await state.backend.send(active.id, html);
    // Only clear the box if the reader hasn't typed something new meanwhile;
    // a failed send must never lose a draft.
    if (state.active?.id === active.id && composer.getHTML() === html) composer.clear();
    state.drafts.delete(active.id);
    connection?.send('typingStop');
    if (state.active?.id === active.id) await refreshMessages(true);
    await refreshInbox();
  } catch (error) {
    showError(error);
  } finally {
    state.sending = false;
    el('dmSend').disabled = !state.active;
  }
}

/* -- polling ----------------------------------------------------------- */

async function poll() {
  if (!state.backend || state.loading) return;
  state.loading = true;
  try {
    await Promise.all([refreshInbox(), refreshMessages()]);
  } catch (error) {
    showError(error);
  } finally {
    state.loading = false;
  }
}

/* -- blocked states ----------------------------------------------------- */

// Messages are only ever stored and delivered by the backend, so there is no
// offline or signed-out mode: when the page cannot reach an account, it says
// why and stays inert rather than pretending to work.
function blockAccess(title, hint, detail) {
  state.backend = null;
  state.me = null;
  state.active = null;
  state.messages = null;
  state.inbox = [];
  state.generation += 1;
  clearInterval(state.polling);

  el('dmAccount').textContent = '';
  el('dmSearch').disabled = true;
  el('dmSearch').value = '';
  el('dmResults').replaceChildren();
  el('dmSearchStatus').textContent = 'Sign in to find people.';
  el('dmInbox').replaceChildren(node('p', hint, 'dm-hint'));
  el('dmUnread').hidden = true;
  el('dmAttachments').hidden = true;
  el('dmChatTitle').textContent = title;
  el('dmChatSubtitle').textContent = detail;
  // Back to an icon, not the empty box that clearing the initials would leave.
  const badge = el('dmPeerAvatar');
  badge.classList.remove('dm-peer-badge');
  const lock = document.createElement('i');
  lock.className = 'fas fa-lock';
  lock.setAttribute('aria-hidden', 'true');
  badge.replaceChildren(lock);
  el('dmMessages').replaceChildren(emptyLog(title, detail, 'fa-lock'));
  composer.clear();
  setComposerEnabled(false);
  document.title = 'Messages';
}

function requireSignIn() {
  setStatus('signed out', 'is-preview');
  el('dmSignIn').hidden = false;
  blockAccess(
    'Sign in to use Messages',
    'Sign in to see your conversations.',
    'Conversations are private between two accounts, so Messages needs you signed in.',
  );
}

function serviceUnavailable() {
  setStatus('unavailable', 'is-error');
  showNote('Messages cannot reach the server right now. Your conversations are safe; try again in a moment.');
  blockAccess(
    'Messages is unavailable',
    'Conversations will appear once the server is reachable.',
    'The messages service is not responding.',
  );
}

/* -- live mode --------------------------------------------------------- */

function handleRealtimeEvent(event) {
  if (event.groupId && event.groupId !== state.active?.id) return;
  // A reconnect carries no group and still has to refresh the inbox, so only
  // the conversation-scoped branches require an open conversation.
  if (event.context === 'typingStartServer' && state.active && event.sender !== state.me?.uid) {
    el('dmTyping').textContent = `${state.active.peer.name} is typing…`;
    clearTimeout(peerTypingTimer);
    peerTypingTimer = setTimeout(() => { el('dmTyping').textContent = ''; }, 2500);
  } else if (event.context === 'typingStopServer') {
    el('dmTyping').textContent = '';
  } else if (event.context === 'sendFileServer') {
    refreshFiles().catch(showError);
  } else if (['sendMessageServer', 'deleteMessageServer', 'reconnected'].includes(event.context)) {
    poll();
  }
}

async function start() {
  setStatus('loading…');
  const live = createLiveBackend();

  let me;
  try {
    me = await live.me();
  } catch (error) {
    // 401 is the ordinary signed-out case, not a fault; anything else means the
    // service is down. Neither leaves the page usable.
    if (error.status === 401) requireSignIn(); else serviceUnavailable();
    return;
  }

  state.backend = live;
  state.me = me;
  setStatus('connected', 'is-live');
  el('dmAccount').textContent = `Signed in as ${me.name}`;
  el('dmSearch').disabled = false;

  connection = new ChatConnection(handleRealtimeEvent, (status) => setStatus(status, 'is-live'));
  connection.connect();

  try {
    await refreshInbox();
  } catch (error) {
    showError(error);
  }

  clearInterval(state.polling);
  state.polling = setInterval(poll, POLL_MS);
}

/* -- wiring ------------------------------------------------------------ */

const form = el('dmForm');
form.insertBefore(composer.element, el('dmSend'));
form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitMessage();
});

el('dmSearch').addEventListener('input', () => {
  state.search += 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchPeople, 250);
});

el('dmFile').addEventListener('change', async () => {
  const file = el('dmFile').files[0];
  const active = state.active;
  if (!file || !active) return;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    showError(new Error('Attachments must be at most 1 MB.'));
    el('dmFile').value = '';
    return;
  }
  el('dmFile').disabled = true;
  try {
    await state.backend.upload(active.id, file);
    await refreshFiles();
  } catch (error) {
    showError(error);
  } finally {
    el('dmFile').disabled = false;
    el('dmFile').value = '';
  }
});

el('dmMessages').addEventListener('scroll', () => markRead().catch(showError));
window.addEventListener('focus', poll);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.addEventListener('pagehide', () => {
  clearInterval(state.polling);
  connection?.stop();
});

setComposerEnabled(false);
start();
