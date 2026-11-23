import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/auth.js';
import { ENV, call, makeRoom } from './helpers.js';

const START = Date.parse('2026-11-18T12:00:00Z');
const SERVER = '/s/chernarus-pve';
const SID = '76561197960287930';

async function userToken(clock, name = 'Игрок Один', sid = SID) {
  return signToken({ sid, name, exp: clock.value + 3_600_000 }, ENV.TOKEN_SECRET);
}

function send(room, token, text) {
  return call(room, 'POST', `${SERVER}/chat`, { token, body: { text } });
}

test('сообщение из лаунчера видно другим игрокам с входом', async () => {
  const clock = { value: START };
  const room = makeRoom({ clock });
  assert.deepEqual((await send(room, await userToken(clock), 'Всем привет')).body, { ok: true, seq: 1 });
  clock.value += 2_000;
  const reader = await userToken(clock, 'Игрок Два', '76561197960287931');
  const chat = await call(room, 'GET', `${SERVER}/chat?since=0`, { token: reader });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.online, true);
  assert.equal(chat.body.head, 1);
  assert.deepEqual(
    chat.body.messages.map((m) => [m.source, m.name, m.text]),
    [['launcher', 'Игрок Один', 'Всем привет']],
  );
});

test('since отдаёт только сообщения после указанного номера', async () => {
  const clock = { value: START };
  const room = makeRoom({ clock });
  const token = await userToken(clock);
  await send(room, token, 'первое');
  clock.value += 2_000;
  await send(room, token, 'второе');
  const later = await call(room, 'GET', `${SERVER}/chat?since=1`, { token });
  assert.deepEqual(later.body.messages.map((m) => m.text), ['второе']);
  const none = await call(room, 'GET', `${SERVER}/chat?since=2`, { token });
  assert.deepEqual(none.body.messages, []);
});

test('сообщения чаще раза в две секунды отклоняются', async () => {
  const clock = { value: START };
  const room = makeRoom({ clock });
  const token = await userToken(clock);
  assert.equal((await send(room, token, 'один')).status, 200);
  assert.equal((await send(room, token, 'два')).status, 429);
  clock.value += 2_000;
  assert.equal((await send(room, token, 'три')).status, 200);
});

test('бан запрещает писать, но историю читать можно', async () => {
  const clock = { value: START };
  const room = makeRoom({ clock });
  const token = await userToken(clock);
  const ban = await call(room, 'POST', `${SERVER}/admin/ban`, {
    token: ENV.ADMIN_TOKEN,
    body: { steamId: SID, minutes: 60 },
  });
  assert.equal(ban.status, 200);
  assert.equal((await send(room, token, 'я')).status, 403);
  assert.equal((await call(room, 'GET', `${SERVER}/chat?since=0`, { token })).status, 200);
  clock.value += 61 * 60_000;
  assert.equal((await send(room, await userToken(clock), 'я')).status, 200);
});

test('подделанный токен и запрос без токена отклоняются', async () => {
  const clock = { value: START };
  const room = makeRoom({ clock });
  const forged = await signToken({ sid: SID, name: 'Чужой', exp: START + 3_600_000 }, 'v'.repeat(48));
  assert.equal((await send(room, forged, 'подделка')).status, 401);
  assert.equal((await call(room, 'GET', `${SERVER}/chat?since=0`)).status, 401);
});

test('управляющие символы убираются, текст обрезается до 200 символов', async () => {
  const clock = { value: START };
  const room = makeRoom({ clock });
  const token = await userToken(clock);
  const noisy = `  строка\u0000\u0007 с  пробелами\n${'я'.repeat(300)}`;
  assert.equal((await send(room, token, noisy)).status, 200);
  const text = (await call(room, 'GET', `${SERVER}/chat?since=0`, { token })).body.messages[0].text;
  assert.ok(text.startsWith('строка с пробелами я'));
  assert.equal(Array.from(text).length, 200);
  clock.value += 2_000;
  assert.equal((await send(room, token, ' \n ')).status, 400);
});

test('эндпоинтов игрового мода больше нет', async () => {
  const room = makeRoom({ clock: { value: START } });
  assert.equal((await call(room, 'POST', `${SERVER}/mod/session`, { body: {} })).status, 404);
  assert.equal((await call(room, 'POST', `${SERVER}/mod/sync`, { body: {} })).status, 404);
});
