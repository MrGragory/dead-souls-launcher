'use strict';

const MAX_BYTES = 4_000_000;
const TIMEOUT_MS = 20_000;

async function fetchText(url, { maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS, fetchFn = fetch } = {}) {
  const response = await fetchFn(url, {
    headers: { 'User-Agent': 'DeadSoulsLauncher' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Ответ слишком большой');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Ответ слишком большой');
  return text;
}

module.exports = { fetchText };
