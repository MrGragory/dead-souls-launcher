'use strict';

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const DAYZ_APP_ID = '221100';
const STATE_FULLY_INSTALLED = 4;
const STEAM_API_URL = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const PACKAGE_FILE = /\.(pbo|bisign)$/i;
const FUTURE_TOLERANCE_S = 300;

function queryRegistry(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      const match = error ? null : stdout.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`));
      resolve(match ? match[1].trim() : null);
    });
  });
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function unescapeVdf(text) {
  return text.replace(/\\(.)/g, (_, char) => (char === 'n' ? '\n' : char === 't' ? '\t' : char));
}

function parseVdf(text) {
  const tokens = [];
  const pattern = /"((?:\\.|[^"\\])*)"|([{}])/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    tokens.push(match[2] ?? unescapeVdf(match[1]));
  }
  let pos = 0;
  const readBlock = () => {
    const block = {};
    while (pos < tokens.length) {
      const key = tokens[pos++];
      if (key === '}') break;
      const value = tokens[pos++];
      if (value === '{') block[key] = readBlock();
      else if (value === undefined || value === '}') break;
      else block[key] = value;
    }
    return block;
  };
  return readBlock();
}

async function findSteamPath({ registry = queryRegistry, env = process.env } = {}) {
  const candidates = [
    await registry('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    await registry('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Steam'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Steam'),
  ];
  for (const candidate of candidates) {
    if (candidate && (await exists(path.join(candidate, 'steam.exe')))) return path.resolve(candidate);
  }
  return null;
}

async function libraryPaths(steamPath) {
  const candidates = [steamPath];
  const vdf = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  if (await exists(vdf)) {
    const root = parseVdf(await fs.readFile(vdf, 'utf8'));
    const folders = root.libraryfolders ?? root.LibraryFolders ?? {};
    for (const [key, value] of Object.entries(folders)) {
      const libraryPath = typeof value === 'string' ? value : value.path;
      if (/^\d+$/.test(key) && libraryPath) candidates.push(libraryPath);
    }
  }
  const seen = new Set();
  const libraries = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const key = resolved.toLowerCase();
    if (seen.has(key) || !(await exists(path.join(resolved, 'steamapps')))) continue;
    seen.add(key);
    libraries.push(resolved);
  }
  return libraries;
}

async function findDayz(libraries) {
  for (const library of libraries) {
    const manifest = path.join(library, 'steamapps', `appmanifest_${DAYZ_APP_ID}.acf`);
    if (!(await exists(manifest))) continue;
    const state = parseVdf(await fs.readFile(manifest, 'utf8')).AppState ?? {};
    if ((Number(state.StateFlags) & STATE_FULLY_INSTALLED) === 0) continue;
    const installDir = state.installdir || 'DayZ';
    if (path.basename(installDir) !== installDir) continue;
    const dayzPath = path.join(library, 'steamapps', 'common', installDir);
    if (await exists(path.join(dayzPath, 'DayZ_x64.exe'))) return dayzPath;
  }
  return null;
}

async function discover(settings, { registry = queryRegistry, env = process.env } = {}) {
  const next = { ...settings };
  if (!next.steamPath) next.steamPath = (await findSteamPath({ registry, env })) ?? '';
  const libraries = next.steamPath ? await libraryPaths(next.steamPath) : [];
  if (!(next.gamePath && (await exists(path.join(next.gamePath, 'DayZ_x64.exe'))))) {
    next.gamePath = (await findDayz(libraries)) ?? next.gamePath;
  }
  if (!(next.workshopSteamApps && (await exists(path.join(next.workshopSteamApps, 'workshop', `appworkshop_${DAYZ_APP_ID}.acf`))))) {
    for (const library of libraries) {
      const steamapps = path.join(library, 'steamapps');
      if (await exists(path.join(steamapps, 'workshop', `appworkshop_${DAYZ_APP_ID}.acf`))) {
        next.workshopSteamApps = steamapps;
        break;
      }
    }
  }
  return next;
}

async function publishedFiles(mods, fetchFn = fetch) {
  const ids = [...new Set(mods.map((mod) => mod.id))];
  const body = new URLSearchParams({ itemcount: String(ids.length) });
  ids.forEach((id, index) => body.append(`publishedfileids[${index}]`, id));
  const response = await fetchFn(STEAM_API_URL, { method: 'POST', body, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Steam API: HTTP ${response.status}`);
  const json = await response.json();
  const files = new Map();
  for (const item of json.response?.publishedfiledetails ?? []) {
    if (item.result !== 1 || Number(item.consumer_app_id) !== Number(DAYZ_APP_ID)) continue;
    files.set(String(item.publishedfileid), {
      updated: Number(item.time_updated),
      title: item.title ?? String(item.publishedfileid),
    });
  }
  return files;
}

async function readWorkshopState(acfPath) {
  const root = parseVdf(await fs.readFile(acfPath, 'utf8')).AppWorkshop;
  if (!root || typeof root !== 'object') throw new Error('Некорректный appworkshop ACF');
  return { installed: root.WorkshopItemsInstalled ?? {}, details: root.WorkshopItemDetails ?? {} };
}

