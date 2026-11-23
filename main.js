'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveConfig } = require('./src/config');
const { autoUpdater } = require('electron-updater');
const { RestartPolicy } = require('./src/schedule');
const { queryServer } = require('./src/server');
const { fetchText } = require('./src/http');
const steam = require('./src/steam');
const { assertSteamRunning, launchGame } = require('./src/launch');
const { loadSettings, normalizeProfileName, saveSettings, writeFileAtomic } = require('./src/settings');
const { relayRequest, fetchMessages, loadRelayUrl, loginWithSteam, sendMessage } = require('./src/chat');

const PAGE = path.join(__dirname, 'src', 'renderer', 'index.html');
const ADS_FILE = path.join(__dirname, 'src', 'renderer', 'assets', 'ads', 'ads.json');
const EMBEDDED_CONFIG_FILE = path.join(__dirname, 'config', 'servers.json');
const PUBLIC_KEY_FILE = path.join(__dirname, 'config', 'public-key.pem');
const LAUNCHER_CHAT_ROOM = 'launcher';
const CHAT_CONFIG_FILE = path.join(__dirname, 'config', 'chat.json');
const APP_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DeadSoulsLauncher');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const CONFIG_CACHE_FILE = path.join(APP_DIR, 'config-cache.json');
const LOG_FILE = path.join(APP_DIR, 'launcher.log');
const POLL_INTERVAL_MS = 15_000;
const FRESH_MS = 45_000;

let settings = null;
let config = null;
let configSource = '';
let publicKeyPem = '';
let chatRelayUrl = '';
let ads = { slides: [], intervalMs: 5000 };
let mainWindow = null;
const policies = new Map();
const statuses = new Map();

const modCache = {
  async read(name) {
    try {
      return JSON.parse(await fs.readFile(path.join(APP_DIR, name), 'utf8'));
    } catch {
      return null;
    }
  },
  write(name, value) {
    return writeFileAtomic(path.join(APP_DIR, name), JSON.stringify(value));
  },
};

const ready = initialize();
ready.catch((error) => log(`Initialization failed: ${error.message}`));

