'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseConfig, resolveConfig, verifyConfig, verifyPayload } = require('../src/config');

const ROOT = path.join(__dirname, '..');
const publicKeyPem = fs.readFileSync(path.join(ROOT, 'config', 'public-key.pem'), 'utf8');
const signedText = fs.readFileSync(path.join(ROOT, 'docs', 'config.signed.json'), 'utf8');
const embeddedText = fs.readFileSync(path.join(ROOT, 'config', 'servers.json'), 'utf8');
const NOW = Date.parse('2026-11-18T12:00:00Z');

const testKeys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function signEnvelope(manifest, privateKey = testKeys.privateKey) {
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const signature = crypto.sign('sha256', bytes, {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return JSON.stringify({ payload: bytes.toString('base64'), signature: signature.toString('base64') });
}

function manifest(overrides = {}) {
  return { ...JSON.parse(embeddedText), ...overrides };
}

const noCache = { read: async () => null, write: async () => {} };

test('signed config from docs verifies with the repo public key', () => {
  const config = verifyConfig(signedText, publicKeyPem, { minRevision: 1, nowMs: NOW });
  assert.equal(config.revision, 2);
  assert.equal(config.servers.length, 2);
  const aibot = config.servers[1];
  assert.equal(aibot.host, '109.248.4.14');
  assert.equal(aibot.gamePort, 2308);
  assert.equal(aibot.queryPort, 2309);
  assert.equal(aibot.mods.length, 6);
  assert.equal(aibot.mods[0].id, '3813439703');
  assert.equal(config.servers[0].mods.length, 24);
});

test('config signed with another key is rejected', () => {
  const envelope = signEnvelope(manifest());
  assert.throws(() => verifyConfig(envelope, publicKeyPem, { minRevision: 1, nowMs: NOW }), /Неверная подпись/);
});

test('payload changed after signing is rejected', () => {
  const signed = JSON.parse(signEnvelope(manifest({ revision: 3 })));
  const forged = JSON.stringify({ ...signed, payload: Buffer.from(JSON.stringify(manifest({ revision: 4 }))).toString('base64') });
  assert.throws(() => verifyPayload(forged, testKeys.publicKey), /Неверная подпись/);
});

test('revision rollback and expired manifest are rejected', () => {
  const envelope = signEnvelope(manifest());
  assert.throws(() => verifyConfig(envelope, testKeys.publicKey, { minRevision: 3, nowMs: NOW }), /Откат ревизии/);
  assert.throws(
    () => verifyConfig(envelope, testKeys.publicKey, { minRevision: 1, nowMs: Date.parse('2030-01-01T00:00:00Z') }),
    /просрочен/,
  );
});

test('invalid server address and restart schedule are rejected', () => {
  const badHost = manifest();
  badHost.servers[0].host = 'example.com';
  assert.throws(() => parseConfig(Buffer.from(JSON.stringify(badHost))), /Некорректный адрес сервера/);
  const badHours = manifest();
  badHours.servers[0].restartHoursMsk = [25];
  assert.throws(() => parseConfig(Buffer.from(JSON.stringify(badHours))), /Некорректное расписание/);
});

test('duplicate or non-numeric Workshop IDs are rejected', () => {
  const duplicate = manifest();
  duplicate.servers[1].mods.push({ id: duplicate.servers[1].mods[0].id, name: 'copy' });
  assert.throws(() => parseConfig(Buffer.from(JSON.stringify(duplicate))), /Некорректные Workshop ID/);
  const text = manifest();
  text.servers[1].mods[0].id = 'abc';
  assert.throws(() => parseConfig(Buffer.from(JSON.stringify(text))), /Некорректные Workshop ID/);
});

test('embedded config is used when GitHub and cache are unavailable', async () => {
  const result = await resolveConfig({
    fetchText: async () => {
      throw new Error('HTTP 404');
    },
    cache: noCache,
    embeddedText,
    publicKeyPem,
    highestRevision: 0,
    nowMs: NOW,
  });
  assert.equal(result.fromRemote, false);
  assert.equal(result.config.revision, 2);
  assert.match(result.source, /Встроенная конфигурация/);
  assert.equal(result.remoteError, 'HTTP 404');
});

test('fallback is refused below the highest accepted revision', async () => {
  await assert.rejects(
    resolveConfig({
      fetchText: async () => {
        throw new Error('HTTP 404');
      },
      cache: noCache,
      embeddedText,
      publicKeyPem,
      highestRevision: 5,
      nowMs: NOW,
    }),
    /Нет действительной конфигурации/,
  );
});

test('verified remote config is cached and reused when GitHub is offline', async () => {
  let stored = null;
  const cache = {
    read: async () => stored,
    write: async (text) => {
      stored = text;
    },
  };
  const remote = await resolveConfig({
    fetchText: async () => signedText,
    cache,
    embeddedText,
    publicKeyPem,
    highestRevision: 0,
    nowMs: NOW,
  });
  assert.equal(remote.fromRemote, true);
  assert.equal(stored, signedText);
  const offline = await resolveConfig({
    fetchText: async () => {
      throw new Error('offline');
    },
    cache,
    embeddedText,
    publicKeyPem,
    highestRevision: 2,
    nowMs: NOW,
  });
  assert.equal(offline.fromRemote, false);
  assert.match(offline.source, /Подписанный кэш/);
});
