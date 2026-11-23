'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('launcher', {
  init: () => ipcRenderer.invoke('app:init'),
  servers: () => ipcRenderer.invoke('servers:state'),
  saveSettings: invoke('settings:save'),
  browse: () => ipcRenderer.invoke('settings:browse'),
  checkMods: invoke('mods:check'),
  play: invoke('game:play'),
  community: invoke('community:request'),
  checkUpdate: () => ipcRenderer.invoke('update:run'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  chatState: () => ipcRenderer.invoke('chat:state'),
  chatLogin: () => ipcRenderer.invoke('chat:login'),
  chatLogout: () => ipcRenderer.invoke('chat:logout'),
  chatFetch: invoke('chat:fetch'),
  chatSend: invoke('chat:send'),
  openUrl: invoke('shell:open'),
  openWorkshop: invoke('steam:workshop'),
  openDownloads: () => ipcRenderer.invoke('steam:downloads'),
  onModsProgress: (callback) => {
    ipcRenderer.on('mods:progress', (_event, text) => callback(text));
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update:status', (_event, status) => callback(status));
  },
});
