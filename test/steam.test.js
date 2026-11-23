'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const steam = require('../src/steam');

async function makeTree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsl-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    if (content === null) {
      await fs.mkdir(target, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  return root;
}

const manifestAcf = (stateFlags, installdir = 'DayZ') =>
  `"AppState"\n{\n\t"appid"\t\t"221100"\n\t"StateFlags"\t\t"${stateFlags}"\n\t"installdir"\t\t"${installdir}"\n}\n`;

function block(items) {
  return Object.entries(items)
    .map(
      ([id, item]) =>
        `\t\t"${id}"\n\t\t{\n\t\t\t"timeupdated"\t\t"${item.timeupdated}"\n\t\t\t"manifest"\t\t"${item.manifest}"\n\t\t}\n`,
    )
    .join('');
}

const workshopAcf = (installed, details = {}) =>
  `"AppWorkshop"\n{\n\t"appid"\t\t"221100"\n\t"WorkshopItemsInstalled"\n\t{\n${block(installed)}\t}\n\t"WorkshopItemDetails"\n\t{\n${block(details)}\t}\n}\n`;

const libraryVdf = (paths) =>
  `"libraryfolders"\n{\n${paths.map((p, i) => `\t"${i}"\n\t{\n\t\t"path"\t\t"${p}"\n\t}\n`).join('')}}\n`;

function memoryCache() {
  const store = new Map();
  return {
    store,
    read: async (name) => store.get(name) ?? null,
    write: async (name, value) => {
      store.set(name, value);
    },
  };
}

function publishedFetch(times) {
  return async (_url, { body }) => {
    const ids = [...body.entries()].filter(([key]) => key.startsWith('publishedfileids')).map(([, value]) => value);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        response: {
          publishedfiledetails: ids.map((id) =>
            id in times
              ? { publishedfileid: id, result: 1, consumer_app_id: 221100, time_updated: times[id], title: `Mod ${id}` }
              : { publishedfileid: id, result: 9 },
          ),
        },
      }),
    };
  };
}

test('parseVdf reads nested blocks and unescapes backslashes', () => {
  const root = steam.parseVdf('"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\t\t"D:\\\\SteamLibrary"\n}\n');
  assert.equal(root.libraryfolders['0'].path, 'C:\\Program Files (x86)\\Steam');
  assert.equal(root.libraryfolders['1'], 'D:\\SteamLibrary');
});

test('findSteamPath prefers the registry, then Program Files, and needs steam.exe', async (t) => {
  const root = await makeTree(t, { 'Registry/Steam/steam.exe': '', 'PF86/Steam/steam.exe': '', 'Stale/Steam/readme.txt': '' });
  const fromRegistry = await steam.findSteamPath({
    registry: async (key) => (key.startsWith('HKCU') ? path.join(root, 'Registry', 'Steam') : null),
    env: {},
  });
  assert.equal(fromRegistry, path.join(root, 'Registry', 'Steam'));
  const fromProgramFiles = await steam.findSteamPath({
    registry: async () => path.join(root, 'Stale', 'Steam'),
    env: { 'ProgramFiles(x86)': path.join(root, 'PF86') },
  });
  assert.equal(fromProgramFiles, path.join(root, 'PF86', 'Steam'));
  assert.equal(await steam.findSteamPath({ registry: async () => null, env: {} }), null);
});

test('findDayz accepts only a fully installed game with DayZ_x64.exe', async (t) => {
  const root = await makeTree(t, {
    'A/steamapps/appmanifest_221100.acf': manifestAcf(2),
    'A/steamapps/common/DayZ': null,
    'B/steamapps/appmanifest_221100.acf': manifestAcf(4),
    'B/steamapps/common/DayZ/DayZ_x64.exe': '',
    'C/steamapps/appmanifest_221100.acf': manifestAcf(4, '..\\escape'),
  });
  const libA = path.join(root, 'A');
  const libB = path.join(root, 'B');
  assert.equal(await steam.findDayz([libA]), null);
  assert.equal(await steam.findDayz([libA, libB]), path.join(libB, 'steamapps', 'common', 'DayZ'));
  assert.equal(await steam.findDayz([path.join(root, 'C')]), null);
});

test('libraryPaths reads both libraryfolders.vdf formats and skips missing folders', async (t) => {
  const root = await makeTree(t, { 'Steam/steamapps': null, 'Games/steamapps': null });
  const steamDir = path.join(root, 'Steam');
  const games = path.join(root, 'Games');
  const vdf = path.join(steamDir, 'steamapps', 'libraryfolders.vdf');
  await fs.writeFile(vdf, libraryVdf([steamDir, games, path.join(root, 'Gone')]));
  assert.deepEqual(await steam.libraryPaths(steamDir), [steamDir, games]);
  await fs.writeFile(vdf, `"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t\t"1"\n\t"1"\t\t"${games}"\n}\n`);
  assert.deepEqual(await steam.libraryPaths(steamDir), [steamDir, games]);
});

test('discover fills Steam, the game and the workshop folder from a second library', async (t) => {
  const root = await makeTree(t, {
    'Steam/steam.exe': '',
    'Steam/steamapps': null,
    'Games/steamapps/appmanifest_221100.acf': manifestAcf(4),
    'Games/steamapps/common/DayZ/DayZ_x64.exe': '',
    'Games/steamapps/workshop/appworkshop_221100.acf': workshopAcf({}),
  });
  const steamDir = path.join(root, 'Steam');
  const games = path.join(root, 'Games');
  await fs.writeFile(path.join(steamDir, 'steamapps', 'libraryfolders.vdf'), libraryVdf([steamDir, games]));
  const empty = { steamPath: '', gamePath: '', workshopSteamApps: '', highestRevision: 0, profileName: '', streams: [] };
  const result = await steam.discover(empty, { registry: async () => steamDir, env: {} });
  assert.equal(result.steamPath, steamDir);
  assert.equal(result.gamePath, path.join(games, 'steamapps', 'common', 'DayZ'));
  assert.equal(result.workshopSteamApps, path.join(games, 'steamapps'));
});