async function log(message) {
  try {
    await fs.mkdir(APP_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* a failed log write must not stop the launcher */
  }
}

function isHttps(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isAllowedLink(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'steam:';
  } catch {
    return false;
  }
}

function cleanPath(value) {
  return String(value ?? '').trim().replace(/^"+|"+$/g, '');
}

async function readAds() {
  const raw = JSON.parse(await fs.readFile(ADS_FILE, 'utf8'));
  const slides = (Array.isArray(raw.slides) ? raw.slides : [])
    .slice(0, 20)
    .filter((slide) => isHttps(slide?.url))
    .map((slide) => ({ image: `assets/ads/${path.basename(String(slide.image))}`, url: slide.url }));
  const seconds = Math.min(60, Math.max(2, Number(raw.intervalSeconds) || 5));
  return { slides, intervalMs: seconds * 1000 };
}

async function initialize() {
  settings = await steam.discover(await loadSettings(SETTINGS_FILE));
  publicKeyPem = await fs.readFile(PUBLIC_KEY_FILE, 'utf8');
  const resolved = await resolveConfig({
    fetchText: (url) => fetchText(url),
    cache: {
      read: () => fs.readFile(CONFIG_CACHE_FILE, 'utf8').catch(() => null),
      write: (text) => writeFileAtomic(CONFIG_CACHE_FILE, text),
    },
    embeddedText: await fs.readFile(EMBEDDED_CONFIG_FILE, 'utf8'),
    publicKeyPem,
    highestRevision: settings.highestRevision,
  });
  if (resolved.remoteError) await log(`Remote config: ${resolved.remoteError}`);
  if (resolved.fromRemote) {
    settings.highestRevision = resolved.config.revision;
    await saveSettings(SETTINGS_FILE, settings);
  }
  config = resolved.config;
  configSource = resolved.source;
  ads = await readAds().catch(async (error) => {
    await log(`Ads: ${error.message}`);
    return { slides: [], intervalMs: 5000 };
  });
  chatRelayUrl = await loadRelayUrl(CHAT_CONFIG_FILE).catch(async (error) => {
    await log(`Chat: ${error.message}`);
    return '';
  });
  for (const server of config.servers) policies.set(server.id, new RestartPolicy());
}

function findServer(serverId) {
  const server = config.servers.find((item) => item.id === serverId);
  if (!server) throw new Error('Сервер не найден в конфигурации');
  return server;
}

function publicServer(server) {
  return {
    id: server.id,
    name: server.name,
    map: server.map,
    host: server.host,
    gamePort: server.gamePort,
    description: server.description,
    mods: server.mods,
  };
}

function publicSettings(value) {
  return {
    steamPath: value.steamPath,
    gamePath: value.gamePath,
    workshopSteamApps: value.workshopSteamApps,
    profileName: value.profileName,
    streams: sortedStreams(),
  };
}

function sortedStreams() {
  return [...settings.streams].sort((a, b) => b.addedAt - a.addedAt);
}

function gateFor(server, nowMs) {
  return policies.get(server.id).evaluate(server, nowMs, statuses.get(server.id)?.online === true, false);
}

function liveServer(server, nowMs) {
  const status = statuses.get(server.id) ?? null;
  return {
    id: server.id,
    status,
    gate: gateFor(server, nowMs),
    fresh: status !== null && nowMs - status.checkedAt < FRESH_MS,
  };
}

async function probe(server) {
  const status = await queryServer({ host: server.host, queryPort: server.queryPort });
  const checkedAt = Date.now();
  statuses.set(server.id, { ...status, checkedAt });
  policies.get(server.id).evaluate(server, checkedAt, status.online, true);
  return statuses.get(server.id);
}

async function pollServers() {
  await Promise.all(config.servers.map((server) => probe(server)));
}

async function checkServerMods(server, full) {
  if (!settings.gamePath || !(await steam.exists(path.join(settings.gamePath, 'DayZ_x64.exe')))) {
    throw new Error('Укажите папку установленной DayZ в настройках.');
  }
  if (!settings.workshopSteamApps) {
    throw new Error('Не найдена папка steamapps с модами DayZ. Выберите её в настройках.');
  }
  return steam.checkMods({
    steamapps: settings.workshopSteamApps,
    mods: server.mods,
    full,
    cache: modCache,
    onProgress: (text) => mainWindow?.webContents.send('mods:progress', text),
  });
}

async function openExternal(url) {
  if (!isAllowedLink(url)) throw new Error('Недопустимая ссылка');
  await shell.openExternal(url);
}

const NETWORK_ERROR = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|ERR_NETWORK|ERR_CONNECTION|net::|socket hang up|timeout/i;

function updateErrorText(error) {
  const text = String(error?.message ?? error);
  if (NETWORK_ERROR.test(text)) return 'Нет связи с сервером обновлений. Проверьте подключение к интернету и нажмите «Обновить лаунчер» ещё раз.';
  return `Не удалось обновить лаунчер: ${text}`;
}

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status);
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
// Errors reach the renderer through the rejected update:run promise; without a listener EventEmitter would throw.
autoUpdater.on('error', () => {});
autoUpdater.on('download-progress', (progress) => {
  sendUpdateStatus({ text: `Загрузка обновления: ${Math.floor(progress.percent)}%`, ready: false });
});
autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus({ text: `Версия ${info.version} загружена. Нажмите «Установить и перезапустить».`, ready: true });
});

const CHAT_ERRORS = {
  server_offline: 'Сервер не в сети: сообщение не отправлено.',
  rate_limited: 'Подождите пару секунд и отправьте снова.',
  banned: 'Вам запрещено писать в чат.',
  forbidden: 'Действие доступно только администраторам.',
  bad_request: 'Проверьте заполненные поля.',
  bad_video_url: 'Нужна прямая HTTPS-ссылка на видео или стрим YouTube / VK Видео.',
  duplicate_stream: 'Эта ссылка уже опубликована.',
  stream_rate_limited: 'Следующую ссылку можно опубликовать через минуту.',
  bad_text: 'Пустое сообщение.',
  unauthorized: 'Войдите через Steam заново.',
  network: 'Нет связи с сервером чата.',
  login_timeout: 'Вход через Steam не завершён за 5 минут.',
  http: 'Сервис чата вернул ошибку.',
  invalid_response: 'Сервис чата вернул некорректный ответ.',
  not_found: 'Адрес сервера чата неверный. Проверьте адрес в config/chat.json.',
  bad_params: 'Steam вернул неполный ответ. Нажмите «Войти через Steam» ещё раз.',
  steam_rejected: 'Steam не подтвердил вход. Нажмите «Войти через Steam» ещё раз.',
  stale_login: 'Вход устарел. Нажмите «Войти через Steam» ещё раз.',
  replayed_login: 'Этот вход уже использован. Нажмите «Войти через Steam» ещё раз.',
};

