/*
 * Shared rich-text layer for the course chat widgets
 * (announcement_chat.html, week_chat.html, lesson_chat.html).
 *
 * Exports:
 *
 *   createRichComposer(opts) -> a WYSIWYG input (toolbar + contenteditable)
 *       that replaces the old single-line <input class="chat-input">. It
 *       produces a small, fixed subset of HTML: <b> <i> <u> <s>, <ul>/<ol>/<li>,
 *       <br>, and <span class="rt-font-*|rt-size-*"> for font family / size.
 *       Its "+" button stages one attachment (image / GIF / video / file);
 *       getAttachment() hands it back as a data URI for the message's `image`
 *       field (the same field the groups chat uses).
 *
 *   renderRichMessage(container, raw, image) -> parses a stored message, keeps
 *       only that subset (incl. a leading <blockquote> reply quote), turns bare
 *       URLs into links, appends it, then appends any attachment from `image`.
 *       Every message (history from S3, live from the socket, local preview)
 *       goes through here, so this is the trust boundary — never assume safe.
 *
 *   createMessageActions(container, opts) -> the Discord-style hover toolbar on
 *       other people's messages: Add reaction (local-only for now), Reply
 *       (fills the composer's reply bar), Copy. Gated on setSignedIn(true).
 *
 * Plain-text messages sent before this shipped still render correctly: the
 * sanitizer passes text through untouched and the widgets keep `white-space:
 * pre-wrap`, so their newlines survive.
 */

const MAX_LENGTH_DEFAULT = 2000;

const URL_RE = /https?:\/\/[^\s<>()]+/g;

// One staged attachment per message. Caps are on the raw file; the base64 in
// transit and in the S3 JSONL is ~1.35x that.
const ATTACHMENT_LIMITS = { image: 6 * 1024 * 1024, video: 20 * 1024 * 1024, file: 10 * 1024 * 1024 };
// Above this base64 length a received attachment is shown as a stub, not decoded.
const ATTACHMENT_RENDER_CAP = 32 * 1024 * 1024;
// Never upload or render these as media — they can carry script.
const ATTACHMENT_MIME_DENY = /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)$/i;

// Zero-width space + BOM: some browsers seed an empty contenteditable with one
// and paste can carry them in. They must never count as content or reach a
// stored message, so strip them on the way through the sanitiser and in the
// composer's own length / empty checks.
const INVISIBLE_RE = /[​﻿]/g;

// The only inline tags a message may contain. Anything else is unwrapped
// (its text is kept, the tag is dropped).
const INLINE_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE']);
const LIST_TAGS = new Set(['UL', 'OL', 'LI']);
// Elements whose *contents* are code / not display text — dropped whole.
const DROP_WHOLE = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'HEAD', 'TITLE']);

// span classes the composer emits; nothing else is allowed to ride on a span.
const SPAN_CLASS_RE = /^rt-(?:font-(?:serif|mono)|size-(?:sm|lg|xl))$/;

const FONT_OPTIONS = [
  { label: 'Sans-serif', value: '' },
  { label: 'Serif', value: 'rt-font-serif' },
  { label: 'Monospace', value: 'rt-font-mono' },
];

const SIZE_OPTIONS = [
  { label: 'Small', value: 'rt-size-sm' },
  { label: 'Normal', value: '' },
  { label: 'Large', value: 'rt-size-lg' },
  { label: 'Huge', value: 'rt-size-xl' },
];

const EMOJI = [
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
  '😉', '😊', '😇', '😍', '🤩', '😘', '😋', '😜', '🤪', '🤨',
  '🧐', '🤓', '😎', '🥳', '😏', '😒', '😞', '😔', '😢', '😭',
  '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '🤔',
  '🤗', '🤭', '🤫', '😴', '😌', '😬', '🙄', '😲', '🥺', '😪',
  '👍', '👎', '👏', '🙌', '👌', '🤝', '🙏', '💪', '🫶', '✌️',
  '👀', '🔥', '✨', '🎉', '🎊', '✅', '❌', '❓', '❗', '💡',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💯', '⭐', '🌟',
  '🚀', '🐛', '☕', '🍕', '🎯', '📌', '📝', '💻', '⏰', '👋',
];

/* ------------------------------------------------------------------ *
 * Sanitiser / renderer
 * ------------------------------------------------------------------ */

function linkifyText(text, insideAnchor) {
  const frag = document.createDocumentFragment();
  const value = String(text).replace(INVISIBLE_RE, '');
  if (insideAnchor) {
    frag.appendChild(document.createTextNode(value));
    return frag;
  }
  const re = new RegExp(URL_RE.source, 'g');
  let lastIndex = 0;
  let match;
  while ((match = re.exec(value)) !== null) {
    if (match.index > lastIndex) {
      frag.appendChild(document.createTextNode(value.slice(lastIndex, match.index)));
    }
    const a = document.createElement('a');
    a.href = match[0];
    a.textContent = match[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.appendChild(a);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length || !frag.childNodes.length) {
    frag.appendChild(document.createTextNode(value.slice(lastIndex)));
  }
  return frag;
}

// contenteditable in some browsers renders a decoration as an inline style
// instead of a tag; map those back so the sanitiser keeps the formatting.
function styleTag(node) {
  const style = node.getAttribute('style') || '';
  if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) return 'b';
  if (/font-style\s*:\s*italic/i.test(style)) return 'i';
  if (/text-decoration[^;]*underline/i.test(style)) return 'u';
  if (/text-decoration[^;]*line-through/i.test(style)) return 's';
  return null;
}

