import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

function fakeEnv() {
  const requested = [];
  return {
    requested,
    CHAT_ROOM: {
      idFromName: (name) => name,
      get: (room) => ({
        fetch: async (request) => {
          requested.push({ room, path: new URL(request.url).pathname });
          return new Response('ok');
        },
      }),
    },
  };
}

test('запросы уходят в комнату нужного сервера или в комнату входа', async () => {
  const env = fakeEnv();
  await worker.fetch(new Request('https://relay.test/s/chernarus-pve/chat?since=0'), env);
  await worker.fetch(new Request('https://relay.test/auth/steam', { method: 'POST' }), env);
  assert.deepEqual(env.requested, [
    { room: 'chernarus-pve', path: '/s/chernarus-pve/chat' },
    { room: 'auth', path: '/auth/steam' },
  ]);
});

test('неизвестный путь отклоняется без обращения к комнате', async () => {
  const env = fakeEnv();
  const response = await worker.fetch(new Request('https://relay.test/other'), env);
  assert.equal(response.status, 404);
  assert.equal(env.requested.length, 0);
});