function chatErrorText(error) {
  if (error.code === 'network') return `${CHAT_ERRORS.network} ${networkCode(error.cause)}`.trim();
  const label = CHAT_ERRORS[error.code] ?? 'Ошибка сервиса чата.';
  const code = /^[a-z0-9_-]{1,64}$/i.test(String(error.code ?? '')) ? error.code : 'unknown';
  const ray = /^[a-z0-9-]{1,80}$/i.test(String(error.ray ?? '')) ? `; Ray ${error.ray}` : '';
  return error.status ? `${label} (HTTP ${error.status}; ${code}${ray})` : label;
}

function networkCode(cause) {
  const inner = cause?.cause;
  const code = inner?.code ?? inner?.errors?.[0]?.code ?? cause?.code ?? cause?.name;
  return code ? `(${code})` : '';
}

function requireChatRelay() {
  if (!chatRelayUrl) throw new Error('Чат не настроен: укажите адрес в config/chat.json.');
}

function activeChatSession() {
  const session = settings.chatSession;
  return session && session.expiresAt > Date.now() ? session : null;
}

function chatState() {
  const session = activeChatSession();
  return { configured: chatRelayUrl !== '', loggedIn: session !== null, name: session?.name ?? '' };
}

async function clearChatSession() {
  settings = { ...settings, chatSession: null };
  await saveSettings(SETTINGS_FILE, settings);
}

