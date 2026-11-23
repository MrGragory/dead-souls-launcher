'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const GAME_EXE = 'DayZ_x64.exe';
const LAUNCHER_EXE = 'DayZ_BE.exe';

function runningImages() {
  return new Promise((resolve, reject) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      if (error) {
        reject(new Error('Не удалось проверить запущенные процессы'));
        return;
      }
      const names = stdout.split(/\r?\n/).map((line) => (line.match(/^"([^"]+)"/)?.[1] ?? '').toLowerCase());
      resolve(new Set(names.filter(Boolean)));
    });
  });
}

async function assertSteamRunning(listImages = runningImages) {
  if (!(await listImages()).has('steam.exe')) throw new Error('Сначала запустите Steam и войдите в аккаунт.');
}

async function assertGameNotRunning(listImages) {
  const images = await listImages();
  if (images.has('dayz_x64.exe') || images.has('dayz_be.exe')) {
    throw new Error('DayZ уже запущен. Закройте игру перед подключением.');
  }
}

function buildLaunchArgs({ profile, host, gamePort, folders }) {
  if (folders.some((folder) => folder.includes(';') || folder.includes('"'))) {
    throw new Error('Путь к библиотеке Steam содержит неподдерживаемый символ ; или кавычку.');
  }
  const args = ['0', '1', '-exe', GAME_EXE];
  if (profile) args.push(`-name=${profile}`);
  args.push(`-connect=${host}`, `-port=${gamePort}`, `-mod=${folders.join(';')}`, '-noPause');
  return args;
}

async function launchGame({ gamePath, server, mods, profile, listImages = runningImages, spawnFn = spawn }) {
  await assertSteamRunning(listImages);
  await assertGameNotRunning(listImages);
  const exe = path.join(gamePath, LAUNCHER_EXE);
  try {
    await fs.access(exe);
  } catch {
    throw new Error('Не найден DayZ_BE.exe. Проверьте путь к игре и целостность установки в Steam.');
  }
  if (mods.length !== server.mods.length || mods.some((mod) => !mod.ready)) throw new Error('Не все моды проверены.');
  const args = buildLaunchArgs({
    profile,
    host: server.host,
    gamePort: server.gamePort,
    folders: mods.map((mod) => path.resolve(mod.folder)),
  });
  return new Promise((resolve, reject) => {
    const child = spawnFn(exe, args, { cwd: gamePath, detached: true, stdio: 'ignore' });
    child.once('error', (error) => reject(new Error(`Не удалось запустить игру: ${error.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

module.exports = { GAME_EXE, LAUNCHER_EXE, runningImages, assertSteamRunning, buildLaunchArgs, launchGame };