function safeHref(raw) {
  const href = String(raw || '').trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

// True unless the element is empty or holds nothing but empty text nodes —
// used to discard the leftover carrier spans the composer parks the caret in.
function hasContent(el) {
  if (el.querySelector('br, li')) return true;
  return el.textContent.replace(INVISIBLE_RE, '').length > 0;
}

function cleanChildren(source, target, insideAnchor) {
  source.childNodes.forEach((child) => {
    target.appendChild(cleanNode(child, insideAnchor));
  });
}

function cleanNode(node, insideAnchor) {
  if (node.nodeType === Node.TEXT_NODE) {
    return linkifyText(node.nodeValue, insideAnchor);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return document.createDocumentFragment();
  }

  const tag = node.tagName;

  if (DROP_WHOLE.has(tag)) return document.createDocumentFragment();

  if (tag === 'BR') return document.createElement('br');

  // Block containers a browser's contenteditable leaves behind: keep the
  // text, and start a new line if anything came before.
  if (tag === 'DIV' || tag === 'P') {
    const frag = document.createDocumentFragment();
    if (node.previousSibling) frag.appendChild(document.createElement('br'));
    cleanChildren(node, frag, insideAnchor);
    return frag;
  }

  if (INLINE_TAGS.has(tag)) {
    const el = document.createElement(tag.toLowerCase());
    cleanChildren(node, el, insideAnchor);
    return hasContent(el) ? el : document.createDocumentFragment();
  }

  if (LIST_TAGS.has(tag)) {
    const el = document.createElement(tag.toLowerCase());
    cleanChildren(node, el, insideAnchor);
    // contenteditable pads an empty/just-typed <li> with a trailing <br>
    if (tag === 'LI' && el.lastChild && el.lastChild.nodeName === 'BR') el.removeChild(el.lastChild);
    return el;
  }

  // The reply quote a message can carry: <blockquote><b>Sender</b> snippet…</blockquote>
  if (tag === 'BLOCKQUOTE') {
    const el = document.createElement('blockquote');
    cleanChildren(node, el, insideAnchor);
    return hasContent(el) ? el : document.createDocumentFragment();
  }

  if (tag === 'SPAN' || tag === 'FONT') {
    const kept = tag === 'SPAN'
      ? Array.from(node.classList).filter((c) => SPAN_CLASS_RE.test(c))
      : [];
    const decoration = styleTag(node);
    if (!kept.length && !decoration) {
      const frag = document.createDocumentFragment();
      cleanChildren(node, frag, insideAnchor);
      return frag;
    }
    const el = document.createElement(kept.length ? 'span' : decoration);
    if (kept.length) el.className = kept.join(' ');
    cleanChildren(node, el, insideAnchor);
    if (!hasContent(el)) return document.createDocumentFragment();
    if (kept.length && decoration) {
      const outer = document.createElement(decoration);
      outer.appendChild(el);
      return outer;
    }
    return el;
  }

  if (tag === 'A') {
    const href = safeHref(node.getAttribute('href'));
    if (!href) {
      const frag = document.createDocumentFragment();
      cleanChildren(node, frag, true);
      return frag;
    }
    const el = document.createElement('a');
    el.href = href;
    el.target = '_blank';
    el.rel = 'noopener noreferrer';
    cleanChildren(node, el, true);
    return el;
  }

  // Unknown element: drop the tag, keep its contents.
  const frag = document.createDocumentFragment();
  cleanChildren(node, frag, insideAnchor);
  return frag;
}

function sanitizeToFragment(raw) {
  const doc = new DOMParser().parseFromString(String(raw ?? ''), 'text/html');
  const frag = document.createDocumentFragment();
  cleanChildren(doc.body, frag, false);
  while (frag.lastChild && frag.lastChild.nodeName === 'BR') frag.removeChild(frag.lastChild);
  return frag;
}

export function sanitizeRichText(raw) {
  const holder = document.createElement('div');
  holder.appendChild(sanitizeToFragment(raw));
  return holder.innerHTML;
}

export function renderRichMessage(container, raw, image) {
  container.appendChild(sanitizeToFragment(raw));
  renderAttachment(container, image);
}

/* ------------------------------------------------------------------ *
 * Attachments
 *
 * An attachment rides in the message's separate `image` field (the field the
 * backend already persists and re-broadcasts) as a data URI:
 *   data:<mime>;name=<uri-encoded filename>;base64,<data>
 * Bare base64 and http(s) URLs are also read, since the groups chat writes
 * plain base64 / URLs into the same field.
 * ------------------------------------------------------------------ */

function attachmentKind(mime, name) {
  if (ATTACHMENT_MIME_DENY.test(mime || '')) return 'file';
  if (/^image\//i.test(mime)) return 'image';
  if (/^video\//i.test(mime)) return 'video';
  if (!mime && /\.(?:mp4|webm|ogg|mov|m4v)$/i.test(name || '')) return 'video';
  if (!mime && /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(name || '')) return 'image';
  return 'file';
}

function base64Bytes(b64) {
  return Math.floor(String(b64).replace(/=+$/, '').replace(/\s/g, '').length * 3 / 4);
}

function humanSize(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function parseAttachment(image) {
  const raw = typeof image === 'string' ? image.trim() : '';
  if (!raw) return null;

  const m = /^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*)((?:;[a-z0-9-]+=[^;,]+)*);base64,([a-z0-9+/=\s]+)$/i.exec(raw);
  if (m) {
    const mime = m[1].toLowerCase();
    const nameParam = /;name=([^;,]+)/i.exec(m[2] || '');
    let name = '';
    if (nameParam) { try { name = decodeURIComponent(nameParam[1]); } catch (_) { name = nameParam[1]; } }
    const base64 = m[3].replace(/\s/g, '');
    const oversize = base64.length > ATTACHMENT_RENDER_CAP;
    return {
      kind: oversize ? 'toobig' : attachmentKind(mime, name),
      mime, name, base64: oversize ? '' : base64,
      src: oversize ? '' : `data:${mime};base64,${base64}`,
      bytes: base64Bytes(base64),
    };
  }
  if (/^https?:\/\/\S+$/i.test(raw)) {
    return { kind: attachmentKind('', raw), mime: '', name: '', base64: '', src: raw, bytes: 0 };
  }
  if (/^[a-z0-9+/=\s]+$/i.test(raw) && raw.replace(/\s/g, '').length > 64) {
    const base64 = raw.replace(/\s/g, '');
    if (base64.length > ATTACHMENT_RENDER_CAP) return { kind: 'toobig', mime: '', name: '', base64: '', src: '', bytes: 0 };
    return { kind: 'image', mime: 'image/png', name: '', base64, src: `data:image/png;base64,${base64}`, bytes: base64Bytes(base64) };
  }
  return null;
}

const RT_FILE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" '
  + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M18 21H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8l5 5v12a1 1 0 0 1-1 1z"/></svg>';

function downloadAttachment(att) {
  if (!att.base64) return;
  try {
    const bytes = Uint8Array.from(atob(att.base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: att.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = att.name || 'attachment';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (_) { /* ignore */ }
}

function buildAttachmentNode(att) {
  if (att.kind === 'toobig') {
    const p = document.createElement('p');
    p.className = 'rt-att rt-att-error';
    p.textContent = 'Attachment is too large to display.';
    return p;
  }
  if (att.kind === 'image' && att.src) {
    const fig = document.createElement('figure');
    fig.className = 'rt-att rt-att-image';
    const img = document.createElement('img');
    img.src = att.src;
    img.alt = att.name || 'image attachment';
    img.loading = 'lazy';
    fig.appendChild(img);
    return fig;
  }
  if (att.kind === 'video' && att.src) {
    const v = document.createElement('video');
    v.className = 'rt-att rt-att-video';
    v.src = att.src;
    v.controls = true;
    v.preload = 'metadata';
    return v;
  }
  // file — a download chip. Never a live data: link (a data:text/html href is a
  // navigation hazard); the blob download is built on click instead.
  const chip = document.createElement(att.base64 ? 'button' : 'span');
  chip.className = 'rt-att rt-att-file';
  if (att.base64) chip.type = 'button';
  chip.innerHTML = RT_FILE_ICON;
  const meta = document.createElement('span');
  meta.className = 'rt-att-file-meta';
  const nameEl = document.createElement('span');
  nameEl.className = 'rt-att-file-name';
  nameEl.textContent = att.name || (att.src ? 'attachment' : 'unavailable');
  meta.appendChild(nameEl);
  if (att.bytes) {
    const sizeEl = document.createElement('span');
    sizeEl.className = 'rt-att-file-size';
    sizeEl.textContent = humanSize(att.bytes);
    meta.appendChild(sizeEl);
  }
  chip.appendChild(meta);
  if (att.base64) {
    chip.title = `Download ${att.name || 'attachment'}`;
    chip.addEventListener('click', () => downloadAttachment(att));
  }
  return chip;
}

export function renderAttachment(container, image) {
  const att = parseAttachment(image);
  if (att) container.appendChild(buildAttachmentNode(att));
  return !!att;
}

/* ------------------------------------------------------------------ *
 * Shared popover helpers (emoji grid + fixed positioning)
 * ------------------------------------------------------------------ */

// Place a fixed-position popover next to an anchor rect: above it if there's
// room, otherwise below, and always inside the viewport.
function positionPopover(el, anchorRect) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const w = el.offsetWidth || 260;
  const h = el.offsetHeight || 240;
  el.style.left = `${Math.max(8, Math.min(anchorRect.left, vw - w - 8))}px`;
  el.style.top = anchorRect.top > h + 12
    ? `${anchorRect.top - h - 6}px`
    : `${Math.min(anchorRect.bottom + 6, vh - h - 8)}px`;
}

function fillEmojiGrid(container, onPick) {
  EMOJI.forEach((emoji) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rt-emoji';
    b.textContent = emoji;
    b.setAttribute('aria-label', emoji);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => onPick(emoji));
    container.appendChild(b);
  });
}

/* ------------------------------------------------------------------ *
 * Message actions — Discord-style hover toolbar (react / reply / copy)
 *
 * Reactions are stored per-widget in localStorage and are *local to this
 * browser* — there is no backend reaction field yet, so they aren't shared.
 * Reply and Copy are fully client-side too (Reply prepends a <blockquote>
 * to the outgoing message).
 * ------------------------------------------------------------------ */

const RTA_REACT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/></svg>';
const RTA_REPLY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
const RTA_COPY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';

function readJSON(key) {
  try { return JSON.parse(window.localStorage.getItem(key) || '{}') || {}; }
  catch (_) { return {}; }
}

export function createMessageActions(container, opts = {}) {
  const storageKey = opts.storageKey || 'ocs-chat-reactions';
  const onReply = typeof opts.onReply === 'function' ? opts.onReply : () => {};
  const store = readJSON(storageKey);
  let signedIn = false;
  let picker = null;
  let pickerTarget = null;

  container.classList.add('has-msg-actions');

  function persist() {
    try { window.localStorage.setItem(storageKey, JSON.stringify(store)); } catch (_) { /* quota */ }
  }

  function bodyText(msgEl) {
    const body = msgEl.querySelector('.chat-msg-body');
    return (body ? body.textContent : msgEl.textContent || '').trim();
  }

  // Reactions sit under the message text — that's inside .chat-msg-main where a
  // widget has an avatar gutter (announcements), otherwise the message itself.
  function reactionHost(msgEl) {
    return msgEl.querySelector('.chat-msg-main') || msgEl;
  }

  function renderReactions(msgEl) {
    const key = msgEl.dataset.msgKey || '';
    const map = store[key] || {};
    const emojis = Object.keys(map).filter((e) => map[e] > 0);
    const host = reactionHost(msgEl);
    let bar = host.querySelector(':scope > .chat-reactions');
    if (!emojis.length) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'chat-reactions';
      host.appendChild(bar);
    }
    bar.textContent = '';
    emojis.forEach((emoji) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'chat-reaction is-mine';
      pill.title = `You reacted with ${emoji} · click to remove`;
      const g = document.createElement('span');
      g.className = 'chat-reaction-emoji';
      g.textContent = emoji;
      const n = document.createElement('span');
      n.className = 'chat-reaction-count';
      n.textContent = String(map[emoji]);
      pill.append(g, n);
      pill.addEventListener('click', () => toggleReaction(msgEl, emoji));
      bar.appendChild(pill);
    });
  }

  function toggleReaction(msgEl, emoji) {
    const key = msgEl.dataset.msgKey;
    if (!key) return;
    const map = store[key] || (store[key] = {});
    if (map[emoji]) {
      delete map[emoji];
      if (!Object.keys(map).length) delete store[key];
    } else {
      map[emoji] = 1;
    }
    persist();
    renderReactions(msgEl);
  }

  function closePicker() {
    if (picker && picker.isConnected) picker.remove();
    pickerTarget = null;
  }

  function openPicker(anchorEl, msgEl) {
    if (!picker) {
      picker = document.createElement('div');
      picker.className = 'rt-emoji-panel chat-reaction-picker';
      fillEmojiGrid(picker, (emoji) => {
        if (pickerTarget) toggleReaction(pickerTarget, emoji);
        closePicker();
      });
      document.addEventListener('click', (e) => {
        if (picker && picker.isConnected
          && !picker.contains(e.target)
          && !(e.target.closest && e.target.closest('.chat-msg-action-react'))) closePicker();
      });
      window.addEventListener('scroll', (e) => {
        if (picker && picker.isConnected && e.target !== picker) closePicker();
      }, true);
    }
    pickerTarget = msgEl;
    document.body.appendChild(picker);
    positionPopover(picker, anchorEl.getBoundingClientRect());
  }

  function actionButton(cls, icon, label, handler) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chat-msg-action ${cls}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = icon;
    b.addEventListener('click', (e) => { e.stopPropagation(); handler(b); });
    return b;
  }

  function flash(btn, text) {
    const prev = btn.getAttribute('aria-label');
    btn.classList.add('is-done');
    btn.title = text;
    setTimeout(() => { btn.classList.remove('is-done'); btn.title = prev; }, 1200);
  }

  function decorate(msgEl) {
    if (!msgEl || msgEl.dataset.maDecorated) return;
    msgEl.dataset.maDecorated = '1';
    renderReactions(msgEl);
    if (!signedIn || msgEl.dataset.msgSelf === '1') return;

    const bar = document.createElement('div');
    bar.className = 'chat-msg-actions';
    bar.append(
      actionButton('chat-msg-action-react', RTA_REACT, 'Add reaction', (btn) => openPicker(btn, msgEl)),
      actionButton('chat-msg-action-reply', RTA_REPLY, 'Reply', () => {
        onReply({ sender: msgEl.dataset.msgSender || 'Someone', text: bodyText(msgEl) });
      }),
      actionButton('chat-msg-action-copy', RTA_COPY, 'Copy message', (btn) => {
        const text = bodyText(msgEl);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => flash(btn, 'Copied')).catch(() => {});
        }
      }),
    );
    msgEl.appendChild(bar);
    msgEl.classList.add('has-actions');
  }

  function setSignedIn(value) {
    signedIn = !!value;
    container.classList.toggle('can-act', signedIn);
  }

  return { decorate, setSignedIn, closePicker };
}

