import { ChatRoomLogic } from './room.js';

export class ChatRoom {
  constructor(state, env) {
    this.logic = new ChatRoomLogic({ storage: state.storage, env });
  }

  fetch(request) {
    return this.logic.handle(request);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const server = /^\/s\/([a-z0-9-]{1,32})\//.exec(pathname)?.[1];
    const name = pathname === '/auth/steam' ? 'auth' : server;
    if (!name) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(name)).fetch(request);
  },
};
