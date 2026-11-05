'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  tree: invoke('db:tree'),
  loadPage: invoke('db:loadPage'),
  apply: invoke('db:apply'),
  search: invoke('db:search'),
  trash: invoke('db:trash'),
  duplicate: invoke('db:duplicate'),
  getMeta: invoke('meta:get'),
  setMeta: invoke('meta:set'),
  setTheme: invoke('theme:set'),
  isDark: invoke('theme:isDark'),
  saveText: invoke('file:saveText'),
  openText: invoke('file:openText'),
  pickImage: invoke('file:pickImage'),
  saveImageData: invoke('file:saveImageData'),
  exportPdf: invoke('file:exportPdf'),
  newWindow: invoke('win:new'),
  backup: invoke('file:backup'),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
  onChanged: (fn) => ipcRenderer.on('db:changed', () => fn()),
});
