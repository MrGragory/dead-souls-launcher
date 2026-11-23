'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildLaunchArgs, launchGame } = require('../src/launch');

const server = { host: '109.248.4.14', gamePort: 2308, mods: [{ id: '1' }, { id: '2' }] };
const readyMods = [
  { id: '1', folder: path.resolve('/games/mod1'), ready: true },
  { id: '2', folder: path.resolve('/games/mod2'), ready: true },
];

function fakeSpawn(calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    setImmediate(() => child.emit('spawn'));
    return child;
  };
}

async function gameDir(t, { withLauncher = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsl-game-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  if (withLauncher) await fs.writeFile(path.join(dir, 'DayZ_BE.exe'), '');
  return dir;
}

const images = (...names) => async () => new Set(names);

test('launch arguments follow the official order with the nickname first', () => {
  assert.deepEqual(
    buildLaunchArgs({ profile: 'Grinch', host: '109.248.4.14', gamePort: 2308, folders: ['C:\\a', 'C:\\b'] }),
    ['0', '1', '-exe', 'DayZ_x64.exe', '-name=Grinch', '-connect=109.248.4.14', '-port=2308', '-mod=C:\\a;C:\\b', '-noPause'],
  );
});

test('empty nickname means no -name argument', () => {
  const args = buildLaunchArgs({ profile: '', host: '109.248.4.14', gamePort: 2308, folders: ['C:\\a'] });
  assert.equal(args.some((arg) => arg.startsWith('-name=')), false);
});

test('mod folder with a semicolon or quote is rejected', () => {
  assert.throws(() => buildLaunchArgs({ profile: '', host: '109.248.4.14', gamePort: 2308, folders: ['C:\\a;b'] }), /неподдерживаемый символ/);
});

test('launch needs Steam running and DayZ closed', async (t) => {
  const dir = await gameDir(t);
  await assert.rejects(launchGame({ gamePath: dir, server, mods: readyMods, profile: '', listImages: images('explorer.exe'), spawnFn: fakeSpawn([]) }), /Сначала запустите Steam/);
  await assert.rejects(launchGame({ gamePath: dir, server, mods: readyMods, profile: '', listImages: images('steam.exe', 'dayz_be.exe'), spawnFn: fakeSpawn([]) }), /DayZ уже запущен/);
});

test('launch needs DayZ_BE.exe and all mods ready', async (t) => {
  const empty = await gameDir(t, { withLauncher: false });
  await assert.rejects(launchGame({ gamePath: empty, server, mods: readyMods, profile: '', listImages: images('steam.exe'), spawnFn: fakeSpawn([]) }), /Не найден DayZ_BE.exe/);
  const dir = await gameDir(t);
  const notReady = [readyMods[0], { ...readyMods[1], ready: false }];
  await assert.rejects(launchGame({ gamePath: dir, server, mods: notReady, profile: '', listImages: images('steam.exe'), spawnFn: fakeSpawn([]) }), /Не все моды проверены/);
});

test('successful launch starts DayZ_BE.exe with game args and returns the pid', async (t) => {
  const dir = await gameDir(t);
  const calls = [];
  const pid = await launchGame({ gamePath: dir, server, mods: readyMods, profile: 'Grinch', listImages: images('steam.exe'), spawnFn: fakeSpawn(calls) });
  assert.equal(pid, 4242);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, path.join(dir, 'DayZ_BE.exe'));
  assert.equal(calls[0].options.cwd, dir);
  assert.deepEqual(calls[0].args.slice(0, 5), ['0', '1', '-exe', 'DayZ_x64.exe', '-name=Grinch']);
  assert.equal(calls[0].args.at(-1), '-noPause');
});
