'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const CONFIG_URL = 'https://MrGragory.github.io/dead-souls-launcher/config.signed.json';
const MAX_PAYLOAD_BYTES = 1_000_000;
const PSS_SALT_BYTES = 32;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DEFAULT_RESTART_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

function decodeBase64(text) {
  if (typeof text !== 'string' || !BASE64.test(text)) throw new Error('Неверный формат подписи');
  return Buffer.from(text, 'base64');
}

function verifyPayload(envelopeText, publicKeyPem) {
  const envelope = JSON.parse(envelopeText);
  const payload = decodeBase64(envelope.payload);
  const signature = decodeBase64(envelope.signature);
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error('Манифест слишком большой');
  const valid = crypto.verify(
    'sha256',
    payload,
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: PSS_SALT_BYTES },
    signature,
  );
  if (!valid) throw new Error('Неверная подпись манифеста');
  return payload;
}

const isInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function normalizeServer(raw) {
  return {
    id: raw.id,
    name: raw.name ?? '',
    host: raw.host,
    gamePort: raw.gamePort,
    queryPort: raw.queryPort,
    map: raw.map ?? '',
    description: raw.description ?? '',
    restartHoursMsk: raw.restartHoursMsk ?? DEFAULT_RESTART_HOURS,
    blockMinutes: raw.blockMinutes ?? 5,
    postRestartGuardMinutes: raw.postRestartGuardMinutes ?? 6,
    mods: (raw.mods ?? []).map((mod) => ({ id: mod.id, name: mod.name ?? '' })),
  };
}

function validateConfig(config) {
  if (
    config.schema !== 1 ||
    !isInteger(config.revision, 1, Number.MAX_SAFE_INTEGER) ||
    config.servers.length < 1 ||
    config.servers.length > 20 ||
    Number.isNaN(Date.parse(config.validUntilUtc))
  ) {
    throw new Error('Неверная схема конфигурации');
  }
  for (const server of config.servers) {
    if (net.isIP(server.host) === 0 || !isInteger(server.gamePort, 1, 65535) || !isInteger(server.queryPort, 1, 65535)) {
      throw new Error('Некорректный адрес сервера');
    }
    if (
      server.restartHoursMsk.length === 0 ||
      !server.restartHoursMsk.every((hour) => isInteger(hour, 0, 23)) ||
      !isInteger(server.blockMinutes, 1, 30) ||
      !isInteger(server.postRestartGuardMinutes, 1, 30)
    ) {
      throw new Error('Некорректное расписание');
    }
    const ids = server.mods.map((mod) => mod.id);
    if (
      server.mods.length < 1 ||
      server.mods.length > 150 ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) => typeof id === 'string' && /^\d+$/.test(id))
    ) {
      throw new Error('Некорректные Workshop ID');
    }
  }
}

function parseConfig(payload) {
  const raw = JSON.parse(payload.toString('utf8'));
  const config = {
    schema: raw.schema,
    revision: raw.revision,
    validUntilUtc: raw.validUntilUtc,
    name: raw.name ?? 'Dead Souls',
    discord: raw.discord ?? '',
    servers: (raw.servers ?? []).map(normalizeServer),
  };
  validateConfig(config);
  return config;
}

function verifyConfig(envelopeText, publicKeyPem, { minRevision, nowMs }) {
  const config = parseConfig(verifyPayload(envelopeText, publicKeyPem));
  if (config.revision < minRevision) throw new Error('Откат ревизии запрещён');
  if (Date.parse(config.validUntilUtc) <= nowMs) throw new Error('Манифест просрочен');
  return config;
}

async function resolveConfig({ fetchText, cache, embeddedText, publicKeyPem, highestRevision, nowMs = Date.now() }) {
  const embedded = parseConfig(Buffer.from(embeddedText, 'utf8'));
  const minRevision = Math.max(highestRevision, embedded.revision);
  let remoteError = null;
  try {
    const text = await fetchText(CONFIG_URL);
    const config = verifyConfig(text, publicKeyPem, { minRevision, nowMs });
    await cache.write(text);
    return { config, source: 'GitHub Pages • подпись проверена', fromRemote: true, remoteError };
  } catch (error) {
    remoteError = error.message;
  }
  const cached = await cache.read();
  if (cached !== null) {
    try {
      const config = verifyConfig(cached, publicKeyPem, { minRevision, nowMs });
      return { config, source: 'Подписанный кэш • GitHub недоступен', fromRemote: false, remoteError };
    } catch (error) {
      remoteError = `${remoteError}; кэш: ${error.message}`;
    }
  }
  if (minRevision > embedded.revision) {
    throw new Error('Нет действительной конфигурации последней принятой ревизии. Восстановите доступ к GitHub Pages.');
  }
  return {
    config: embedded,
    source: 'Встроенная конфигурация • GitHub Pages ещё не опубликован или недоступен',
    fromRemote: false,
    remoteError,
  };
}

module.exports = { CONFIG_URL, verifyPayload, parseConfig, verifyConfig, resolveConfig };
