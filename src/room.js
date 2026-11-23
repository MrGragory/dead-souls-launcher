import { community, isAdmin } from './community.js';
import { signToken, verifySteamLogin, verifyToken } from './auth.js';

const MAX_TEXT = 200;
const MAX_NAME = 32;
const MAX_BODY_BYTES = 65_536;
const SEND_INTERVAL_MS = 2_000;
const CHAT_PAGE = 100;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROOM_SESSION = 'room';
const SERVER_ID = /^[a-z0-9-]{1,32}$/;
const STEAM_ID = /^\d{17}$/;

const msgKey = (seq) => `msg:${String(seq).padStart(12, '0')}`;

export { json, readJson, bearer, msgKey };

export function cleanText(value, max) {
  const text = typeof value === 'string' ? value : '';
  return Array.from(text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

async function readJson(request) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function bearer(request) {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function sameSecret(given, expected) {
  if (!given || typeof expected !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export class ChatRoomLogic {
  constructor({ storage, env, now = Date.now, fetchFn = fetch }) {
    this.storage = storage;
    this.env = env;
    this.now = now;
    this.fetchFn = fetchFn;
  }

  async handle(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/auth/steam') return this.steamLogin(request);
    const [, root, server, ...rest] = url.pathname.split('/');
    if (root !== 's' || !SERVER_ID.test(server ?? '')) return json({ error: 'not_found' }, 404);
    const route = `${request.method} /${rest.join('/')}`;
    if (route === 'GET /chat') return this.readChat(request, url);
    if (route === 'POST /chat') return this.sendChat(request);
    if (route === 'POST /admin/ban') return this.ban(request);
    if (server === 'launcher') return community(this, route, request, url);
    return json({ error: 'not_found' }, 404);
  }

  async readChat(request, url) {
    const user = await verifyToken(bearer(request), this.env.TOKEN_SECRET, this.now());
    if (!user) return json({ error: 'unauthorized' }, 401);
    const since = Math.max(0, Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0);
    const meta = await this.loadMeta();
    const latest = url.searchParams.get('latest') === '1';
    const page = await this.storage.list(latest ? { prefix: 'msg:', reverse: true, limit: CHAT_PAGE } : { prefix: 'msg:', start: msgKey(since + 1), limit: CHAT_PAGE });
    const admin = isAdmin(user);
    const messages = [...page.values()].sort((a,b) => a.seq-b.seq).map(({ seq, source, name, text, time, steamId }) => ({ seq, source, name, text, time, ...(admin && steamId ? { steamId } : {}) }));
    return json({ session: ROOM_SESSION, online: true, head: meta.seq, messages, admin });
  }

  async sendChat(request) {
    const user = await verifyToken(bearer(request), this.env.TOKEN_SECRET, this.now());
    if (!user) return json({ error: 'unauthorized' }, 401);
    const body = await readJson(request);
    const text = cleanText(body?.text, MAX_TEXT);
    if (!text) return json({ error: 'bad_text' }, 400);
    const write = async (db) => {
      const now = this.now();
      if ((await db.get(`ban:${user.sid}`)) > now) return json({ error: 'banned' }, 403);
      const last = await db.get(`rate:${user.sid}`);
      if (last !== undefined && now - last < SEND_INTERVAL_MS) return json({ error: 'rate_limited' }, 429);
      const meta = (await db.get('meta')) ?? { seq: 0 };
      meta.seq += 1;
      const name = cleanText(user.name, MAX_NAME) || 'Игрок';
      await db.put(msgKey(meta.seq), { seq: meta.seq, source: 'launcher', name, text, time: now, steamId: user.sid });
      await db.put(`author:${user.sid}`, { steamId: user.sid, name });
      await db.put(`rate:${user.sid}`, now);
      await db.put('meta', meta);
      return json({ ok: true, seq: meta.seq });
    };
    return this.storage.transaction ? this.storage.transaction(write) : write(this.storage);
  }

  async ban(request) {
    if (!sameSecret(bearer(request), this.env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
    const body = await readJson(request);
    const steamId = String(body?.steamId ?? '');
    const minutes = body?.minutes;
    if (!STEAM_ID.test(steamId) || !Number.isInteger(minutes) || minutes < 0 || minutes > 525_600) {
      return json({ error: 'bad_request' }, 400);
    }
    if (minutes === 0) await this.storage.delete(`ban:${steamId}`);
    else await this.storage.put(`ban:${steamId}`, this.now() + minutes * 60_000);
    return json({ ok: true });
  }

  async steamLogin(request) {
    const body = await readJson(request);
    const now = this.now();
    const result = await verifySteamLogin(body?.params, { storage: this.storage, now, fetchFn: this.fetchFn });
    if (!result.ok) return json({ error: result.error }, 401);
    const name = cleanText(result.name, MAX_NAME) || result.steamId;
    const expiresAt = now + TOKEN_TTL_MS;
    const token = await signToken({ sid: result.steamId, name, exp: expiresAt }, this.env.TOKEN_SECRET);
    return json({ token, steamId: result.steamId, name, expiresAt });
  }

  async isBanned(steamId) {
    const until = await this.storage.get(`ban:${steamId}`);
    return typeof until === 'number' && until > this.now();
  }

  async loadMeta() {
    return (await this.storage.get('meta')) ?? { seq: 0 };
  }

  async saveMeta(meta) {
    await this.storage.put('meta', meta);
  }
}