async function listFiles(root, relative = '') {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, rel)));
    } else if (entry.isFile()) {
      const abs = path.join(root, rel);
      const stat = await fs.stat(abs);
      files.push({ rel, abs, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return files;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function sameHashes(a, b) {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && a[key] === b[key]);
}

async function findProblem({ id, folder, steamapps, item, detail, latest, full, cache, nowMs }) {
  const problem = (status, message) => ({ status, message });
  if (!item || !(await exists(folder))) return problem('missing', 'Не установлен — откройте Workshop');
  const downloads = path.join(steamapps, 'workshop', 'downloads', DAYZ_APP_ID, id);
  const temp = path.join(steamapps, 'workshop', 'temp', DAYZ_APP_ID, id);
  if ((await exists(downloads)) || (await exists(temp))) {
    return problem('downloading', 'Есть незавершённая загрузка Steam — дождитесь завершения');
  }
  if (!latest) return problem('unknown', 'Workshop недоступен / мод скрыт / удалён');
  const stamp = Number(item.timeupdated);
  if (!Number.isSafeInteger(stamp) || stamp !== latest.updated) {
    return problem('outdated', 'Редакция не подтверждена — обновите мод через Steam');
  }
  if (stamp > Math.floor(nowMs / 1000) + FUTURE_TOLERANCE_S) return problem('broken', 'Некорректное время установки Steam');
  if (!item.manifest) return problem('broken', 'Нет манифеста установки Steam');
  if (detail?.manifest && detail.manifest !== item.manifest) return problem('pending', 'Steam ещё не применил новую редакцию');
  try {
    const stat = await fs.lstat(folder);
    if (stat.isSymbolicLink()) return problem('broken', 'Ссылка вместо папки мода');
    const files = (await listFiles(folder)).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    if (!files.some((file) => /\.pbo$/i.test(file.rel))) return problem('broken', 'Нет PBO-файлов — проверьте загрузку');
    if (files.some((file) => file.size === 0 && PACKAGE_FILE.test(file.rel))) {
      return problem('broken', 'Обнаружен пустой PBO/подпись');
    }
    const fingerprint = crypto
      .createHash('sha256')
      .update(files.map((file) => `${file.rel}|${file.size}|${Math.trunc(file.mtimeMs)}`).join('\n'))
      .digest('hex');
    const cacheName = `electron-mod-${id}.json`;
    const cached = await cache.read(cacheName);
    const sameManifest = cached !== null && cached.manifest === item.manifest;
    if (sameManifest && cached.fingerprint !== fingerprint) {
      return problem('changed', 'Файлы изменены вне обновления — восстановите мод в Steam');
    }
    let hashes = sameManifest ? cached.hashes : {};
    if (full) {
      const computed = {};
      for (const file of files.filter((entry) => PACKAGE_FILE.test(entry.rel))) {
        computed[file.rel] = await sha256File(file.abs);
      }
      if (sameManifest && Object.keys(hashes).length > 0 && !sameHashes(computed, hashes)) {
        return problem('changed', 'SHA-256 изменился относительно локального кэша — восстановите мод');
      }
      hashes = computed;
    }
    await cache.write(cacheName, { manifest: item.manifest, fingerprint, hashes });
    return null;
  } catch (error) {
    return problem('broken', `Ошибка чтения: ${error.message}`);
  }
}

async function checkMods({ steamapps, mods, full = false, cache, fetchFn = fetch, nowMs = Date.now(), onProgress = () => {} }) {
  const remote = await publishedFiles(mods, fetchFn);
  const acfPath = path.join(steamapps, 'workshop', `appworkshop_${DAYZ_APP_ID}.acf`);
  if (!(await exists(acfPath))) {
    throw new Error('Не найден appworkshop_221100.acf. Выберите папку steamapps с модами DayZ в настройках.');
  }
  const before = await readWorkshopState(acfPath);
  const results = [];
  for (const mod of mods) {
    onProgress(`Проверка: ${mod.name || mod.id}`);
    const folder = path.join(steamapps, 'workshop', 'content', DAYZ_APP_ID, mod.id);
    const verdict = await findProblem({
      id: mod.id,
      folder,
      steamapps,
      item: before.installed[mod.id],
      detail: before.details[mod.id],
      latest: remote.get(mod.id),
      full,
      cache,
      nowMs,
    });
    results.push(
      verdict
        ? { id: mod.id, name: mod.name || mod.id, folder, ready: false, ...verdict }
        : { id: mod.id, name: mod.name || mod.id, folder, ready: true, status: 'ok', message: 'Актуален по метаданным Steam' },
    );
  }
  const after = await readWorkshopState(acfPath);
  const changed = mods.some(
    (mod) => after.installed[mod.id]?.manifest !== before.installed[mod.id]?.manifest,
  );
  if (changed) {
    return results.map((mod) => ({
      ...mod,
      ready: false,
      status: 'pending',
      message: 'Steam изменил установку во время проверки — повторите',
    }));
  }
  return results;
}

function workshopPageUrl(id) {
  if (!/^\d+$/.test(id)) throw new Error('Некорректный Workshop ID');
  return `steam://url/CommunityFilePage/${id}`;
}

module.exports = {
  DAYZ_APP_ID,
  exists,
  parseVdf,
  findSteamPath,
  libraryPaths,
  findDayz,
  discover,
  publishedFiles,
  checkMods,
  workshopPageUrl,
};
