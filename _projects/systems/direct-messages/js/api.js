import { javaURI, javaWebSocketURI, fetchOptions } from '../../api/config.js';

const local = ['localhost', '127.0.0.1'].includes(location.hostname);
export const socketUrl = `${local ? javaWebSocketURI : javaURI}/api/ws-chat`;

export async function request(path, method = 'GET', body) {
  let response;
  try {
    response = await fetch(`${javaURI}${path}`, {
      ...fetchOptions, method, cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach the chat server. Check your connection and try again.');
  }
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'Sign in again to continue.' :
      response.status === 403 ? 'You do not have access to this conversation.' :
      response.status === 404 ? 'This user or conversation is no longer available.' : 'Could not save or load your messages. Please try again.');
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

export const chatPath = (id, resource = 'messages') => `/api/groups/chat/${id}/${resource}`;
