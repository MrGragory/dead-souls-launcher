const enc = new TextEncoder();
const dec = new TextDecoder();
const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const RETURN_TO = /^http:\/\/127\.0\.0\.1:\d{1,5}\/steam-return$/;
const NONCE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z/;
const NONCE_WINDOW_MS = 10 * 60 * 1000;

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const base = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base + '='.repeat((4 - (base.length % 4)) % 4)), (char) => char.charCodeAt(0));
}

function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signToken(claims, secret) {
  const body = toBase64Url(enc.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyToken(token, secret, now) {
  const [body, signature, extra] = String(token ?? '').split('.');
  if (!body || !signature || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64Url(signature), enc.encode(body));
    if (!valid) return null;
    const claims = JSON.parse(dec.decode(fromBase64Url(body)));
    return claims.exp > now ? claims : null;
  } catch {
    return null;
  }
}

async function personaName(steamId, fetchFn) {
  try {
    const xml = await (await fetchFn(`https://steamcommunity.com/profiles/${steamId}/?xml=1`)).text();
    const match = /<steamID><!\[CDATA\[([^\]]{1,64})\]\]><\/steamID>/.exec(xml);
    return match ? match[1] : steamId;
  } catch {
    return steamId;
  }
}

export async function verifySteamLogin(params, { storage, now, fetchFn = fetch }) {
  if (!params || typeof params !== 'object') return { ok: false, error: 'bad_params' };
  const field = (name) => (typeof params[`openid.${name}`] === 'string' ? params[`openid.${name}`] : '');
  const claimed = field('claimed_id');
  const match = CLAIMED_ID.exec(claimed);
  if (
    field('ns') !== OPENID_NS ||
    field('mode') !== 'id_res' ||
    field('op_endpoint') !== STEAM_OPENID ||
    !match ||
    field('identity') !== claimed ||
    !RETURN_TO.test(field('return_to'))
  ) {
    return { ok: false, error: 'bad_params' };
  }
  const nonce = field('response_nonce');
  const stamp = NONCE.exec(nonce);
  if (!stamp) return { ok: false, error: 'bad_params' };
  if (Math.abs(Date.parse(`${stamp[1]}Z`) - now) > NONCE_WINDOW_MS) return { ok: false, error: 'stale_login' };
  if (await storage.get(`nonce:${nonce}`)) return { ok: false, error: 'replayed_login' };
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith('openid.') && typeof value === 'string') form.set(key, value);
  }
  form.set('openid.mode', 'check_authentication');
  const verdict = await fetchFn(STEAM_OPENID, { method: 'POST', body: form });
  const text = await verdict.text();
  if (!verdict.ok || !text.includes('is_valid:true')) return { ok: false, error: 'steam_rejected' };
  await storage.put(`nonce:${nonce}`, now);
  return { ok: true, steamId: match[1], name: await personaName(match[1], fetchFn) };
}
