import { ChatRoomLogic } from '../src/room.js';

export const ENV = {
  TOKEN_SECRET: 'u'.repeat(48),
  ADMIN_TOKEN: 'admin-token-0001',
};

export function memoryStorage() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(keys) {
      let removed = 0;
      for (const key of Array.isArray(keys) ? keys : [keys]) if (map.delete(key)) removed += 1;
      return removed;
    },
    async list({ prefix = '', start, limit } = {}) {
      const keys = [...map.keys()]
        .filter((key) => key.startsWith(prefix) && (start === undefined || key >= start))
        .sort();
      const result = new Map();
      for (const key of keys.slice(0, limit ?? keys.length)) result.set(key, structuredClone(map.get(key)));
      return result;
    },
  };
}

export function makeRoom({ storage = memoryStorage(), clock, fetchFn = fetch }) {
  return new ChatRoomLogic({ storage, env: ENV, now: () => clock.value, fetchFn });
}

export async function call(room, method, path, { body, token, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const response = await room.handle(new Request(`https://relay.test${path}`, init));
  return { status: response.status, body: await response.json() };
}
