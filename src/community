import { verifyToken } from './auth.js';
import { bearer, cleanText, json, msgKey, readJson } from './room.js';

const ADMINS = new Set(['76561198064130816', '76561198267601141']);
export const isAdmin = (user) => ADMINS.has(user?.sid);
const steamIdPattern = /^\d{17}$/;
const uuidPattern = /^[0-9a-f-]{36}$/i;
const newsText = (value) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 4000) : '';

function videoLink(value) {
  if (typeof value !== 'string' || value.length > 1000) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const id = '[A-Za-z0-9_-]{11}';
    if (u.hostname === 'youtu.be' && new RegExp(`^/${id}/?$`).test(u.pathname)) return `https://www.youtube.com/watch?v=${u.pathname.split('/')[1]}`;
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(u.hostname)) {
      const v = u.pathname === '/watch' ? u.searchParams.get('v') : new RegExp(`^/(?:live|shorts)/(${id})/?$`).exec(u.pathname)?.[1];
      if (new RegExp(`^${id}$`).test(v ?? '')) return `https://www.youtube.com/watch?v=${v}`;
    }
    if (['vk.com', 'vk.ru', 'vkvideo.ru', 'www.vkvideo.ru', 'm.vk.com'].includes(u.hostname) && /^\/video-?\d+_\d+\/?$/.test(u.pathname)) return `https://vkvideo.ru${u.pathname.replace(/\/$/, '')}`;
  } catch {}
  return null;
}

export async function community(room, route, request, url) {
  const db = room.storage;
  const now = room.now();
  const publicKey = { 'GET /news': 'community:news', 'GET /streams': 'community:streams' }[route];
  if (publicKey) return json({ items: (await db.get(publicKey)) ?? [] });
  const adminRoutes = ['POST /news', 'POST /moderation/news/delete', 'POST /moderation/streams/delete', 'POST /moderation/chat/delete', 'POST /moderation/chat/ban', 'GET /moderation/authors'];
  if (![...adminRoutes, 'GET /account', 'POST /streams'].includes(route)) return json({ error: 'not_found' }, 404);
  const user = await verifyToken(bearer(request), room.env.TOKEN_SECRET, now);
  if (!user || !steamIdPattern.test(user.sid)) return json({ error: 'unauthorized' }, 401);
  const admin = isAdmin(user);
  if (adminRoutes.includes(route) && !admin) return json({ error: 'forbidden' }, 403);
  if (route === 'GET /account') return json({ admin });
  if (route === 'GET /moderation/authors') {
    const after = url.searchParams.get('after') ?? '';
    if (after && !steamIdPattern.test(after)) return json({ error: 'bad_request' }, 400);
    const entries = await db.list({ prefix: 'author:', ...(after ? { start: `author:${after}\0` } : {}), limit: 101 });
    const authors = [];
    for (const author of [...entries.values()].slice(0,100)) {
      const until = await db.get(`ban:${author.steamId}`);
      authors.push({ ...author, bannedUntil: until > now ? until : null });
    }
    return json({ authors, next: entries.size > 100 ? authors.at(-1).steamId : null });
  }
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad_request' }, 400);
  if (route === 'POST /moderation/chat/delete') {
    if (!Number.isSafeInteger(body.seq) || body.seq < 1) return json({ error: 'bad_request' }, 400);
    await db.delete(msgKey(body.seq));
    return json({ ok: true });
  }
  if (route === 'POST /moderation/chat/ban') {
    if (typeof body.steamId !== 'string' || !steamIdPattern.test(body.steamId) || !Number.isInteger(body.minutes) || body.minutes < 0 || body.minutes > 525600) return json({ error: 'bad_request' }, 400);
    if (!await db.get(`author:${body.steamId}`)) return json({ error: 'not_found' }, 404);
    if (body.minutes) await db.put(`ban:${body.steamId}`, now + body.minutes * 60000);
    else await db.delete(`ban:${body.steamId}`);
    return json({ ok: true });
  }
  const isNews = route.includes('/news');
  const key = isNews ? 'community:news' : 'community:streams';
  const edit = async (tx) => {
    const items = (await tx.get(key)) ?? [];
    if (route.startsWith('POST /moderation/')) {
      if (typeof body.id !== 'string' || !uuidPattern.test(body.id)) return json({ error: 'bad_request' }, 400);
      await tx.put(key, items.filter((i) => i.id !== body.id));
      return json({ ok: true });
    }
    const title = cleanText(body.title, 100);
    let item;
    if (isNews) {
      const text = newsText(body.text);
      if (!title || !text) return json({ error: 'bad_request' }, 400);
      item = { title, text };
    } else {
      const link = videoLink(body.url);
      if (!link) return json({ error: 'bad_video_url' }, 400);
      if (items.some((i) => i.url === link)) return json({ error: 'duplicate_stream' }, 409);
      if ((await tx.get(`stream-rate:${user.sid}`) ?? -60000) + 60000 > now) return json({ error: 'stream_rate_limited' }, 429);
      await tx.put(`stream-rate:${user.sid}`, now);
      item = { title: title || link, url: link, author: cleanText(user.name, 32) || 'Игрок' };
    }
    const updated = [{ ...item, id: crypto.randomUUID(), addedAt: now }, ...items].slice(0, isNews ? 20 : 50);
    while (new TextEncoder().encode(JSON.stringify(updated)).byteLength > 110000) updated.pop();
    await tx.put(key, updated);
    return json({ ok: true }, 201);
  };
  return db.transaction ? db.transaction(edit) : edit(db);
}
