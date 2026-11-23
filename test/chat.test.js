'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  ChatError,
  fetchMessages,
  loadRelayUrl,
  loginWithSteam,
  normalizeRelayUrl,
  sendMessage,
  steamLoginUrl,
} = require('../src/chat');

const RELAY = 'https://dsl-chat.example.workers.dev';

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('адрес чата: пусто, https разрешён, остальное отклоняется', () => {
  assert.equal(normalizeRelayUrl('   '), '');
  assert.equal(normalizeRelayUrl(' https://dsl-chat.example.workers.dev/some/path '), RELAY);
  assert.throws(() => normalizeRelayUrl('http://dsl-chat.example.workers.dev'), /https/);
});

test('без файла конфигурации чат не настроен', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsl-chat-'));
  const file = path.join(dir, 'chat.json');
  assert.equal(await loadRelayUrl(file), '');
  await fs.writeFile(file, JSON.stringify({ url: RELAY }));
  assert.equal(await loadRelayUrl(file), RELAY);
});

test('ссылка входа в Steam содержит адрес возврата и область', () => {
  const url = new URL(steamLoginUrl('http://127.0.0.1:5000/steam-return', 'http://127.0.0.1:5000/'));
  assert.equal(url.origin + url.pathname, 'https://steamcommunity.com/openid/login');
  assert.equal(url.searchParams.get('openid.mode'), 'checkid_setup');
  assert.equal(url.searchParams.get('openid.return_to'), 'http://127.0.0.1:5000/steam-return');
  assert.equal(url.searchParams.get('openid.realm'), 'http://127.0.0.1:5000/');
});

test('вход через Steam: серверу передаются только поля openid', async () => {
  const sent = [];
  const fetchFn = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return jsonResponse({ token: 'a.b', steamId: '76561197960287930', name: 'Игрок', expiresAt: 1 });
  };
  const session = await loginWithSteam({
    relayUrl: RELAY,
    fetchFn,
    timeoutMs: 5000,
    openExternal: async (link) => {
      const returnTo = new URL(link).searchParams.get('openid.return_to');
      setTimeout(() => {
        http.get(
          `${returnTo}?openid.mode=id_res&openid.claimed_id=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Fid%2F76561197960287930&utm=extra`,
          { agent: false },
          (res) => res.resume(),
        );
      }, 10);
    },
  });
  assert.equal(session.steamId, '76561197960287930');
  assert.equal(sent[0].url, `${RELAY}/auth/steam`);
  assert.deepEqual(Object.keys(sent[0].body.params).sort(), ['openid.claimed_id', 'openid.mode']);
});

test('если вход в браузере не подтвердили, ожидание заканчивается ошибкой', async () => {
  await assert.rejects(
    loginWithSteam({ relayUrl: RELAY, fetchFn: async () => jsonResponse({}), timeoutMs: 50, openExternal: async () => {} }),
    (error) => error instanceof ChatError && error.code === 'login_timeout',
  );
});

test('история запрашивается с номером последнего сообщения и токеном', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization });
    return jsonResponse({ session: 's1', online: true, head: 3, messages: [] });
  };
  const data = await fetchMessages({ relayUrl: RELAY, serverId: 'chernarus-pve', since: 7, token: 'a.b', fetchFn });
  assert.equal(data.online, true);
  assert.equal(calls[0].url, `${RELAY}/s/chernarus-pve/chat?since=7`);
  assert.equal(calls[0].auth, 'Bearer a.b');
});

test('ошибки сервера чата приходят с кодом и статусом', async () => {
  const fetchFn = async () => jsonResponse({ error: 'rate_limited' }, 429);
  await assert.rejects(
    sendMessage({ relayUrl: RELAY, serverId: 'chernarus-pve', text: 'привет', token: 'a.b', fetchFn }),
    (error) => error instanceof ChatError && error.code === 'rate_limited' && error.status === 429,
  );
});

test('нет связи с сервером чата — код network', async () => {
  const fetchFn = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    fetchMessages({ relayUrl: RELAY, serverId: 'chernarus-pve', since: 0, token: 'a.b', fetchFn }),
    (error) => error instanceof ChatError && error.code === 'network',
  );
});


test('повтор workers.dev отклоняется до подключения TLS', () => {
  assert.throws(() => normalizeRelayUrl('https://dead-souls-launcher.ugautodetal-23rus.workers.dev.workers.dev'), /дважды/);
  assert.equal(normalizeRelayUrl('https://dead-souls-launcher.ugautodetal-23rus.workers.dev'), 'https://dead-souls-launcher.ugautodetal-23rus.workers.dev');
});

test('сетевая ошибка сохраняет причину TLS, не отключая проверку сертификата', async () => {
  const tls = new Error('handshake failed', { cause: Object.assign(new Error('tls'), { code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE' }) });
  await assert.rejects(sendMessage({ relayUrl: RELAY, serverId: 'chernarus-pve', text: 'test', token: 'test', fetchFn: async () => { throw tls; } }), e => e.code === 'network' && e.cause === tls);
});
