'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const PROFILE_MAX_LENGTH = 32;
const PROFILE_FORBIDDEN = /[<>:"|?*/\\\x00-\x1f\x7f-\x9f]/;

function defaultSettings() {
  return { steamPath: '', gamePath: '', workshopSteamApps: '', highestRevision: 0, profileName: '', streams: [], chatSession: null };
}

function normalizeProfileName(raw) {
  const value = (raw ?? '').trim();
  if (value.length === 0) return '';
  if (value.length > PROFILE_MAX_LENGTH) throw new Error(`Ник длиннее ${PROFILE_MAX_LENGTH} символов.`);
  if (value.replace(/^\.+|\.+$/g, '').length === 0) throw new Error('Ник не может состоять только из точек.');
  const forbidden = [...value].find((char) => PROFILE_FORBIDDEN.test(char));
  if (forbidden !== undefined) throw new Error(`Ник содержит недопустимый символ: ${forbidden}`);
  return value;
}

function safeProfileName(raw) {
  try {
    return normalizeProfileName(raw);
  } catch {
    return '';
  }
}

function normalizeStream(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.url !== 'string') return null;
  return { id: raw.id, title: raw.title, url: raw.url, addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : 0 };
}

function normalizeChatSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.token !== 'string' || typeof raw.steamId !== 'string' || typeof raw.name !== 'string') return null;
  if (!Number.isFinite(raw.expiresAt)) return null;
  return { token: raw.token, steamId: raw.steamId, name: raw.name, expiresAt: raw.expiresAt };
}

function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    steamPath: text(raw.steamPath),
    gamePath: text(raw.gamePath),
    workshopSteamApps: text(raw.workshopSteamApps),
    highestRevision: Number.isSafeInteger(raw.highestRevision) && raw.highestRevision >= 0 ? raw.highestRevision : 0,
    profileName: safeProfileName(raw.profileName),
    streams: Array.isArray(raw.streams) ? raw.streams.map(normalizeStream).filter(Boolean) : [],
    chatSession: normalizeChatSession(raw.chatSession),
  };
}

async function writeFileAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

async function loadSettings(file) {
  try {
    return normalizeSettings(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return defaultSettings();
  }
}

function saveSettings(file, settings) {
  return writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}

module.exports = {
  defaultSettings,
  normalizeSettings,
  normalizeProfileName,
  loadSettings,
  saveSettings,
  writeFileAtomic,
};
