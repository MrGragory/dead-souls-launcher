(function () {
  'use strict';

  const api = window.launcher;
  const $ = (id) => document.getElementById(id);
  const CHAT_SERVER_ID = 'launcher';
  const CHAT_POLL_MS = 4_000;
  const TICK_MS = 1_000;
  const FEED_REFRESH_MS = 10_000;
  const MOD_VIEW = {
    ok: ['st ok', 'Актуален'],
    missing: ['st warn', 'Не установлен'],
    outdated: ['st warn', 'Устарел'],
    downloading: ['st warn', 'Загрузка в Steam'],
    pending: ['st warn', 'Ждёт Steam'],
    broken: ['st warn', 'Повреждён'],
    changed: ['st warn', 'Изменён'],
    unknown: ['st warn', 'Workshop недоступен'],
    unchecked: ['st', 'Не проверен'],
  };

  const state = {
    init: null,
    cards: [],
    live: [],
    now: 0,
    selected: 0,
    results: null,
    busy: false,
    updateReady: false,
    chat: { configured: false, loggedIn: false, name: '', online: false, session: null, since: 0, messages: [], polling: false, notice: '', pollError: '' },
  };
  const feedsBusy = new Set();
  let admin = false;
  let moderationOn = false;
  let authVersion = 0;
  let accountBusy = false;
  let authorCursor = null;
  let moderationBusy = false;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, className, onClick) => {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  };
  const errorText = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const showMessage = (text) => { $('message').textContent = text; };
  const fail = (error) => showMessage(errorText(error));
  const community = (action, data) => api.community({ action, data });
  const openModal = (id) => $(id).classList.add('active');
  const closeModal = (id) => $(id).classList.remove('active');
  const openUrl = (url) => api.openUrl(url).catch(fail);
  const openWorkshop = (id) => api.openWorkshop(id).catch(fail);
  const formatLocal = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const formatCountdown = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = String(Math.floor(total / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const seconds = String(total % 60).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  };

  function showTab(name) {
    document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item.dataset.tab === name));
    document.querySelectorAll('.tab-view').forEach((view) => view.classList.toggle('active', view.id === `tab-${name}`));
    refreshVisibleFeed();
  }

  function switchRule(name) {
    document.querySelectorAll('[data-rule]').forEach((item) => item.classList.toggle('active', item.dataset.rule === name));
    document.querySelectorAll('.rule-text').forEach((item) => item.classList.toggle('active', item.id === `rule-${name}`));
  }

  function refreshVisibleFeed() {
    if ($('tab-home').classList.contains('active')) loadNews();
    if ($('tab-streams').classList.contains('active')) loadStreams();
  }

  function buildServers() {
    const host = $('servers');
    host.replaceChildren();
    host.style.gridTemplateColumns = `repeat(${Math.min(state.init.servers.length, 3)}, 1fr)`;
    state.cards = state.init.servers.map((server, index) => {
      const status = el('div', 'online-status', '● Проверяем…');
      const card = el('div', 'server-card');
      card.append(el('h3', '', server.name), status);
      card.addEventListener('click', () => selectServer(index));
      host.append(card);
      return { card, status };
    });
  }

  function selectServer(index) {
    state.selected = index;
    state.results = null;
    state.cards.forEach((item, position) => item.card.classList.toggle('active', position === index));
    renderMods();
    renderLive();
  }

  function renderCard(index, live) {
    const { status } = state.cards[index];
    const data = live.status;
    status.classList.toggle('offline', data !== null && !data.online);
    if (data === null) status.textContent = '● Проверяем…';
    else if (data.online) status.textContent = `● Онлайн · ${data.players}/${data.maxPlayers} · ${data.ping} мс`;
    else status.textContent = '● Не отвечает / обслуживание';
  }

  function renderLive() {
    if (!state.init || state.live.length === 0) return;
    state.live.forEach((live, index) => renderCard(index, live));
    const live = state.live[state.selected];
    const status = live.status;
    const online = status?.online === true;
    $('tilePing').textContent = online ? `${status.ping} мс` : '—';
    $('tileRestart').textContent = formatCountdown(Math.max(0, live.gate.nextUtc - state.now));
    $('tilePlayers').textContent = online ? `${status.players}/${status.maxPlayers}` : '—';
    $('playersCount').textContent = online ? String(status.players) : '—';
    $('inGame').textContent = String(state.live.reduce((sum, item) => sum + (item.status?.online ? item.status.players : 0), 0));
    $('gate').textContent = live.gate.blocked ? live.gate.message : '';
    renderPlay();
  }

  function renderPlay() {
    const live = state.live[state.selected];
    const playable = Boolean(live) && !live.gate.blocked && live.status?.online === true && live.fresh;
    $('playBtn').disabled = state.busy || !playable;
  }

  function modRow(mod) {
    const [className, label] = MOD_VIEW[mod.status] ?? MOD_VIEW.unknown;
    const status = el('span', className, label);
    status.title = mod.message ?? '';
    const row = el('div', 'player-item');
    row.append(el('span', 'player-name', mod.name || mod.id), status);
    if (mod.status !== 'ok' && mod.status !== 'unchecked') row.append(button('Открыть', 'btn-ui mod-open', () => openWorkshop(mod.id)));
    return row;
  }

  function renderMods() {
    const server = state.init.servers[state.selected];
    const rows = state.results ?? server.mods.map((mod) => ({ id: mod.id, name: mod.name, status: 'unchecked', message: '' }));
    $('modRows').replaceChildren(...rows.map(modRow));
    const ready = state.results ? state.results.filter((mod) => mod.ready).length : null;
    $('tileReady').textContent = ready === null ? `—/${server.mods.length}` : `${ready}/${state.results.length}`;
  }

  function setBusy(value) {
    state.busy = value;
    ['sidebarCheck', 'checkUpdate'].forEach((id) => { $(id).disabled = value; });
    renderPlay();
  }

  async function runModCheck() {
    if (state.busy) return;
    const server = state.init.servers[state.selected];
    setBusy(true);
    try {
      const results = await api.checkMods({ serverId: server.id, full: false });
      state.results = results;
      renderMods();
      const good = results.filter((mod) => mod.ready).length;
      showMessage(`${server.name}: проверено ${good}/${results.length}. ` + (good === results.length
        ? 'Актуальность подтверждена по метаданным Steam.'
        : 'Выберите проблемный мод, откройте его в Steam, дождитесь загрузки и повторите проверку.'));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function play() {
    if (state.busy) return;
    const server = state.init.servers[state.selected];
    setBusy(true);
    try {
      const response = await api.play({ serverId: server.id, profileName: $('nick').value });
      if (response.results) {
        state.results = response.results;
        renderMods();
      }
      showMessage(response.ok ? 'DayZ запускается.' : response.error);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  function applyUpdateStatus(status) {
    showMessage(status.text);
    state.updateReady = status.ready;
    $('checkUpdate').textContent = status.ready ? 'Установить и перезапустить' : 'Обновить лаунчер';
  }

  async function checkUpdate() {
    if (state.busy) return;
    if (state.updateReady) {
      api.installUpdate().catch(fail);
      return;
    }
    setBusy(true);
    try {
      showMessage((await api.checkUpdate()).message);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  function setStatus(node, ok, yes, no) {
    node.textContent = ok ? yes : no;
    node.classList.toggle('bad', !ok);
  }

  function renderGameStatus(settings) {
    setStatus($('steamStatus'), Boolean(settings.steamPath), 'Steam найден', 'Steam не найден');
    setStatus($('dayzStatus'), Boolean(settings.gamePath), 'DayZ установлен', 'DayZ не найдена');
  }

  function fillSettings(settings) {
    $('gamePath').value = settings.gamePath ?? '';
    $('nick').value = settings.profileName ?? '';
    renderGameStatus(settings);
  }

  async function saveSettings(output) {
    output.textContent = '';
    try {
      const saved = await api.saveSettings({
        steamPath: state.init.settings.steamPath,
        gamePath: $('gamePath').value,
        workshopSteamApps: state.init.settings.workshopSteamApps,
        profileName: $('nick').value,
      });
      state.init.settings = saved;
      fillSettings(saved);
      state.results = null;
      renderMods();
      renderPlay();
      output.textContent = 'Настройки сохранены. Выполните проверку модов.';
    } catch (error) {
      output.textContent = errorText(error);
    }
  }

  async function browseGame() {
    try {
      const picked = await api.browse();
      if (!picked) return;
      $('gamePath').value = picked;
      await saveSettings($('settingsMsg'));
    } catch (error) {
      $('settingsMsg').textContent = errorText(error);
    }
  }

  function renderAccount() {
    const { loggedIn, name } = state.chat;
    $('accountStatus').textContent = loggedIn ? `${name || 'В сети'}${admin ? ' · Админ' : ''}` : 'Не в сети';
    $('btn-login').style.display = loggedIn ? 'none' : 'flex';
    $('btn-logout').style.display = loggedIn ? 'flex' : 'none';
    ['btn-login', 'btn-logout'].forEach((id) => { $(id).disabled = accountBusy; });
    $('admin-toggle-wrapper').style.display = admin ? 'flex' : 'none';
    if (!admin) {
      moderationOn = false;
      closeModal('moderationDialog');
    }
    $('adminToggle').checked = moderationOn;
    document.body.classList.toggle('admin-mode', admin && moderationOn);
  }

  function chatHintText() {
    const chat = state.chat;
    if (chat.notice) return chat.notice;
    if (chat.pollError) return chat.pollError;
    if (!chat.configured) return 'Чат не настроен: укажите адрес сервера чата в config/chat.json.';
    if (!chat.loggedIn) return 'Войдите через Steam, чтобы читать историю и писать в чат.';
    if (!chat.online) return 'Нет подтверждённого соединения с сервисом чата.';
    return '';
  }

  function chatLine(message) {
    const line = el('div', 'msg');
    const header = el('div', 'msg-header');
    header.append(el('span', 'author', `${message.name}:`), el('span', 'time', formatLocal(message.time)));
    line.append(header, el('div', 'msg-text', message.text));
    const actions = el('div', 'admin-actions');
    actions.append(button('Удалить', 'btn-admin-sm', () => deleteMessage(message.seq)));
    if (message.steamId) actions.append(button('Заблокировать', 'btn-admin-sm', () => openModeration(message.steamId)));
    line.append(actions);
    return line;
  }

  function renderChat() {
    const chat = state.chat;
    const canWrite = chat.loggedIn && chat.online;
    renderAccount();
    $('chatInput').disabled = !canWrite;
    $('chatSend').disabled = !canWrite;
    $('streamSave').disabled = !chat.loggedIn;
    $('streamAuthHint').hidden = chat.loggedIn;
    $('chatHint').textContent = chatHintText();
    const log = $('chat-container');
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const key = JSON.stringify(chat.messages);
    if (log.dataset.rendered !== key) {
      log.replaceChildren(...chat.messages.map(chatLine));
      log.dataset.rendered = key;
    }
    if (stick) log.scrollTop = log.scrollHeight;
  }

  function resetChat() {
    Object.assign(state.chat, { session: null, since: 0, messages: [], online: false, pollError: '' });
  }

  function applyChatData(data) {
    const chat = state.chat;
    chat.configured = Boolean(data.configured);
    chat.loggedIn = Boolean(data.loggedIn);
    chat.name = data.name ?? '';
    chat.online = Boolean(data.online);
    chat.pollError = '';
    if (data.error === 'session_expired') chat.notice = 'Сессия истекла: войдите через Steam снова.';
    if (!chat.loggedIn) {
      Object.assign(chat, { session: null, since: 0, messages: [] });
      return;
    }
    chat.session = data.session;
    chat.messages = data.messages ?? [];
  }

  async function pollChat() {
    if (state.chat.polling || accountBusy) return;
    const version = authVersion;
    state.chat.polling = true;
    try {
      const data = await api.chatFetch({ since: 0, latest: true });
      if (version !== authVersion) return;
      if (!data.loggedIn) admin = false;
      else if (typeof data.admin === 'boolean') admin = data.admin;
      applyChatData(data);
    } catch (error) {
      if (version === authVersion) {
        state.chat.online = false;
        state.chat.pollError = errorText(error);
      }
    } finally {
      state.chat.polling = false;
      renderChat();
    }
  }

  async function refreshAccount(local, version = authVersion) {
    if (version !== authVersion) return;
    const wasIn = state.chat.loggedIn;
    const wasAdmin = admin;
    Object.assign(state.chat, local);
    if (!local.loggedIn) {
      admin = false;
    } else {
      try {
        const result = await community('account');
        if (version !== authVersion) return;
        admin = result.admin === true;
      } catch {
        if (version !== authVersion) return;
        admin = false;
        const current = await api.chatState();
        if (version !== authVersion) return;
        Object.assign(state.chat, current);
      }
    }
    if (wasIn && !state.chat.loggedIn) resetChat();
    renderChat();
    if (wasAdmin !== admin) refreshVisibleFeed();
  }

  async function toggleAccount() {
    if (accountBusy) return;
    const version = ++authVersion;
    accountBusy = true;
    const wasIn = state.chat.loggedIn;
    if (!wasIn) state.chat.notice = 'Подтвердите вход Steam в браузере…';
    renderChat();
    try {
      const local = await (wasIn ? api.chatLogout() : api.chatLogin());
      resetChat();
      state.chat.notice = '';
      await refreshAccount(local, version);
    } catch (error) {
      state.chat.notice = errorText(error);
    } finally {
      accountBusy = false;
      renderChat();
    }
    await pollChat();
  }

  async function sendChatMessage(event) {
    event.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    state.chat.notice = '';
    $('chatSend').disabled = true;
    try {
      await api.chatSend({ serverId: CHAT_SERVER_ID, text });
      input.value = '';
    } catch (error) {
      state.chat.notice = errorText(error);
    }
    renderChat();
    await pollChat();
  }

  async function deleteMessage(seq) {
    if (!window.confirm('Удалить сообщение у всех?')) return;
    try {
      await community('deleteMessage', { seq });
      await pollChat();
    } catch (error) {
      state.chat.notice = errorText(error);
      renderChat();
    }
  }

  function openModeration(selected = '') {
    if (!admin || !moderationOn) return;
    $('moderationStatus').textContent = '';
    openModal('moderationDialog');
    loadAuthors(false, selected);
  }

  async function loadAuthors(append = false, selected = $('moderationAuthor').value) {
    if (moderationBusy || !admin) return;
    moderationBusy = true;
    const select = $('moderationAuthor');
    try {
      let after = append ? authorCursor : null;
      if (!append) select.replaceChildren();
      do {
        const { authors, next } = await community('authors', { after });
        if (!admin || !$('moderationDialog').classList.contains('active')) return;
        for (const author of authors) {
          const ban = author.bannedUntil ? ` · запрет до ${new Date(author.bannedUntil).toLocaleString('ru-RU')}` : '';
          const option = el('option', '', `${author.name} — ${author.steamId}${ban}`);
          option.value = author.steamId;
          select.append(option);
        }
        authorCursor = after = next;
      } while (selected && after && ![...select.options].some((option) => option.value === selected));
      if ([...select.options].some((option) => option.value === selected)) select.value = selected;
      $('moderationMore').hidden = !authorCursor;
      $('moderationBan').disabled = $('moderationUnban').disabled = !select.value;
      if (!select.value) $('moderationStatus').textContent = 'Пока нет зарегистрированных авторов. Список пополняется новыми сообщениями.';
    } catch (error) {
      $('moderationStatus').textContent = errorText(error);
    } finally {
      moderationBusy = false;
    }
  }

  async function changeBan(unban) {
    const steamId = $('moderationAuthor').value;
    const minutes = unban ? 0 : $('moderationMinutes').valueAsNumber;
    if (!steamId || (!unban && !$('moderationMinutes').reportValidity())) return;
    try {
      await community('ban', { steamId, minutes });
      $('moderationStatus').textContent = unban ? 'Запрет снят.' : 'Запрет установлен.';
      loadAuthors(false, steamId);
    } catch (error) {
      $('moderationStatus').textContent = errorText(error);
    }
  }

  async function loadNews() {
    if (feedsBusy.has('news')) return;
    feedsBusy.add('news');
    try {
      const { items } = await community('news');
      $('news-container').replaceChildren(...(items.length ? items.map(newsCard) : [el('p', 'app-hint', 'Новостей пока нет.')]));
    } catch (error) {
      fail(error);
    } finally {
      feedsBusy.delete('news');
    }
  }

  function newsCard(item) {
    const card = el('div', 'news-card');
    const preview = item.text.length > 160 ? `${item.text.slice(0, 160)}…` : item.text;
    const more = el('a', 'link', 'Подробнее →');
    more.addEventListener('click', () => openNewsDetail(item));
    card.append(el('span', 'tag', 'Новости'), el('h4', '', item.title), el('p', '', preview), more);
    card.append(button('Удалить', 'admin-only-btn', () => deleteNews(item.id)));
    return card;
  }

  function openNewsDetail(item) {
    $('newsDetailTitle').textContent = item.title;
    $('newsDetailMeta').textContent = `Опубликовано: ${new Date(item.addedAt).toLocaleString('ru-RU')}`;
    $('newsDetailText').textContent = item.text;
    openModal('modal-news-detail');
  }

  async function deleteNews(id) {
    if (!window.confirm('Удалить для всех пользователей лаунчера?')) return;
    try {
      await community('deleteNews', { id });
      await loadNews();
    } catch (error) {
      fail(error);
    }
  }

  async function publishNews(event) {
    event.preventDefault();
    const status = $('newsAction');
    status.textContent = '';
    try {
      await community('publish', { title: $('newsTitle').value, text: $('newsText').value });
      event.target.reset();
      closeModal('modal-add-news');
      showMessage('Новость опубликована.');
      await loadNews();
    } catch (error) {
      status.textContent = errorText(error);
    }
  }

  async function loadStreams() {
    if (feedsBusy.has('streams')) return;
    feedsBusy.add('streams');
    try {
      const { items } = await community('streams');
      $('streamList').replaceChildren(...(items.length ? items.map(streamCard) : [el('p', 'app-hint', 'Опубликованных ссылок пока нет.')]));
    } catch (error) {
      fail(error);
    } finally {
      feedsBusy.delete('streams');
    }
  }

  function streamCard(item) {
    const card = el('div', 'stream-card');
    const info = el('div', 'stream-info');
    info.style.flex = '1';
    info.append(el('h4', '', item.title), el('p', '', `Стример: ${item.author}`));
    const watch = button('Смотреть', 'btn-ui', () => openUrl(item.url));
    watch.style.cssText = 'width: auto; padding: 4px 10px; font-size: 11px;';
    const remove = button('Удалить', 'btn-admin-sm admin-only', () => deleteStream(item.id));
    remove.style.cssText = 'position: absolute; top: 10px; right: 10px; margin: 0;';
    card.append(el('div', 'stream-thumb'), info, watch, remove);
    return card;
  }

  async function addStream() {
    const message = $('streamMsg');
    message.textContent = '';
    try {
      await community('addStream', { title: $('streamTitle').value, url: $('streamUrl').value });
      $('streamTitle').value = '';
      $('streamUrl').value = '';
      message.textContent = 'Ссылка опубликована для всех.';
      await loadStreams();
    } catch (error) {
      message.textContent = errorText(error);
    }
  }

  async function deleteStream(id) {
    if (!window.confirm('Удалить для всех пользователей лаунчера?')) return;
    try {
      await community('deleteStream', { id });
      await loadStreams();
    } catch (error) {
      $('streamMsg').textContent = errorText(error);
    }
  }

  function wire() {
    document.querySelectorAll('[data-tab]').forEach((item) => item.addEventListener('click', () => showTab(item.dataset.tab)));
    document.querySelectorAll('[data-rule]').forEach((item) => item.addEventListener('click', () => switchRule(item.dataset.rule)));
    document.querySelectorAll('[data-url]').forEach((item) => item.addEventListener('click', (event) => {
      event.preventDefault();
      openUrl(item.dataset.url);
    }));
    document.querySelectorAll('[data-close]').forEach((item) => item.addEventListener('click', () => closeModal(item.dataset.close)));
    $('btn-login').addEventListener('click', toggleAccount);
    $('btn-logout').addEventListener('click', toggleAccount);
    $('adminToggle').addEventListener('change', (event) => {
      moderationOn = event.target.checked;
      renderAccount();
      renderChat();
    });
    $('checkUpdate').addEventListener('click', checkUpdate);
    $('sidebarCheck').addEventListener('click', runModCheck);
    $('playBtn').addEventListener('click', play);
    $('openAddNews').addEventListener('click', () => openModal('modal-add-news'));
    $('newsForm').addEventListener('submit', publishNews);
    $('streamSave').addEventListener('click', addStream);
    $('gamePath').addEventListener('change', () => saveSettings($('settingsMsg')));
    $('nick').addEventListener('change', () => saveSettings($('message')));
    $('browseGame').addEventListener('click', browseGame);
    $('chatForm').addEventListener('submit', sendChatMessage);
    $('moderationMore').addEventListener('click', () => loadAuthors(true));
    $('moderationBan').addEventListener('click', () => changeBan(false));
    $('moderationUnban').addEventListener('click', () => changeBan(true));
  }

  async function tick() {
    try {
      const data = await api.servers();
      state.now = data.now;
      state.live = data.servers;
      renderLive();
    } catch (error) {
      fail(error);
    }
  }

  async function start() {
    showMessage('Получение конфигурации…');
    state.init = await api.init();
    fillSettings(state.init.settings);
    buildServers();
    await refreshAccount(await api.chatState());
    selectServer(0);
    api.onModsProgress(showMessage);
    api.onUpdateStatus(applyUpdateStatus);
    showMessage('');
    await tick();
    setInterval(tick, TICK_MS);
    setInterval(refreshVisibleFeed, FEED_REFRESH_MS);
    setInterval(pollChat, CHAT_POLL_MS);
    pollChat();
    refreshVisibleFeed();
  }

  wire();
  start().catch(fail);
})();