test('publishedFiles keeps only DayZ items with result 1', async () => {
  const files = await steam.publishedFiles([{ id: '1' }, { id: '2' }, { id: '3' }], publishedFetch({ 1: 100, 2: 200 }));
  assert.deepEqual([...files.keys()].sort(), ['1', '2']);
  assert.equal(files.get('2').updated, 200);
});

test('checkMods classifies installed, outdated, missing, broken, downloading and unknown mods', async (t) => {
  const steamapps = await makeTree(t, {
    'steamapps/workshop/appworkshop_221100.acf': workshopAcf(
      {
        1000000001: { timeupdated: 1000, manifest: 'm1' },
        1000000002: { timeupdated: 900, manifest: 'm2' },
        1000000004: { timeupdated: 1000, manifest: 'm4' },
        1000000005: { timeupdated: 1000, manifest: 'm5' },
        1000000006: { timeupdated: 1000, manifest: 'm6' },
        1000000007: { timeupdated: 1000, manifest: 'm7' },
        1000000008: { timeupdated: 1000, manifest: 'm8' },
      },
      { 1000000007: { manifest: 'other' } },
    ),
    'steamapps/workshop/content/221100/1000000001/addons/a.pbo': 'data',
    'steamapps/workshop/content/221100/1000000002/addons/b.pbo': 'data',
    'steamapps/workshop/content/221100/1000000004/readme.txt': 'text',
    'steamapps/workshop/content/221100/1000000005/addons/c.pbo': 'data',
    'steamapps/workshop/downloads/221100/1000000005': null,
    'steamapps/workshop/content/221100/1000000006/addons/d.pbo': 'data',
    'steamapps/workshop/content/221100/1000000007/addons/e.pbo': 'data',
    'steamapps/workshop/content/221100/1000000008/addons/f.pbo': '',
  });
  const mods = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: `100000000${n}`, name: `Mod ${n}` }));
  const remote = publishedFetch({ 1000000001: 1000, 1000000002: 1000, 1000000004: 1000, 1000000005: 1000, 1000000007: 1000, 1000000008: 1000 });
  const results = await steam.checkMods({
    steamapps: path.join(steamapps, 'steamapps'),
    mods,
    cache: memoryCache(),
    fetchFn: remote,
    nowMs: 2_000_000_000_000,
  });
  const statuses = Object.fromEntries(results.map((r) => [r.id, r.status]));
  assert.deepEqual(statuses, {
    1000000001: 'ok',
    1000000002: 'outdated',
    1000000003: 'missing',
    1000000004: 'broken',
    1000000005: 'downloading',
    1000000006: 'unknown',
    1000000007: 'pending',
    1000000008: 'broken',
  });
  assert.equal(results.find((r) => r.id === '1000000001').ready, true);
  assert.equal(results.filter((r) => r.ready).length, 1);
});

test('checkMods reports changed files compared with the previous check', async (t) => {
  const root = await makeTree(t, {
    'steamapps/workshop/appworkshop_221100.acf': workshopAcf({ 1000000001: { timeupdated: 1000, manifest: 'm1' } }),
    'steamapps/workshop/content/221100/1000000001/addons/a.pbo': 'data',
  });
  const cache = memoryCache();
  const options = { steamapps: path.join(root, 'steamapps'), mods: [{ id: '1000000001', name: 'A' }], cache, fetchFn: publishedFetch({ 1000000001: 1000 }), nowMs: 2_000_000_000_000 };
  assert.equal((await steam.checkMods(options))[0].ready, true);
  await fs.writeFile(path.join(root, 'steamapps/workshop/content/221100/1000000001/addons/a.pbo'), 'modified content');
  const [again] = await steam.checkMods(options);
  assert.equal(again.status, 'changed');
});

test('full check stores SHA-256 for PBO and signature files', async (t) => {
  const root = await makeTree(t, {
    'steamapps/workshop/appworkshop_221100.acf': workshopAcf({ 1000000001: { timeupdated: 1000, manifest: 'm1' } }),
    'steamapps/workshop/content/221100/1000000001/addons/a.pbo': 'data',
    'steamapps/workshop/content/221100/1000000001/addons/a.bisign': 'sign',
  });
  const cache = memoryCache();
  const [result] = await steam.checkMods({ steamapps: path.join(root, 'steamapps'), mods: [{ id: '1000000001', name: 'A' }], full: true, cache, fetchFn: publishedFetch({ 1000000001: 1000 }), nowMs: 2_000_000_000_000 });
  assert.equal(result.ready, true);
  const hashes = cache.store.get('electron-mod-1000000001.json').hashes;
  assert.deepEqual(Object.keys(hashes).sort(), ['addons/a.bisign', 'addons/a.pbo'].map((p) => p.split('/').join(path.sep)).sort());
  for (const digest of Object.values(hashes)) assert.match(digest, /^[0-9a-f]{64}$/);
});

test('workshopPageUrl accepts only numeric IDs', () => {
  assert.equal(steam.workshopPageUrl('3813439703'), 'steam://url/CommunityFilePage/3813439703');
  assert.throws(() => steam.workshopPageUrl('12;evil'), /Некорректный Workshop ID/);
});
