import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifySteamLogin, verifyToken } from '../src/auth.js';
import { memoryStorage } from './helpers.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const SECRET = 's'.repeat(40);
const STEAM = 'https://steamcommunity.com/openid/login';

function steamParams(overrides = {}) {
  const claimed = 'https://steamcommunity.com/openid/id/76561197960287930';
  return {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': STEAM,
    'openid.claimed_id': claimed,
    'openid.identity': claimed,
    'openid.return_to': 'http://127.0.0.1:50555/steam-return',
    'openid.response_nonce': '2026-11-18T11:59:30Zabc123',
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2lnbmF0dXJl',
    ...overrides,
  };
}

function fakeSteam({ valid = true, profile = true, personaName = 'Тестовый игрок' } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : '' });
    if (String(url) === STEAM) return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${valid}\n`);
    if (!profile) throw new Error('профиль недоступен');
    return new Response(`<profile><steamID><![CDATA[${personaName}]]></steamID></profile>`);
  };
  return { fetchFn, calls };
}

test('токен подписывается и проверяется', async () => {
  const token = await signToken({ sid: '1', name: 'Имя', exp: NOW + 1000 }, SECRET);
  assert.deepEqual(await verifyToken(token, SECRET, NOW), { sid: '1', name: 'Имя', exp: NOW + 1000 });
});

test('подмена содержимого, чужой секрет и истёкший токен отклоняются', async () => {
  const token = await signToken({ sid: '1', name: 'Имя', exp: NOW + 1000 }, SECRET);
  const [, signature] = token.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ sid: '2', name: 'Имя', exp: NOW + 1000 })).toString('base64url');
  assert.equal(await verifyToken(`${forgedBody}.${signature}`, SECRET, NOW), null);
  assert.equal(await verifyToken(token, 'x'.repeat(40), NOW), null);
  assert.equal(await verifyToken(token, SECRET, NOW + 2000), null);
  assert.equal(await verifyToken('мусор', SECRET, NOW), null);
});

test('вход через Steam: подпись проверена, ник получен', async () => {
  const { fetchFn, calls } = fakeSteam();
  const result = await verifySteamLogin(steamParams(), { storage: memoryStorage(), now: NOW, fetchFn });
  assert.deepEqual(result, { ok: true, steamId: '76561197960287930', name: 'Тестовый игрок' });
  assert.match(calls[0].body, /openid\.mode=check_authentication/);
});

test('повторное использование ответа Steam отклоняется', async () => {
  const storage = memoryStorage();
  const { fetchFn } = fakeSteam();
  await verifySteamLogin(steamParams(), { storage, now: NOW, fetchFn });
  const again = await verifySteamLogin(steamParams(), { storage, now: NOW, fetchFn });
  assert.equal(again.error, 'replayed_login');
});

test('ответ, который Steam не подтвердил, отклоняется', async () => {
  const { fetchFn } = fakeSteam({ valid: false });
  const result = await verifySteamLogin(steamParams(), { storage: memoryStorage(), now: NOW, fetchFn });
  assert.equal(result.error, 'steam_rejected');
});

test('старый ответ Steam отклоняется', async () => {
  const { fetchFn } = fakeSteam();
  const params = steamParams({ 'openid.response_nonce': '2026-11-18T11:40:00Zzz' });
  const result = await verifySteamLogin(params, { storage: memoryStorage(), now: NOW, fetchFn });
  assert.equal(result.error, 'stale_login');
});

test('адрес возврата не на локальный компьютер отклоняется', async () => {
  const { fetchFn } = fakeSteam();
  const params = steamParams({ 'openid.return_to': 'https://evil.example/steam-return' });
  const result = await verifySteamLogin(params, { storage: memoryStorage(), now: NOW, fetchFn });
  assert.equal(result.error, 'bad_params');
});

test('чужой идентификатор OpenID отклоняется', async () => {
  const { fetchFn } = fakeSteam();
  const params = steamParams({ 'openid.claimed_id': 'https://evil.example/openid/id/76561197960287930' });
  const result = await verifySteamLogin(params, { storage: memoryStorage(), now: NOW, fetchFn });
  assert.equal(result.error, 'bad_params');
});

test('если профиль недоступен, в качестве имени используется SteamID', async () => {
  const { fetchFn } = fakeSteam({ profile: false });
  const result = await verifySteamLogin(steamParams(), { storage: memoryStorage(), now: NOW, fetchFn });
  assert.equal(result.name, '76561197960287930');
});