function registerIpc() {
  ipcMain.handle('app:init', async () => {
    await ready;
    return {
      version: app.getVersion(),
      configSource,
      servers: config.servers.map(publicServer),
      ads,
      settings: publicSettings(settings),
    };
  });

  ipcMain.handle('servers:state', async () => {
    await ready;
    const now = Date.now();
    return { now, servers: config.servers.map((server) => liveServer(server, now)) };
  });

  ipcMain.handle('settings:save', async (_event, input) => {
    await ready;
    settings = await steam.discover({
      ...settings,
      steamPath: cleanPath(input.steamPath),
      gamePath: cleanPath(input.gamePath),
      workshopSteamApps: cleanPath(input.workshopSteamApps),
      profileName: normalizeProfileName(input.profileName),
    });
    await saveSettings(SETTINGS_FILE, settings);
    return publicSettings(settings);
  });

  ipcMain.handle('settings:browse', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle('mods:check', async (_event, { serverId, full }) => {
    await ready;
    return checkServerMods(findServer(serverId), Boolean(full));
  });

  ipcMain.handle('game:play', async (_event, { serverId, profileName }) => {
    await ready;
    const server = findServer(serverId);
    settings = { ...settings, profileName: normalizeProfileName(profileName) };
    await saveSettings(SETTINGS_FILE, settings);
    const before = gateFor(server, Date.now());
    if (before.blocked) return { ok: false, error: before.message };
    await assertSteamRunning();
    const results = await checkServerMods(server, false);
    if (results.some((mod) => !mod.ready)) {
      return {
        ok: false,
        error: 'Выберите проблемный мод, откройте его в Steam, дождитесь загрузки и повторите проверку.',
        results,
      };
    }
    const status = await probe(server);
    const after = gateFor(server, Date.now());
    if (after.blocked) return { ok: false, error: after.message, results };
    if (!status.online) return { ok: false, error: 'Сервер не отвечает или находится на обслуживании', results };
    const pid = await launchGame({ gamePath: settings.gamePath, server, mods: results, profile: settings.profileName });
    await log(`Launched ${server.id} pid=${pid}`);
    return { ok: true, pid, results };
  });

  const actions = {
    account: ['GET', 'account'], news: ['GET', 'news'], publish: ['POST', 'news'],
    deleteNews: ['POST', 'moderation/news/delete'], streams: ['GET', 'streams'],
    addStream: ['POST', 'streams'], deleteStream: ['POST', 'moderation/streams/delete'],
    authors: ['GET', 'moderation/authors'], deleteMessage: ['POST', 'moderation/chat/delete'],
    ban: ['POST', 'moderation/chat/ban'],
  };
  ipcMain.handle('community:request', async (_event, { action, data } = {}) => {
    await ready;
    if (!Object.hasOwn(actions, action)) throw new Error('Неизвестное действие.');
    requireChatRelay();
    const session = activeChatSession();
    if (!session && !['news', 'streams'].includes(action)) throw new Error('Войдите через Steam.');
    const [method, route] = actions[action];
    const query = action === 'authors' && data?.after ? '?' + new URLSearchParams({ after: data.after }) : '';
    try {
      return await relayRequest(chatRelayUrl, `/s/launcher/${route}${query}`, {
        method, token: ['news', 'streams'].includes(action) ? undefined : session?.token,
        body: method === 'POST' ? data : undefined,
      });
    } catch (error) {
      if (error.code === 'unauthorized' && session && activeChatSession() === session) await clearChatSession();
      throw new Error(chatErrorText(error));
    }
  });

  ipcMain.handle('update:run', async () => {
    if (!app.isPackaged) return { message: 'Автообновление работает только в установленной версии лаунчера.' };
    try {
      const check = await autoUpdater.checkForUpdates();
      if (!check?.isUpdateAvailable) return { message: `Установлена актуальная версия ${app.getVersion()}.` };
      await autoUpdater.downloadUpdate();
      return { message: `Версия ${check.updateInfo.version} загружена. Нажмите «Установить и перезапустить».` };
    } catch (error) {
      throw new Error(updateErrorText(error));
    }
  });

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle('chat:state', async () => {
    await ready;
    return chatState();
  });

  ipcMain.handle('chat:login', async () => {
    await ready;
    requireChatRelay();
    try {
      const session = await loginWithSteam({
        relayUrl: chatRelayUrl,
        openExternal: (url) => shell.openExternal(url),
      });
      settings = {
        ...settings,
        chatSession: { token: session.token, steamId: session.steamId, name: session.name, expiresAt: session.expiresAt },
      };
      await saveSettings(SETTINGS_FILE, settings);
    } catch (error) {
      throw new Error(chatErrorText(error));
    }
    return chatState();
  });

  ipcMain.handle('chat:logout', async () => {
    await ready;
    await clearChatSession();
    return chatState();
  });

  ipcMain.handle('chat:fetch', async (_event, { since, latest }) => {
    await ready;
    const session = activeChatSession();
    if (!chatRelayUrl || !session) return { ...chatState(), session: null, online: false, messages: [] };
    try {
      const data = await fetchMessages({
        relayUrl: chatRelayUrl,
        serverId: LAUNCHER_CHAT_ROOM,
        latest: latest === true,
        since: Math.max(0, Math.trunc(Number(since)) || 0),
        token: session.token,
      });
      return { ...chatState(), ...data };
    } catch (error) {
      if (error.code === 'unauthorized') {
        if (activeChatSession() === session) await clearChatSession();
        return { ...chatState(), session: null, online: false, messages: [], error: 'session_expired' };
      }
      throw new Error(chatErrorText(error));
    }
  });

  ipcMain.handle('chat:send', async (_event, { serverId, text }) => {
    await ready;
    requireChatRelay();
    const session = activeChatSession();
    if (!session) throw new Error('Войдите через Steam, чтобы писать в чат.');
    try {
      return await sendMessage({
        relayUrl: chatRelayUrl,
        serverId: LAUNCHER_CHAT_ROOM,
        text: String(text ?? ''),
        token: session.token,
      });
    } catch (error) {
      throw new Error(chatErrorText(error));
    }
  });

  ipcMain.handle('shell:open', (_event, url) => openExternal(url));

  ipcMain.handle('steam:workshop', (_event, id) => openExternal(steam.workshopPageUrl(String(id))));

  ipcMain.handle('steam:downloads', () => openExternal('steam://nav/downloads'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1190,
    height: 880,
    useContentSize: true,
    minWidth: 1000,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: '#070a08',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedLink(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (isAllowedLink(url)) shell.openExternal(url);
  });
  mainWindow.loadFile(PAGE);
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  ready.then(() => {
    pollServers();
    setInterval(() => {
      pollServers();
    }, POLL_INTERVAL_MS);
  }, () => {});
});

app.on('window-all-closed', () => app.quit());
