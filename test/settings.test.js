'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { defaultSettings, loadSettings, normalizeProfileName, saveSettings } = require('../src/settings');
const { verifyNews } = require('../src/news');

const testKeys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function signEnvelope(manifest) {
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const signature = crypto.sign('sha256', bytes, {
    key: testKeys.privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return JSON.stringify({ payload: bytes.toString('base64'), signature: signature.toString('base64') });
}

test('nickname normalisation follows the launcher rules', () => {
  assert.equal(normalizeProfileName('  Grinch  '), 'Grinch');
  assert.equal(normalizeProfileName('Выживший 01'), 'Выживший 01');
  assert.equal(normalizeProfileName(''), '');
  assert.equal(normalizeProfileName(null), '');
});

test('nickname rejects forbidden characters, dot-only and names longer than 32', () => {
  for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a<b', 'a>b', 'a|b', 'a"b', 'a\u0000b', '...']) {
    assert.throws(() => normalizeProfileName(bad), undefined, bad);
  }
  assert.throws(() => normalizeProfileName('x'.repeat(33)), /длиннее 32/);
});

test('settings survive a save and load round trip', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsl-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    await saveSettings(file, { ...defaultSettings(), profileName: 'Grinch', highestRevision: 2 });
    const loaded = await loadSettings(file);
    assert.equal(loaded.profileName, 'Grinch');
    assert.equal(loaded.highestRevision, 2);
    assert.deepEqual(await loadSettings(path.join(dir, 'missing.json')), defaultSettings());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('news feed verifies, keeps only https or steam links and caps the list', () => {
  const items = Array.from({ length: 250 }, (_, index) => ({ date: '2026-11-18', title: `n${index}`, text: 't', url: 'https://example.org/' }));
  items[0].url = 'javascript:alert(1)';
  const feed = verifyNews(signEnvelope({ revision: 3, items }), testKeys.publicKey, 1);
  assert.equal(feed.revision, 3);
  assert.equal(feed.items.length, 200);
  assert.equal(feed.items[0].url, '');
  assert.equal(feed.items[1].url, 'https://example.org/');
});

test('news rollback is rejected', () => {
  assert.throws(() => verifyNews(signEnvelope({ revision: 1, items: [] }), testKeys.publicKey, 2), /Откат ленты/);
});
