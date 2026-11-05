'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, Menu, dialog, nativeTheme, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Store } = require('./db');
const { seed } = require('./seed');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let store;
let assetsDir;
const windows = new Set();

function dataDir() {
  // LOCALNOTES_DATA_DIR lets tests and portable installs point somewhere else.
  return process.env.LOCALNOTES_DATA_DIR || app.getPath('userData');
}

function serveFile(root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
}

function registerProtocol() {
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (url.host === 'assets') return serveFile(assetsDir, rel);
    return serveFile(RENDERER_DIR, rel);
  });
}

function createWindow(pageId) {
  const state = store.getMeta('windowBounds') || { width: 1280, height: 820 };
  const win = new BrowserWindow({
    ...state,
    minWidth: 720,
    minHeight: 480,
    title: 'Local Notion',
    icon: path.join(__dirname, '..', 'renderer', 'logo.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  windows.add(win);
  win.loadURL('app://renderer/index.html' + (pageId ? `#${pageId}` : ''));
  win.once('ready-to-show', () => win.show());
  const saveBounds = () => { if (!win.isDestroyed() && !win.isMinimized()) store.setMeta('windowBounds', win.getBounds()); };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('closed', () => windows.delete(win));
  // Links open in the system browser; never navigate the app window away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('context-menu', (_e, params) => {
    const items = [];
    for (const s of params.dictionarySuggestions || []) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    if (params.misspelledWord) {
      items.push({ label: 'Add to Dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  return win;
}

function send(channel, ...args) {
  const win = BrowserWindow.getFocusedWindow() || [...windows][0];
  if (win) win.webContents.send(channel, ...args);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Page', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'new-page') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'Import Markdown…', click: () => send('menu', 'import-markdown') },
        { label: 'Export Page as Markdown…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('menu', 'export-markdown') },
        { label: 'Export Page as PDF…', click: () => send('menu', 'export-pdf') },
        { type: 'separator' },
        { label: 'Back Up Workspace…', click: () => backup() },
        { label: 'Show Data Folder', click: () => shell.openPath(dataDir()) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' },
      { role: 'delete' }, { role: 'selectAll' }, { type: 'separator' },
      { label: 'Find in Page…', accelerator: 'CmdOrCtrl+F', click: () => send('menu', 'find') },
      { label: 'Replace…', accelerator: isMac ? 'Command+Alt+F' : 'Ctrl+H', click: () => send('menu', 'replace') },
      { label: 'Find Next', accelerator: isMac ? 'Command+G' : 'F3', click: () => send('menu', 'find-next') },
      { label: 'Find Previous', accelerator: isMac ? 'Command+Shift+G' : 'Shift+F3', click: () => send('menu', 'find-previous') },
    ] },
    {
      label: 'View',
      submenu: [
        { label: 'Search', accelerator: 'CmdOrCtrl+P', click: () => send('menu', 'search') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => send('menu', 'toggle-sidebar') },
        { label: 'Toggle Dark Mode', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('menu', 'toggle-theme') },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => send('menu', 'back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => send('menu', 'forward') },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
        { role: 'reload' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function backup() {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Back up workspace',
    defaultPath: `local-notion-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return;
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, exportedAt: Date.now(), blocks: store.dumpAll() }, null, 2));
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args));
  h('db:tree', () => store.tree());
  h('db:loadPage', (id) => store.loadPage(id));
  h('db:apply', (ops) => {
    const r = store.apply(ops);
    // Keep other windows' sidebars in sync.
    for (const w of windows) w.webContents.send('db:changed');
    return r;
  });
  h('db:search', (q) => store.search(q));
  h('db:trash', () => store.trash());
  h('db:duplicate', (id) => store.duplicate(id));
  h('meta:get', (k) => store.getMeta(k));
  h('meta:set', (k, v) => store.setMeta(k, v));
  h('theme:set', (mode) => { nativeTheme.themeSource = mode; });
  h('theme:isDark', () => nativeTheme.shouldUseDarkColors);

  h('file:saveText', async (name, text, ext) => {
    const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, text);
    return filePath;
  });
  h('file:openText', async (exts) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Text', extensions: exts }] });
    if (canceled) return [];
    return filePaths.map((p) => ({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') }));
  });
  h('file:pickImage', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }] });
    if (canceled || !filePaths[0]) return null;
    return importAsset(fs.readFileSync(filePaths[0]), path.extname(filePaths[0]));
  });
  h('file:saveImageData', (bytes, ext) => importAsset(Buffer.from(bytes), ext));
  h('file:exportPdf', async (name) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: name, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (canceled || !filePath || !win) return null;
    const pdf = await win.webContents.printToPDF({ printBackground: true, margins: { marginType: 'default' } });
    fs.writeFileSync(filePath, pdf);
    return filePath;
  });
  h('win:new', (pageId) => { createWindow(pageId); });
  h('file:backup', () => backup());
}

// The app used to be called "LocalNotes"; carry its data over once after the rename.
function migrateOldDataDir(dir) {
  if (process.env.LOCALNOTES_DATA_DIR) return;
  const old = path.join(app.getPath('appData'), 'LocalNotes');
  if (old === dir || fs.existsSync(path.join(dir, 'localnotes.db')) || !fs.existsSync(path.join(old, 'localnotes.db'))) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['localnotes.db', 'localnotes.db-wal', 'localnotes.db-shm', 'assets']) {
    const src = path.join(old, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, name), { recursive: true });
  }
}

function importAsset(buf, ext) {
  const safeExt = (ext || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '');
  const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24) + safeExt;
  const dest = path.join(assetsDir, name);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  return `app://assets/${name}`;
}

if (!app.requestSingleInstanceLock() && !process.env.LOCALNOTES_DATA_DIR) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = [...windows][0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  app.whenReady().then(() => {
    const dir = dataDir();
    migrateOldDataDir(dir);
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(path.join(RENDERER_DIR, 'logo.png'));
    assetsDir = path.join(dir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    store = new Store(path.join(dir, 'localnotes.db'));
    if (!store.getMeta('seeded')) { seed(store); store.setMeta('seeded', true); }
    const theme = store.getMeta('theme');
    if (theme) nativeTheme.themeSource = theme;

    registerProtocol();
    registerIpc();
    buildMenu();
    createWindow();

    app.on('activate', () => { if (windows.size === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => { try { store && store.close(); } catch { /* already closed */ } });
}
