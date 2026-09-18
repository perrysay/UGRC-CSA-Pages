import { socketUrl } from './api.js';

// HTTP sends acknowledge persistence. The existing group broker supplies updates and presence.
export class ChatConnection {
  constructor(onEvent, onStatus) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }

  connect() {
    if (this.stopped || this.connecting || this.connected) return;
    if (!window.SockJS || !window.Stomp) { this.onStatus('Checking for messages every few seconds'); return; }
    this.connecting = true;
    const socket = new window.SockJS(socketUrl);
    const client = window.Stomp.over(socket);
    this.client = client;
    client.debug = () => {};
    const failed = () => {
      if (this.client !== client || this.stopped) return;
      this.client = null;
      this.connected = this.connecting = false;
      this.subscription = null;
      this.onStatus('Reconnecting · checking for messages');
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.connect(), 5000);
    };
    socket.onclose = failed;
    client.connect({}, () => {
      if (this.stopped) { client.disconnect(); return; }
      this.connected = true;
      this.connecting = false;
      this.onStatus('Live');
      this.select(this.groupId);
      this.onEvent({ context: 'reconnected' });
    }, failed);
  }

  select(groupId) {
    if (this.connected && this.subscription) {
      this.send('leaveGroup');
      this.subscription.unsubscribe();
      this.subscription = null;
    }
    this.groupId = groupId;
    if (!this.connected || !groupId) return;
    this.subscription = this.client.subscribe(`/topic/group/${groupId}`, frame => {
      try { this.onEvent(JSON.parse(frame.body)); }
      catch (error) { console.error('Could not process a chat update', error); }
    });
    this.send('joinGroup');
  }

  send(context) {
    if (!this.connected || !this.groupId) return;
    this.client.send('/app/groups.chat', {}, JSON.stringify({ context, groupId: this.groupId }));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    if (this.connected) { this.send('leaveGroup'); this.client.disconnect(); }
    else if (this.client?.ws) this.client.ws.close();
    this.connected = this.connecting = false;
  }
}
