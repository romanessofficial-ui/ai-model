const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('node:path');
const { Database } = require('./db.cjs');
const { Services } = require('./services.cjs');
const { UpdateService } = require('./updater.cjs');

let win; let tray; let services; let updates;
app.setAppUserModelId('sk.codex.instagrammanager');

function register(name, handler) { ipcMain.handle(name, (_event, ...args) => Promise.resolve(handler(...args)).catch(error => { services?.log('ERROR', error.message); throw new Error(error.message); })); }
async function createWindow() {
  win = new BrowserWindow({ width: 1400, height: 900, minWidth: 1000, minHeight: 680, backgroundColor: '#111614', title: 'Instagram Manager', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('minimize', event => { event.preventDefault(); win.hide(); });
  win.on('close', event => { if (!app.isQuitting) { event.preventDefault(); win.hide(); } });
}
function installTray() {
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVQ4T2NkYGD4z0ABYBw1gGE0DBhGwoBhNAwYRsOAYTQMGAYAAAo6AQF1A9+WAAAAAElFTkSuQmCC');
  tray = new Tray(icon); tray.setToolTip('Instagram Manager');
  const menu = Menu.buildFromTemplate([
    { label: 'Open', click: () => { win.show(); win.focus(); } },
    { label: 'Pause Scheduler', click: () => services.setSetting('automationPaused', 'true') },
    { label: 'Resume Scheduler', click: () => services.setSetting('automationPaused', 'false') },
    { label: 'Open Content Folder', click: () => shell.openPath(services.getSetting('contentFolder')) },
    { type: 'separator' }, { label: 'Exit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu); tray.on('double-click', () => { win.show(); win.focus(); });
}
function registerIpc() {
  register('dashboard:get', () => services.getDashboard());
  register('media:list', () => services.listMedia());
  register('media:image', id => services.imageData(id));
  register('media:update', (id, url) => services.updateMedia(id, url));
  register('media:open-folder', () => shell.openPath(services.getSetting('contentFolder')));
  register('posts:list', () => services.listPosts());
  register('posts:create', (id, caption) => services.createDraft(id, caption));
  register('posts:schedule', (id, at) => services.schedulePost(id, at));
  register('posts:update', (id, caption) => services.updatePost(id, caption));
  register('posts:retry', id => services.retryPost(id));
  register('posts:delete', id => { services.db.run("DELETE FROM posts WHERE id=? AND status IN ('DRAFT','FAILED')", [id]); return true; });
  register('captions:generate', (id, prefs) => services.generateCaption(id, prefs));
  register('instagram:connect', () => services.startOAuth());
  register('instagram:disconnect', () => services.disconnectInstagram());
  register('settings:get', () => services.getSettings());
  register('settings:save', data => services.saveSettings(data));
  register('updates:get', () => updates.status());
  register('updates:configure', async url => { services.setSetting('updateFeedUrl', String(url || '').trim()); return updates.configure(url); });
  register('updates:check', () => updates.check());
  register('updates:install', () => updates.install());
  register('settings:folder', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openDirectory','createDirectory'] }); return result.canceled ? null : services.setFolder(result.filePaths[0]); });
  register('settings:pause', paused => { services.setSetting('automationPaused', String(paused)); return services.getDashboard(); });
  register('scheduler:auto-plan', () => services.autoPlan());
  register('logs:list', () => services.getLogs());
  register('export:csv', async () => { const result = await dialog.showSaveDialog(win, { defaultPath: 'instagram-posts.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] }); if (!result.canceled) require('node:fs').writeFileSync(result.filePath, await services.exportCsv(), 'utf8'); return !result.canceled; });
  register('database:backup', async () => { const result = await dialog.showSaveDialog(win, { defaultPath: 'instagram-manager-backup.db', filters: [{ name: 'SQLite database', extensions: ['db'] }] }); if (!result.canceled) await services.backup(result.filePath); return !result.canceled; });
  register('database:restore', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'SQLite database', extensions: ['db'] }] }); if (!result.canceled) await services.restore(result.filePaths[0]); return !result.canceled; });
}

app.whenReady().then(async () => {
  const db = new Database(path.join(app.getPath('userData'), 'instagram-manager.sqlite'));
  await db.open();
  services = new Services(app, db, require('electron').safeStorage, (title, body) => { if (Notification.isSupported() && services.getSetting('notifications', 'true') === 'true') new Notification({ title, body }).show(); }, shell);
  await services.initialize();
  updates = new UpdateService({ app, NsisUpdater: require('electron-updater').NsisUpdater, broadcast: status => { if (win && !win.isDestroyed()) win.webContents.send('updates:status', status); }, log: (level, message) => services.log(level, message) });
  await updates.configure(services.getSetting('updateFeedUrl'));
  registerIpc(); await createWindow(); installTray();
  app.on('activate', () => { if (!win || win.isDestroyed()) createWindow(); else { win.show(); win.focus(); } });
});
app.on('before-quit', () => { app.isQuitting = true; updates?.dispose(); services?.dispose(); });
app.on('window-all-closed', event => event.preventDefault());