/* ------------------------------------------------------------------ *
 * Composer
 * ------------------------------------------------------------------ */

function stripGroupSpans(root, prefix) {
  root.querySelectorAll('span[class]').forEach((span) => {
    const remaining = Array.from(span.classList).filter((c) => !c.startsWith(prefix));
    if (remaining.length === Array.from(span.classList).length) return;
    if (remaining.length) {
      span.className = remaining.join(' ');
    } else {
      span.replaceWith(...span.childNodes);
    }
  });
}

export function createRichComposer(opts = {}) {
  const {
    placeholder = 'Write a message…',
    maxLength = MAX_LENGTH_DEFAULT,
    onSubmit = () => {},
    onInput = () => {},
    // Bulleted/numbered list buttons. Useful in the class chats, where people
    // post structured announcements; noise in a one-to-one conversation.
    lists = true,
  } = opts;

  const root = document.createElement('div');
  root.className = 'rt-composer';

  const toolbar = document.createElement('div');
  toolbar.className = 'rt-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Formatting');

  const editor = document.createElement('div');
  editor.className = 'rt-editor';
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', placeholder);
  editor.dataset.placeholder = placeholder;

  // The emoji panel and the attach menu are fixed-position popovers attached to
  // <body> only while open — the chat widgets clip their overflow.
  const emojiPanel = document.createElement('div');
  emojiPanel.className = 'rt-emoji-panel';
  const attachMenu = document.createElement('div');
  attachMenu.className = 'rt-attach-menu';

  // "Replying to …" bar above the input, set via setReplyTo() from the hover
  // action on another person's message.
  const replyBar = document.createElement('div');
  replyBar.className = 'rt-reply-bar';
  replyBar.hidden = true;

  // Staged attachment (Discord-style tray above the input), hidden until used.
  const attachTray = document.createElement('div');
  attachTray.className = 'rt-attachments';
  attachTray.hidden = true;

  // "+" button sits at the left of the input, like Discord.
  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'rt-attach';
  attachBtn.title = 'Add an attachment';
  attachBtn.setAttribute('aria-label', 'Add an attachment');
  attachBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  attachBtn.addEventListener('mousedown', (e) => e.preventDefault());
  attachBtn.addEventListener('click', (e) => { e.preventDefault(); toggleAttachMenu(); });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    const mode = fileInput.dataset.mode || 'file';
    fileInput.value = '';
    if (file) stageFile(file, mode);
  });

  const inputRow = document.createElement('div');
  inputRow.className = 'rt-input-row';
  inputRow.append(attachBtn, editor);

  root.append(toolbar, replyBar, attachTray, inputRow, fileInput);

  let replyTo = null;

  function renderReplyBar() {
    replyBar.hidden = !replyTo;
    if (!replyTo) { replyBar.textContent = ''; return; }
    replyBar.textContent = '';
    const label = document.createElement('span');
    label.className = 'rt-reply-label';
    label.textContent = `Replying to ${replyTo.sender}`;
    const snippet = document.createElement('span');
    snippet.className = 'rt-reply-snippet';
    snippet.textContent = replyTo.text.length > 100 ? `${replyTo.text.slice(0, 100)}…` : replyTo.text;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'rt-reply-cancel';
    cancel.title = 'Cancel reply';
    cancel.setAttribute('aria-label', 'Cancel reply');
    cancel.textContent = '×';
    cancel.addEventListener('mousedown', (e) => e.preventDefault());
    cancel.addEventListener('click', () => { replyTo = null; renderReplyBar(); handleChange(); editor.focus(); });
    replyBar.append(label, snippet, cancel);
  }

  /* selection tracking — a <select> or the emoji panel steals focus and
     collapses the editor selection, so remember the last range that was
     actually inside the editor and restore it before applying a style. The
     document-level listener is wired on first focus, not at construction, so
     a page with many collapsed week-card chats doesn't pay for them upfront. */
  let savedRange = null;
  let selectionTracked = false;
  function trackSelection() {
    if (selectionTracked) return;
    selectionTracked = true;
    document.addEventListener('selectionchange', () => {
      const sel = document.getSelection();
      if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
        savedRange = sel.getRangeAt(0).cloneRange();
      }
    });
  }
  editor.addEventListener('focusin', trackSelection);

  function restoreSelection() {
    editor.focus();
    if (!savedRange) return false;
    try {
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
      return true;
    } catch (_) {
      return false;
    }
  }

  /* Sticky font family / size. Picking "Monospace" or "Large" sets the mode
     here; the beforeinput handler then wraps whatever the user types next
     until they pick "Sans-serif" / "Normal" again (or hit Clear formatting).
     A selection that isn't collapsed is still styled in place, one shot. */
  const typingFormat = { 'rt-font-': '', 'rt-size-': '' };
  let suppressSticky = false;

  function stickyClasses() {
    return [typingFormat['rt-font-'], typingFormat['rt-size-']].filter(Boolean);
  }

  const RT_SPAN_SEL = 'span[class*="rt-font-"], span[class*="rt-size-"]';

  // The rt-styled span the caret is directly inside, if its class set is
  // exactly `classes` (so more typing can just flow into it).
  function styledSpanAtCaret(classes) {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const span = node && node.closest ? node.closest('span[class]') : null;
    if (!span || !editor.contains(span)) return null;
    const wanted = classes.slice().sort().join(' ');
    const have = Array.from(span.classList).sort().join(' ');
    return wanted === have ? span : null;
  }

  function caretInRtSpan() {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return false;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    return !!(node && node.closest && editor.contains(node) && node.closest(RT_SPAN_SEL));
  }

  // Step the caret just past the nearest font/size span (splitting it so text
  // after the caret stays put) so a new run lands beside it, not nested inside
  // and inheriting it. Anything else the caret is in — <b>, <li> — is left
  // alone; only the font/size wrapper is escaped.
  function escapeRtSpan(sel) {
    let range = sel.getRangeAt(0);
    let el = range.startContainer;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    const rtSpan = el && el.closest ? el.closest(RT_SPAN_SEL) : null;
    if (!rtSpan || !editor.contains(rtSpan)) return range;

    const tail = document.createRange();
    tail.setStart(range.startContainer, range.startOffset);
    tail.setEnd(rtSpan, rtSpan.childNodes.length);
    const tailFrag = tail.extractContents();

    const next = document.createRange();
    if (tailFrag.textContent.replace(INVISIBLE_RE, '') !== '' || tailFrag.querySelector('br')) {
      const clone = rtSpan.cloneNode(false);
      clone.appendChild(tailFrag);
      rtSpan.parentNode.insertBefore(clone, rtSpan.nextSibling);
      next.setStartBefore(clone);
    } else {
      next.setStartAfter(rtSpan);
    }
    next.collapse(true);
    sel.removeAllRanges();
    sel.addRange(next);
    return next;
  }

  function insertStyledText(text) {
    const classes = stickyClasses();
    if (!restoreSelection()) return false;
    const sel = document.getSelection();
    if (!sel.rangeCount) return false;
    let range = sel.getRangeAt(0);
    range.deleteContents();
    range = escapeRtSpan(sel);

    // Merge into an identical span sitting right before the caret, if any.
    const want = classes.slice().sort().join(' ');
    const prev = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer.childNodes[range.startOffset - 1]
      : null;
    const mergeInto = classes.length && prev && prev.nodeType === Node.ELEMENT_NODE
      && prev.tagName === 'SPAN' && Array.from(prev.classList).sort().join(' ') === want
      ? prev : null;

    let textNode;
    if (mergeInto) {
      textNode = document.createTextNode(text);
      mergeInto.appendChild(textNode);
    } else if (classes.length) {
      const span = document.createElement('span');
      span.className = classes.join(' ');
      textNode = document.createTextNode(text);
      span.appendChild(textNode);
      range.insertNode(span);
    } else {
      textNode = document.createTextNode(text);
      range.insertNode(textNode);
    }
    const after = document.createRange();
    after.setStart(textNode, text.length);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    savedRange = after.cloneRange();
    return true;
  }

  // Empty font/size spans left behind when a run is stepped out of — drop the
  // ones the caret isn't in so they don't accumulate while composing.
  function pruneEmptyRtSpans() {
    const sel = document.getSelection();
    const caretNode = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    editor.querySelectorAll(RT_SPAN_SEL).forEach((span) => {
      if (caretNode && span.contains(caretNode)) return;
      if (!span.querySelector('br') && span.textContent.replace(INVISIBLE_RE, '') === '') span.remove();
    });
  }

  function applyGroupToRange(prefix, className) {
    if (!restoreSelection()) return;
    const sel = document.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;

    const contents = range.extractContents();
    const wrapper = document.createElement('span');
    wrapper.appendChild(contents);
    stripGroupSpans(wrapper, prefix);

    let inserted;
    if (className) {
      wrapper.className = className;
      inserted = wrapper;
    } else {
      inserted = document.createDocumentFragment();
      inserted.append(...wrapper.childNodes);
    }
    const firstChild = inserted.nodeType === Node.ELEMENT_NODE ? inserted : inserted.firstChild;
    const lastChild = inserted.nodeType === Node.ELEMENT_NODE ? inserted : inserted.lastChild;
    range.insertNode(inserted);

    if (firstChild) {
      const next = document.createRange();
      next.setStartBefore(firstChild);
      next.setEndAfter(lastChild || firstChild);
      sel.removeAllRanges();
      sel.addRange(next);
      savedRange = next.cloneRange();
    }
    editor.normalize();
    handleChange();
  }

  function setGroupFormat(prefix, className) {
    typingFormat[prefix] = className;
    restoreSelection();
    const sel = document.getSelection();
    if (sel.rangeCount && !sel.getRangeAt(0).collapsed) {
      applyGroupToRange(prefix, className);
    }
    editor.focus();
    handleChange();
  }

  function exec(command) {
    editor.focus();
    // Emit tags (<b>, <i>…) rather than inline styles, so the sanitiser keeps them.
    try { document.execCommand('styleWithCSS', false, false); } catch (_) { /* ignore */ }
    document.execCommand(command, false, null);
    syncToolbarState();
    handleChange();
  }

  // Insert a literal string (emoji, pasted text) at the caret. Bypasses the
  // sticky font/size wrapping — these are "drop this in", not "type".
  function insertText(text) {
    suppressSticky = true;
    try {
      restoreSelection();
      if (!document.execCommand('insertText', false, text)) {
        const sel = document.getSelection();
        if (sel && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          editor.appendChild(document.createTextNode(text));
        }
      }
      savedRange = document.getSelection().rangeCount
        ? document.getSelection().getRangeAt(0).cloneRange()
        : null;
    } finally {
      suppressSticky = false;
    }
    handleChange();
  }

  /* toolbar buttons ------------------------------------------------- */

  function button(label, title, handler, extraClass) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rt-btn' + (extraClass ? ' ' + extraClass : '');
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = label;
    // mousedown-preventDefault keeps the editor selection alive through the click
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      handler(b);
    });
    return b;
  }

  function separator() {
    const s = document.createElement('span');
    s.className = 'rt-sep';
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  const boldBtn = button('<b>B</b>', 'Bold (Ctrl+B)', () => exec('bold'));
  const italicBtn = button('<i>I</i>', 'Italic (Ctrl+I)', () => exec('italic'));
  const underlineBtn = button('<u>U</u>', 'Underline (Ctrl+U)', () => exec('underline'));
  const strikeBtn = button('<s>S</s>', 'Strikethrough', () => exec('strikeThrough'));
  const bulletBtn = button('&#8226; &#8801;', 'Bulleted list', () => exec('insertUnorderedList'));
  const numberBtn = button('1. &#8801;', 'Numbered list', () => exec('insertOrderedList'));

  function resetTypingFormat() {
    typingFormat['rt-font-'] = '';
    typingFormat['rt-size-'] = '';
    fontSelect.value = '';
    sizeSelect.value = '';
  }

  const fontSelect = document.createElement('select');
  fontSelect.className = 'rt-select rt-font-select';
  fontSelect.title = 'Font — applies to selected text, or to what you type next';
  fontSelect.setAttribute('aria-label', 'Font family');
  FONT_OPTIONS.forEach((o) => fontSelect.add(new Option(o.label, o.value)));
  fontSelect.addEventListener('mousedown', () => restoreSelection());
  fontSelect.addEventListener('change', () => setGroupFormat('rt-font-', fontSelect.value));

  const sizeSelect = document.createElement('select');
  sizeSelect.className = 'rt-select rt-size-select';
  sizeSelect.title = 'Size — applies to selected text, or to what you type next';
  sizeSelect.setAttribute('aria-label', 'Font size');
  SIZE_OPTIONS.forEach((o) => sizeSelect.add(new Option(o.label, o.value)));
  sizeSelect.value = '';
  sizeSelect.addEventListener('mousedown', () => restoreSelection());
  sizeSelect.addEventListener('change', () => setGroupFormat('rt-size-', sizeSelect.value));

  const emojiBtn = button('🙂', 'Emoji', () => toggleEmojiPanel(), 'rt-emoji-toggle');

  // An eraser — "remove every style from the selection and go back to plain text".
  const ERASER_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/>'
    + '<path d="M22 21H7"/><path d="m5 11 9 9"/></svg>';
  const clearBtn = button(ERASER_ICON, 'Clear formatting — back to plain text', () => {
    resetTypingFormat();
    if (!restoreSelection()) editor.focus();
    const sel = document.getSelection();
    if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) {
      const range = sel.getRangeAt(0);
      const holder = document.createElement('div');
      holder.appendChild(range.extractContents());
      // Drop every character-formatting wrapper, keep the text, <br>, and any
      // list structure inside the selection.
      holder.querySelectorAll('b, strong, i, em, u, s, strike, font, span').forEach((el) => {
        el.replaceWith(...el.childNodes);
      });
      const frag = document.createDocumentFragment();
      frag.append(...holder.childNodes);
      range.insertNode(frag);
      editor.normalize();
      const end = document.createRange();
      end.selectNodeContents(editor);
      end.collapse(false);
      sel.removeAllRanges();
      sel.addRange(end);
      savedRange = end.cloneRange();
    }
    syncToolbarState();
    handleChange();
  });

  toolbar.append(
    boldBtn, italicBtn, underlineBtn, strikeBtn, separator(),
    ...(lists ? [bulletBtn, numberBtn, separator()] : []),
    fontSelect, sizeSelect, separator(),
    emojiBtn, clearBtn,
  );

  /* emoji panel — buttons and dismiss listeners are created the first time
     it's opened, so an unused chat widget builds none of it. --------- */

  let emojiOpen = false;
  let emojiBuilt = false;

  function buildEmojiPanel() {
    if (emojiBuilt) return;
    emojiBuilt = true;
    fillEmojiGrid(emojiPanel, (emoji) => { insertText(emoji); closeEmojiPanel(); });
    document.addEventListener('click', (e) => {
      if (emojiOpen && !root.contains(e.target) && !emojiPanel.contains(e.target)) closeEmojiPanel();
    });
    // Capture-phase, so it also sees scrolls on the page behind the panel —
    // but scrolling *inside* the tray (its own element is the scroll target)
    // is how the user reaches the emoji further down, so that must not close it.
    window.addEventListener('scroll', (e) => {
      if (e.target !== emojiPanel) closeEmojiPanel();
    }, true);
  }

  function toggleEmojiPanel() {
    if (emojiOpen) { closeEmojiPanel(); return; }
    buildEmojiPanel();
    const sel = document.getSelection();
    if (sel.rangeCount && editor.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
    document.body.appendChild(emojiPanel);
    positionPopover(emojiPanel, emojiBtn.getBoundingClientRect());
    emojiOpen = true;
    emojiBtn.classList.add('is-active');
  }

  function closeEmojiPanel() {
    if (!emojiOpen) return;
    emojiPanel.remove();
    emojiOpen = false;
    emojiBtn.classList.remove('is-active');
  }

  /* attachments — "+" menu, one staged file, Discord-style tray --------- */

  const ATTACH_ITEMS = [
    { mode: 'file', label: 'Upload a file', hint: 'Any file, up to 10 MB', accept: '',
      icon: '<path d="M18 21H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8l5 5v12a1 1 0 0 1-1 1z"/><path d="M14 3v5h5"/>' },
    { mode: 'image', label: 'Embed an image', hint: 'PNG, JPG, WebP — up to 6 MB', accept: 'image/*',
      icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 9"/>' },
    { mode: 'gif', label: 'Embed a GIF', hint: 'An animated .gif file', accept: 'image/gif',
      icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 9.5A2.5 2.5 0 1 0 9 15h1.5v-2.2"/><path d="M13.5 9v6M17.5 9h-2.5v6M17 12h-2"/>' },
    { mode: 'video', label: 'Upload a video', hint: 'MP4, WebM — up to 20 MB', accept: 'video/*',
      icon: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="m21 8-4 3 4 3z"/>' },
  ];

  let attachOpen = false;
  let attachBuilt = false;

  function buildAttachMenu() {
    if (attachBuilt) return;
    attachBuilt = true;
    ATTACH_ITEMS.forEach((item) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rt-attach-item';
      b.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" `
        + `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${item.icon}</svg>`
        + `<span class="rt-attach-item-text"><span class="rt-attach-item-label"></span>`
        + `<span class="rt-attach-item-hint"></span></span>`;
      b.querySelector('.rt-attach-item-label').textContent = item.label;
      b.querySelector('.rt-attach-item-hint').textContent = item.hint;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        closeAttachMenu();
        fileInput.accept = item.accept;
        fileInput.dataset.mode = item.mode;
        fileInput.click();
      });
      attachMenu.appendChild(b);
    });
    document.addEventListener('click', (e) => {
      if (attachOpen && !root.contains(e.target) && !attachMenu.contains(e.target)) closeAttachMenu();
    });
    window.addEventListener('scroll', (e) => {
      if (attachOpen && e.target !== attachMenu) closeAttachMenu();
    }, true);
  }

  function toggleAttachMenu() {
    if (attachOpen) { closeAttachMenu(); return; }
    if (attachBtn.disabled) return;
    buildAttachMenu();
    document.body.appendChild(attachMenu);
    positionPopover(attachMenu, attachBtn.getBoundingClientRect());
    attachOpen = true;
    attachBtn.classList.add('is-active');
  }

  function closeAttachMenu() {
    if (!attachOpen) return;
    attachMenu.remove();
    attachOpen = false;
    attachBtn.classList.remove('is-active');
  }

  let pendingAttachment = null;

  function attachError(text) {
    attachTray.hidden = false;
    attachTray.innerHTML = '';
    const err = document.createElement('p');
    err.className = 'rt-att-error';
    err.textContent = text;
    attachTray.appendChild(err);
    setTimeout(() => { if (!pendingAttachment) { attachTray.hidden = true; attachTray.innerHTML = ''; } }, 5000);
  }

  function stageFile(file, mode) {
    const type = (file.type || '').toLowerCase();
    const wantImage = mode === 'image' || mode === 'gif';
    const cap = mode === 'video' ? 'video' : wantImage ? 'image' : 'file';

    if (ATTACHMENT_MIME_DENY.test(type)) {
      attachError("That file type can't be attached.");
      return;
    }
    if (wantImage && type && !/^image\//.test(type)) {
      attachError("That doesn't look like an image.");
      return;
    }
    if (mode === 'gif' && type && type !== 'image/gif') {
      attachError('Pick an animated .gif file.');
      return;
    }
    if (mode === 'video' && type && !/^video\//.test(type)) {
      attachError("That doesn't look like a video.");
      return;
    }
    if (file.size > ATTACHMENT_LIMITS[cap]) {
      attachError(`That's ${humanSize(file.size)} — the limit for this is ${humanSize(ATTACHMENT_LIMITS[cap])}.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const at = result.indexOf(';base64,');
      if (at < 0) { attachError("Couldn't read that file."); return; }
      const mime = (result.slice(5, at) || file.type || 'application/octet-stream').toLowerCase();
      const base64 = result.slice(at + 8);
      pendingAttachment = {
        kind: attachmentKind(mime, file.name),
        mime,
        name: file.name || 'attachment',
        base64,
        src: `data:${mime};base64,${base64}`,
        bytes: file.size,
        image: `data:${mime};name=${encodeURIComponent(file.name || 'attachment')};base64,${base64}`,
      };
      renderStagedTray();
      handleChange();
      editor.focus();
    };
    reader.onerror = () => attachError("Couldn't read that file.");
    reader.readAsDataURL(file);
  }

  function clearAttachment() {
    pendingAttachment = null;
    renderStagedTray();
  }

  function renderStagedTray() {
    attachTray.innerHTML = '';
    if (!pendingAttachment) { attachTray.hidden = true; return; }
    attachTray.hidden = false;

    const card = document.createElement('div');
    card.className = 'rt-att-staged';

    const thumb = document.createElement('div');
    thumb.className = 'rt-att-staged-thumb';
    if (pendingAttachment.kind === 'image') {
      const img = document.createElement('img');
      img.src = pendingAttachment.src;
      img.alt = '';
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = pendingAttachment.kind === 'video'
        ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m21 8-4 3 4 3z"/></svg>'
        : RT_FILE_ICON;
    }

    const meta = document.createElement('div');
    meta.className = 'rt-att-staged-meta';
    const nameEl = document.createElement('span');
    nameEl.className = 'rt-att-staged-name';
    nameEl.textContent = pendingAttachment.name;
    const sizeEl = document.createElement('span');
    sizeEl.className = 'rt-att-staged-size';
    sizeEl.textContent = humanSize(pendingAttachment.bytes);
    meta.append(nameEl, sizeEl);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'rt-att-staged-remove';
    remove.title = 'Remove attachment';
    remove.setAttribute('aria-label', 'Remove attachment');
    remove.textContent = '×';
    remove.addEventListener('mousedown', (e) => e.preventDefault());
    remove.addEventListener('click', () => { clearAttachment(); handleChange(); editor.focus(); });

    card.append(thumb, meta, remove);
    attachTray.appendChild(card);
  }

  /* editor behaviour -------------------------------------------- */

  function plainText() {
    return editor.textContent.replace(INVISIBLE_RE, '');
  }

  function editorIsBlank() {
    return plainText().trim() === ''
      && !editor.querySelector('li')
      && editor.innerHTML.replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/gi, '').trim() === '';
  }

  function isEmpty() {
    return !pendingAttachment && plainText().trim() === '' && !editor.querySelector('li');
  }

  function textLength() {
    return plainText().length;
  }

  function updatePlaceholder() {
    editor.classList.toggle('is-empty', editorIsBlank());
  }

  function syncToolbarState() {
    [['bold', boldBtn], ['italic', italicBtn], ['underline', underlineBtn], ['strikeThrough', strikeBtn],
      ...(lists ? [['insertUnorderedList', bulletBtn], ['insertOrderedList', numberBtn]] : [])].forEach(([cmd, btn]) => {
      let on = false;
      try { on = document.queryCommandState(cmd); } catch (_) { /* ignore */ }
      btn.classList.toggle('is-active', on);
    });
  }

  function handleChange() {
    pruneEmptyRtSpans();
    updatePlaceholder();
    editor.classList.toggle('is-over-limit', textLength() > maxLength);
    onInput({ isEmpty: isEmpty(), length: textLength(), overLimit: textLength() > maxLength });
  }

  editor.addEventListener('input', handleChange);
  editor.addEventListener('keyup', syncToolbarState);
  editor.addEventListener('mouseup', syncToolbarState);

  function inListItem() {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return false;
    let node = sel.getRangeAt(0).startContainer;
    while (node && node !== editor) {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') return true;
      node = node.parentNode;
    }
    return false;
  }

  editor.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.shiftKey) {
      // Shift+Enter is a soft newline; inside a list that means the next item.
      if (inListItem()) {
        e.preventDefault();
        document.execCommand('insertParagraph', false, null);
        syncToolbarState();
        handleChange();
      }
      return; // outside a list, let the browser drop in its <br>
    }
    e.preventDefault();
    onSubmit();
  });

  // Sticky font / size. If the caret is already in a span that carries exactly
  // the armed mode, let the browser type into it. Otherwise take over: wrap the
  // text in the armed mode, or — when nothing is armed but the caret is stuck
  // in a stale font/size span — step the new text out to plain.
  editor.addEventListener('beforeinput', (e) => {
    if (suppressSticky || e.isComposing) return;
    if (e.inputType !== 'insertText' || typeof e.data !== 'string' || !e.data) return;
    const classes = stickyClasses();
    if (styledSpanAtCaret(classes)) return;
    if (!classes.length && !caretInRtSpan()) return;
    e.preventDefault();
    if (insertStyledText(e.data)) handleChange();
  });

  // Paste: an image on the clipboard is staged as an attachment (Discord-style);
  // everything else drops in as plain text, so junk markup never enters a message.
  editor.addEventListener('paste', (e) => {
    const dt = e.clipboardData || window.clipboardData;
    const imageItem = dt && Array.from(dt.items || []).find(
      (it) => it.kind === 'file' && /^image\//i.test(it.type) && !ATTACHMENT_MIME_DENY.test(it.type),
    );
    if (imageItem && !pendingAttachment) {
      const file = imageItem.getAsFile();
      if (file) { e.preventDefault(); stageFile(file, 'image'); return; }
    }
    e.preventDefault();
    insertText(dt ? dt.getData('text/plain') : '');
  });

  // Drop a file straight onto the composer to stage it.
  root.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      root.classList.add('is-dragover');
    }
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget)) root.classList.remove('is-dragover');
  });
  root.addEventListener('drop', (e) => {
    root.classList.remove('is-dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    if (pendingAttachment) { attachError('Only one attachment per message — remove the current one first.'); return; }
    stageFile(file, /^image\//i.test(file.type) ? 'image' : /^video\//i.test(file.type) ? 'video' : 'file');
  });

  updatePlaceholder();

  /* public API ------------------------------------------------- */

  return {
    element: root,
    editor,
    focus() { editor.focus(); },
    clear() {
      editor.innerHTML = '';
      savedRange = null;
      resetTypingFormat();
      clearAttachment();
      replyTo = null;
      renderReplyBar();
      handleChange();
    },
    setEnabled(enabled) {
      editor.contentEditable = enabled ? 'true' : 'false';
      editor.classList.toggle('is-disabled', !enabled);
      toolbar.querySelectorAll('button, select').forEach((el) => { el.disabled = !enabled; });
      attachBtn.disabled = !enabled;
      if (!enabled) { closeEmojiPanel(); closeAttachMenu(); }
    },
    isEmpty,
    isOverLimit() { return textLength() > maxLength; },
    length: textLength,
    getHTML() {
      let html = sanitizeRichText(editor.innerHTML).replace(/(?:<br>|\s)+$/g, '').trim();
      if (replyTo) {
        const q = document.createElement('blockquote');
        const who = document.createElement('b');
        who.textContent = replyTo.sender;
        const snip = replyTo.text.length > 160 ? `${replyTo.text.slice(0, 160)}…` : replyTo.text;
        q.append(who, document.createTextNode(snip ? ` ${snip}` : ''));
        const holder = document.createElement('div');
        holder.appendChild(q);
        html = holder.innerHTML + html;
      }
      return html;
    },
    // The staged attachment, or null. `image` is the string for the message's
    // `image` field; `kind` is 'image' | 'video' | 'file'.
    getAttachment() {
      return pendingAttachment
        ? { image: pendingAttachment.image, name: pendingAttachment.name, kind: pendingAttachment.kind, bytes: pendingAttachment.bytes }
        : null;
    },
    // The "Replying to …" context, set from a message's Reply hover action.
    setReplyTo(meta) {
      replyTo = meta && meta.text != null
        ? { sender: String(meta.sender || 'Someone'), text: String(meta.text || '') }
        : null;
      renderReplyBar();
      handleChange();
      editor.focus();
    },
    getReplyTo() { return replyTo ? { ...replyTo } : null; },
  };
}
