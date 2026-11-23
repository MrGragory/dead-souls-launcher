'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Dead Souls</title><p>Вход выполнен. Можно закрыть эту вкладку и вернуться в лаунчер.</p>';
const FAILED_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Dead Souls</title><p>Вход не выполнен. Вернитесь в лаунчер: там написано, в чём причина.</p>';

class ChatError extends Error {
  constructor(code, status = 0, options) {
    super(code, options);
    this.code = code;
    this.status = status;
  }
}

function normalizeRelayUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return '';
  const url = new URL(text);
  if (url.protocol !== 'https:') throw new Error('Адрес чата должен начинаться с https://');
  if (url.username || url.password) throw new Error('Адрес чата не должен содержать логин или пароль.');
  if (/\.workers\.dev\.workers\.dev$/i.test(url.hostname)) {
    throw new Error('В адресе чата дважды указано workers.dev. Удалите повтор в config/chat.json.');
  }
  return url.origin;
}

async function loadRelayUrl(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  return normalizeRelayUrl(JSON.parse(text).url);
}

function steamLoginUrl(returnTo, realm) {
  const params = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': `${OPENID_NS}/identifier_select`,
    'openid.claimed_id': `${OPENID_NS}/identifier_select`,
  });
  return `${STEAM_OPENID}?${params}`;
}

async function relayRequest(relayUrl, path, { method = 'GET', token, body, fetchFn = fetch } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetchFn(new URL(path, relayUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ChatError('network', 0, { cause: error });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new ChatError(typeof data?.error === 'string' ? data.error : 'http', response.status);
    error.route = path.split('?')[0];
    error.ray = response.headers?.get?.('cf-ray') ?? '';
    throw error;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ChatError('invalid_response', response.status);
  return data;
}

async function loginWithSteam({ relayUrl, openExternal, fetchFn = fetch, timeoutMs = LOGIN_TIMEOUT_MS }) {
  const server = http.createServer();
  let deliver;
  const returned = new Promise((resolve) => {
    deliver = resolve;
  });
  server.on('request', (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/steam-return') {
      response.writeHead(404).end();
      return;
    }
    const params = Object.fromEntries([...url.searchParams].filter(([key]) => key.startsWith('openid.')));
    if (params['openid.mode'] !== 'id_res') {
      response.writeHead(400).end();
      return;
    }
    deliver({ params, response });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await openExternal(steamLoginUrl(`http://127.0.0.1:${port}/steam-return`, `http://127.0.0.1:${port}/`));
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ChatError('login_timeout')), timeoutMs);
    });
    let callback;
    try {
      callback = await Promise.race([returned, timeout]);
    } finally {
      clearTimeout(timer);
    }
    const page = { 'content-type': 'text/html; charset=utf-8' };
    try {
      const session = await relayRequest(relayUrl, '/auth/steam', { method: 'POST', body: { params: callback.params }, fetchFn });
      callback.response.writeHead(200, page).end(LOGIN_PAGE);
      return session;
    } catch (error) {
      callback.response.writeHead(200, page).end(FAILED_PAGE);
      throw error;
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function fetchMessages({ relayUrl, serverId, since, latest, token, fetchFn }) {
  return relayRequest(relayUrl, `/s/${serverId}/chat?since=${since}${latest ? '&latest=1' : ''}`, { token, fetchFn });
}

function sendMessage({ relayUrl, serverId, text, token, fetchFn }) {
  return relayRequest(relayUrl, `/s/${serverId}/chat`, { method: 'POST', token, body: { text }, fetchFn });
}

module.exports = {
  ChatError,
  relayRequest,
  fetchMessages,
  loadRelayUrl,
  loginWithSteam,
  normalizeRelayUrl,
  sendMessage,
  steamLoginUrl,
};
