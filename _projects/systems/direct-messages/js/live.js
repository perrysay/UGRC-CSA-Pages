/* Backend calls for direct messages.
 *
 * Wraps the Spring routes (/api/dm/** plus the shared group-chat endpoints)
 * behind one object for messages.js. Normalizes the wire format too: the chat
 * endpoint returns the sender's username in `name`, which this resolves to a
 * display name using the conversation's two known participants.
 */

import { request, chatPath } from './api.js';

export function createLiveBackend() {
  // Sender username -> display name, filled in as conversations are opened.
  const names = new Map();

  const normalize = (message) => ({
    id: message.id,
    uid: message.name,
    name: names.get(message.name) || message.name,
    message: message.message,
    date: message.date,
  });

  return {
    async me() {
      const me = await request('/api/dm/me');
      names.set(me.uid, me.name);
      return me;
    },

    async search(query) {
      const term = query.trim();
      if (term.length < 2) return [];
      return request(`/api/dm/users?q=${encodeURIComponent(term)}`);
    },

    async inbox() {
      const inbox = await request('/api/dm');
      inbox.forEach((conversation) => names.set(conversation.peer.uid, conversation.peer.name));
      return inbox;
    },

    async open(personId) {
      const conversation = await request('/api/dm', 'POST', { recipientId: personId });
      names.set(conversation.peer.uid, conversation.peer.name);
      return conversation;
    },

    async history(conversationId) {
      const messages = await request(chatPath(conversationId));
      return messages.map(normalize);
    },

    // The server stamps the sender and timestamp; anything sent here is
    // ignored for those fields, which is what stops a forged sender name.
    async send(conversationId, html) {
      const saved = await request(chatPath(conversationId), 'POST', { message: html });
      return saved ? normalize(saved) : null;
    },

    async read(conversationId, messageId) {
      await request(`/api/dm/${conversationId}/read`, 'POST', { messageId });
    },

    async files(conversationId) {
      return request(chatPath(conversationId, 'files'));
    },

    // The chat file route takes JSON, not multipart, so the bytes go up as
    // base64 the same way the group-chat attachments do.
    async upload(conversationId, file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return request(chatPath(conversationId, 'files'), 'POST', {
        filename: file.name,
        base64Data: btoa(binary),
      });
    },
  };
}
