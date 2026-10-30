const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { StateStore, sanitizeSessions } = require('../lib/state.cjs');
const { parseSessionImport, MAX_IMPORT_BYTES } = require('../lib/session-import.cjs');
const { TerminalManager } = require('../lib/terminals.cjs');
const { FileManager } = require('../lib/files.cjs');
const { installedTools, runTool, launchExternal } = require('../lib/system.cjs');
const { ServerManager } = require('../extensions/servers.cjs');
const { CredentialVault } = require('../lib/vault.cjs');

app.setName('Termora');
const portableDirectory = path.join(path.dirname(app.getPath('exe')), 'data');
const userData = process.env.TERMORA_DATA_DIR || (app.isPackaged && fs.existsSync(portableDirectory) ? portableDirectory : null);
if (userData) { fs.mkdirSync(userData, { recursive: true }); app.setPath('userData', userData); }
let window, store, terminals, files, tools, servers, vault;
// Desktop shortcuts start Termora with --session=<saved id>; a running instance takes the request.
const sessionArgument = argv => { const value = argv.find(arg => arg.startsWith('--session='))?.slice(10); return value && /^[\w-]{1,100}$/.test(value) ? value : null; };
let pendingLaunch = sessionArgument(process.argv);
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', (_event, argv) => { const id = sessionArgument(argv); if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus(); if (id) window.webContents.send('session:launch', id); } });
function applyLogging(settings) { const logging = settings?.logging || {}; terminals.setLogging({ enabled: logging.enabled, directory: logging.directory || path.join(app.getPath('userData'), 'logs') }); }
const pendingSessionImports = new Map();
let cleanupStarted = false, cleanupComplete = false;
// Detached tabs live in their own windows; terminal output goes to the owner.
const detached = new Map(); // webContents id -> { window, terminalId, payload, reattached }
const owners = new Map();   // terminal id -> BrowserWindow
const emit = (channel, data) => {
  const target = (data?.id && owners.get(data.id)) || window;
  if (target && !target.isDestroyed()) target.webContents.send(channel, data);
  if (channel === 'terminal:exit' && data?.id) owners.delete(data.id);
};
const rendererPath = process.env.TERMORA_RENDERER || path.join(__dirname, '../dist/index.html');
const rendererURL = pathToFileURL(rendererPath).href;
function trusted(event) {
  const owner = window && event.sender === window.webContents ? window : detached.get(event.sender.id)?.window;
  if (!owner || event.senderFrame !== owner.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== rendererURL) throw new Error('Untrusted application request.');
}
function handle(channel, callback, { withEvent = false } = {}) { ipcMain.handle(channel, async (event, ...args) => { trusted(event); try { return await (withEvent ? callback(event, ...args) : callback(...args)); } catch (error) { throw new Error(error?.message || 'Operation failed.'); } }); }
function safeConfig(config = {}) { const { password, passphrase, gatewayPassword, gatewayPassphrase, ...rest } = config; return rest; }
function detachTerminal({ id, label, kind, config, history } = {}) {
  terminals.session(id);
  if (owners.has(id)) throw new Error('This tab is already detached.');
  const child = new BrowserWindow({ width: 960, height: 620, minWidth: 420, minHeight: 260, title: String(label || 'Terminal'), backgroundColor: '#000000', frame: process.platform === 'darwin', ...(process.platform === 'darwin' ? {titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:18}} : {}), show: process.env.TERMORA_TEST_MODE !== 'hidden',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  const record = { window: child, terminalId: id, payload: { id, label: String(label || 'Terminal').slice(0, 200), kind: String(kind || ''), config: safeConfig(config), history: String(history || '').slice(-2 * 1024 * 1024) }, reattached: false };
  const contentsId = child.webContents.id;
  detached.set(contentsId, record); owners.set(id, child);
  child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  child.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== rendererURL) event.preventDefault(); });
  child.on('closed', () => { detached.delete(contentsId); if (owners.get(id) === child) { owners.delete(id); if (!record.reattached) terminals.close(id); } });
  child.loadFile(rendererPath, { hash: 'detached' });
  return { ok: true };
}
function reattachTerminal(payload = {}, event) {
  const record = detached.get(event.sender.id);
  if (!record) throw new Error('Only a detached window can reattach its tab.');
  record.reattached = true; owners.delete(record.terminalId);
  if (window && !window.isDestroyed()) window.webContents.send('terminal:attach', { ...record.payload, label: String(payload.label || record.payload.label).slice(0, 200), history: String(payload.history || '').slice(-2 * 1024 * 1024) });
  record.window.close();
  return { ok: true };
}
// Browser sessions open in a sandboxed window with its own cookie partition and
// no preload, so web pages never reach the application bridge.
const webURL = value => { try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) ? url : null; } catch { return null; } };
function openBrowser({ url, title } = {}) {
  const target = webURL(/^[a-z][a-z0-9+.-]*:/i.test(String(url || '').trim()) ? String(url).trim() : `https://${String(url || '').trim()}`);
  if (!target) throw new Error('Browser sessions open http and https addresses only.');
  const browser = new BrowserWindow({ width: 1200, height: 800, title: String(title || target.host).slice(0, 200), autoHideMenuBar: true, show: process.env.TERMORA_TEST_MODE !== 'hidden',
    webPreferences: { partition: 'termora-browser', contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  const contents = browser.webContents;
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.setWindowOpenHandler(({ url: next }) => { if (webURL(next)) contents.loadURL(next); return { action: 'deny' }; });
  contents.on('will-navigate', (event, next) => { if (!webURL(next)) event.preventDefault(); });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.alt && input.key === 'ArrowLeft' && contents.navigationHistory.canGoBack()) { contents.navigationHistory.goBack(); event.preventDefault(); }
    else if (input.alt && input.key === 'ArrowRight' && contents.navigationHistory.canGoForward()) { contents.navigationHistory.goForward(); event.preventDefault(); }
    else if (input.key === 'F5') { contents.reload(); event.preventDefault(); }
  });
  contents.on('page-title-updated', (_event, pageTitle) => browser.setTitle(`${pageTitle} — ${String(title || target.host).slice(0, 80)}`));
  browser.loadURL(target.href).catch(() => {});
  return { ok: true, url: target.href, windowId: browser.id };
}
const RISKY = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|lnk|hta|cpl|jar|reg)$/i;
// File sessions: folders browse in the side panel; files open with their Windows app.
async function openLocalPath(requested) {
  const target = path.resolve(String(requested || ''));
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return { directory: target };
  if (RISKY.test(target)) {
    const answer = await dialog.showMessageBox(window, { type: 'warning', title: 'Open program or script?', message: `${path.basename(target)} can run code on this computer.`, detail: target, buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return { cancelled: true };
  }
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return { opened: target };
}
function createShortcut(sessionId) {
  const session = store.read().sessions.find(item => item.id === sessionId);
  if (!session) throw new Error('Save the session before creating a shortcut.');
  if (process.platform !== 'win32') throw new Error('Desktop shortcuts are available on Windows.');
  const directory = process.env.TERMORA_SHORTCUT_DIR || app.getPath('desktop');
  const name = String(session.name || 'Termora session').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').trim().slice(0, 80) || 'Termora session';
  const file = path.join(directory, `${name}.lnk`);
  const args = `${app.isPackaged ? '' : `"${app.getAppPath()}" `}--session=${session.id}`;
  if (!shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', { target: process.execPath, args, description: `Open ${name} in Termora`, icon: process.execPath, iconIndex: 0, cwd: path.dirname(process.execPath) })) throw new Error('Windows could not create the shortcut.');
  return { ok: true, path: file };
}
async function verifyHost({ host, port, fingerprint }) {
  const key = `[${host}]:${port}`, known = store.read().knownHosts || {};
  if (known[key] === fingerprint) return true;
  if (known[key]) {
    await dialog.showMessageBox(window, { type: 'error', title: 'SSH host key changed', message: `The SSH identity for ${host}:${port} has changed. The connection was blocked.`, detail: `Saved: ${known[key]}\nReceived: ${fingerprint}\n\nVerify the server identity with its administrator before updating knownHosts in your Termora state file.`, buttons: ['Close'] });
    return false;
  }
  const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Verify SSH server identity', message: `Trust ${host}:${port}?`, detail: `This server has not been seen before.\nHost key fingerprint:\n${fingerprint}\n\nCompare this fingerprint with a trusted source before connecting.`, buttons: ['Cancel', 'Trust and connect'], defaultId: 0, cancelId: 0, noLink: true });
  if (answer.response !== 1) return false;
  store.update('knownHosts', { ...(store.read().knownHosts || {}), [key]: fingerprint }); return true;
}
function registerIPC() {
  handle('app:bootstrap', () => {
    const state = store.read();
    let serial = false; try { serial = Boolean(require('serialport').SerialPort); } catch {}
    return { version: app.getVersion(), appName: 'Termora', platform: process.platform, sessions: state.sessions, settings: state.settings, macros: state.macros, cronJobs: state.cronJobs || [], tunnels: terminals.listTunnels(), servers: servers.list(), homePath: os.homedir(), dataPath: app.getPath('userData'),
      vault: { available: vault.available(), saved: Object.keys(state.vault || {}) }, logDirectory: terminals.logging.directory,
      capabilities: { local: true, powershell: Boolean(tools.powershell), cmd: Boolean(tools.cmd), wsl: Boolean(tools.wsl), ssh: true, sftp: true, ftp: true, ftps: true, telnet: true, rsh: true, rlogin: true, mosh: true, serial, rdp: Boolean(tools.rdp), vnc: true, vncExternal: Boolean(tools.vnc), x11: Boolean(tools.x11), xdmcp: Boolean(tools.x11),
        details: { wsl: 'Requires an installed WSL distribution.', rdp: process.platform === 'darwin' ? 'Uses the RDP engine bundled in Termora.' : 'Opens the Windows Remote Desktop client.', vnc: 'Embedded noVNC viewer (None or VNC-password security); an installed TigerVNC/RealVNC viewer can be used instead.', x11: 'Starts an installed VcXsrv server; SSH sessions with X11-Forwarding relay remote X clients to it.', telnet: 'Unencrypted TCP terminal with basic Telnet option negotiation.', rsh: 'Unencrypted r-services session (rlogin, or rsh when a command is set).', mosh: 'Built-in Mosh client: starts mosh-server over SSH, then uses encrypted UDP (no local echo prediction).', ftp: 'FTP is unencrypted. Prefer SFTP or FTPS.', serial: 'Physical serial hardware is required.' } } };
  });
  handle('state:sessions', value => { const saved = store.saveSessions(value); vault.prune(saved.map(session => session.id)); return saved; });
  handle('state:settings', value => { const saved = store.saveSettings(value); applyLogging(saved); return saved; }); handle('state:macros', value => store.saveMacros(value));
  handle('vault:save', (sessionId, secrets) => vault.save(sessionId, secrets)); handle('vault:forget', sessionId => vault.forget(sessionId));
  handle('terminal:open', config => terminals.open(vault.apply(config))); handle('terminal:write', request => terminals.write(request)); handle('terminal:resize', request => terminals.resize(request)); handle('terminal:close', id => terminals.close(id));
  handle('files:open', config => terminals.openFiles(vault.apply(config))); handle('files:list', request => files.list(request)); handle('files:read', request => files.read(request)); handle('files:write', request => files.write(request));
  handle('files:action', async request => {
    if (request.action === 'delete') {
      const response = await dialog.showMessageBox(window, { type: 'warning', title: 'Delete item', message: `Delete ${path.basename(request.path)}?`, detail: 'This permanently deletes the selected file or empty directory.', buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0 });
      if (response.response !== 1) return { cancelled: true };
    }
    return files.action(request);
  });
  handle('files:transfer', async ({ id, direction, remotePath }) => {
    if (direction === 'upload') {
      const selected = await dialog.showOpenDialog(window, { title: 'Choose files to upload', properties: ['openFile', 'multiSelections'] });
      if (selected.canceled) return { cancelled: true };
      const results = [];
      for (const localPath of selected.filePaths) { const target = id && !['local', 'wsl'].includes(terminals.session(id).kind) ? path.posix.join(remotePath, path.basename(localPath)) : path.join(remotePath, path.basename(localPath)); results.push(await files.upload(id, localPath, target)); }
      return { ok: true, files: results };
    }
    if (direction === 'download') {
      const selected = await dialog.showSaveDialog(window, { title: 'Save downloaded file', defaultPath: path.basename(remotePath) });
      if (selected.canceled || !selected.filePath) return { cancelled: true };
      return files.download(id, remotePath, selected.filePath);
    }
    throw new Error('Choose upload or download.');
  });
  handle('vnc:open', config => terminals.openVnc(vault.apply(config))); handle('vnc:start', id => terminals.vncStart(id)); handle('vnc:write', request => terminals.vncWrite(request));
  handle('tools:run', runTool); handle('tools:launch', config => launchExternal(config, tools, store.read().settings)); handle('serial:list', () => terminals.listSerialPorts());
  handle('tunnels:create', config => terminals.createTunnel(vault.apply(config))); handle('tunnels:close', id => terminals.closeTunnel(id)); handle('tunnels:list', () => terminals.listTunnels());
  handle('servers:list', () => servers.list()); handle('servers:start', config => servers.start(config)); handle('servers:stop', id => servers.stop(id));
  handle('cron:list', () => ({ jobs: store.read().cronJobs || [], results: servers.cronResults() }));
  handle('cron:save', jobs => store.saveCronJobs(jobs));
  handle('cron:run', id => { const job = (store.read().cronJobs || []).find(item => item.id === id); if (!job) throw new Error('Save the job before running it.'); return servers.runCronJob(job); });
  handle('browser:open', request => openBrowser(request)); handle('path:open', target => openLocalPath(target));
  handle('session:shortcut', id => createShortcut(id));
  handle('app:launch-request', () => { const id = pendingLaunch; pendingLaunch = null; return id; });
  handle('clipboard:read', () => clipboard.readText());
  handle('clipboard:write', text => { if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Clipboard text is too large.'); clipboard.writeText(text); return { ok: true }; });
  handle('sessions:import', async (request = {}) => {
    if (!request || typeof request !== 'object') throw new Error('Invalid import request.');
    for (const [token,pending] of pendingSessionImports) if (pending.expires < Date.now()) pendingSessionImports.delete(token);
    if (request.cancel && request.token) { pendingSessionImports.delete(request.token); return { cancelled: true }; }
    let bytes, selectedName;
    if (request.token) {
      const pending = pendingSessionImports.get(request.token);
      if (!pending) throw new Error('This import has expired. Choose the backup file again.');
      if (typeof request.password !== 'string') throw new Error('Enter the password used for this MobaXterm export.');
      bytes=pending.bytes;selectedName=pending.name;
    } else {
      const selected = await dialog.showOpenDialog(window, { title: 'Import MobaXterm configuration or sessions', properties: ['openFile'], filters: [{ name: 'Session and configuration files', extensions: ['mobaconf', 'mxtsessions', 'ini', 'json'] }] });
      if (selected.canceled) return { cancelled: true, sessions: store.read().sessions, warnings: [] };
      const stat=fs.statSync(selected.filePaths[0]);if(stat.size>MAX_IMPORT_BYTES)throw new Error('Session import is limited to 10 MiB.');
      bytes=fs.readFileSync(selected.filePaths[0]);selectedName=path.basename(selected.filePaths[0]);
    }
    const parsed=parseSessionImport(bytes, { password: request.password });
    if (parsed.needsPassword) {
      const token=require('node:crypto').randomUUID();
      if(pendingSessionImports.size>=4)pendingSessionImports.delete(pendingSessionImports.keys().next().value);
      pendingSessionImports.set(token,{bytes,name:selectedName,expires:Date.now()+10*60*1000});
      return { needsPassword:true,token,fileName:selectedName };
    }
    if(request.token)pendingSessionImports.delete(request.token);
    const existing = store.read().sessions, existingIds = new Set(existing.map(s => s.id));
    const crypto = require('node:crypto');
    const imported = parsed.sessions.map(s => { const next = existingIds.has(s.id) ? { ...s, id: crypto.randomUUID() } : s; existingIds.add(next.id); return next; });
    const sessions = store.saveSessions([...existing, ...imported]);
    return { sessions, imported: imported.length, warnings: parsed.warnings };
  });
  handle('sessions:export', async () => {
    const selected = await dialog.showSaveDialog(window, { title: 'Export sessions', defaultPath: 'termora-sessions.json', filters: [{ name: 'Termora sessions', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePath) return { cancelled: true };
    fs.writeFileSync(selected.filePath, JSON.stringify({ format: 'termora-sessions', version: 1, sessions: sanitizeSessions(store.read().sessions) }, null, 2), { mode: 0o600 });
    return { ok: true, path: selected.filePath };
  });
  handle('dialog:pick', async ({ kind } = {}) => { const folder = kind === 'folder' || kind === 'logs'; const selected = await dialog.showOpenDialog(window, { title: kind === 'logs' ? 'Choose session log folder' : folder ? 'Choose working directory' : 'Choose SSH private key', properties: [folder ? 'openDirectory' : 'openFile'] }); return selected.canceled ? null : selected.filePaths[0]; });
  handle('window:action', (event, action) => { const target = BrowserWindow.fromWebContents(event.sender) || window; if (action === 'minimize') target.minimize(); else if (action === 'maximize') target.isMaximized() ? target.unmaximize() : target.maximize(); else if (action === 'fullscreen') target.setFullScreen(!target.isFullScreen()); else if (action === 'close') target.close(); }, { withEvent: true });
  handle('window:detach', request => detachTerminal(request));
  handle('window:detached-info', event => { const record = detached.get(event.sender.id); if (!record) throw new Error('This window is not a detached tab.'); return record.payload; }, { withEvent: true });
  handle('window:reattach', (event, payload) => reattachTerminal(payload, event), { withEvent: true });
}
function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 930, minWidth: 1000, minHeight: 650, title: 'Termora', backgroundColor: '#202020', show: process.env.TERMORA_TEST_MODE !== 'hidden', frame: process.platform === 'darwin', ...(process.platform === 'darwin' ? {titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:18}} : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== rendererURL) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.loadFile(rendererPath);
  window.on('closed', () => { terminals.closeAll(); window = null; for (const record of detached.values()) record.window.destroy(); });
}
app.whenReady().then(() => { if (!primaryInstance) return; store = new StateStore(app.getPath('userData')); tools = installedTools(); terminals = new TerminalManager({ emit, store, verifyHost }); vault = new CredentialVault(store, safeStorage); applyLogging(store.read().settings); files = new FileManager(terminals);
  servers = new ServerManager({ dataDir: app.getPath('userData'), cronJobs: () => store.read().cronJobs || [], onCronResult: result => { if (window && !window.isDestroyed()) window.webContents.send('cron:result', result); } });
  // macOS routes Cmd+C/V/A/Q through the application menu, so keep a minimal one there.
  const command = (label, action, accelerator) => ({label, accelerator, click:()=>{if(window && !window.isDestroyed()) window.webContents.send('app:menu',action);}});
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    {label:'Termora',submenu:[{role:'about'}, {type:'separator'}, command('Settings…','open-settings','Command+,'), {type:'separator'}, {role:'services'}, {type:'separator'}, {role:'hide'}, {role:'hideOthers'}, {role:'unhide'}, {type:'separator'}, {role:'quit'}]},
    {label:'File',submenu:[command('New Local Terminal','card-powershell','Command+T'),command('New Connection…','new-session','Command+N'),{type:'separator'},command('Import Connections…','toolbar-import','Command+Shift+I'),command('Export Connections…','toolbar-export','Command+Shift+E'),{type:'separator'},command('Close Tab','close-active-tab','Command+W')]},
    {role:'editMenu'},
    {label:'Terminal',submenu:[command('Rename Tab…','terminal:Set tab title'),command('Duplicate Tab','terminal:Duplicate current tab','Command+Shift+D'),command('Detach Tab','terminal:Detach'),{type:'separator'},command('Find in Terminal…','terminal:Find in terminal','Command+F'),command('Find Next','terminal:Find next','Command+G'),command('Save Terminal Output…','terminal:Save terminal text'),{type:'separator'},command('Broadcast Input','terminal:Write commands on all terminals')]},
    {label:'View',submenu:[command('Saved Sessions','toolbar-sessions'),command('File Browser','rail-files','Command+Shift+F'),command('Split Terminals','toolbar-split'),command('Broadcast Input','toolbar-multiexec'),{type:'separator'},{role:'togglefullscreen'}]},
    {label:'Tools',submenu:[command('Servers…','open-servers'),command('SSH Tunnels…','open-tunnels'),command('Network Tools…','open-tools'),command('Macros…','open-macros'),command('Start X Server','toolbar-xserver')]},
    {role:'windowMenu'},
    {role:'help',submenu:[command('Termora Features','show-coverage')]}
  ]) : null);
  registerIPC(); createWindow(); });
app.on('window-all-closed', () => { terminals?.closeAll(); app.quit(); });
app.on('before-quit', event => {
  if (cleanupComplete) return;
  event.preventDefault();
  if (cleanupStarted) return;
  cleanupStarted = true;
  pendingSessionImports.clear();
  terminals?.closeAll();
  Promise.resolve(servers?.closeAll()).catch(error => console.error('Server cleanup failed:', error.message)).finally(() => { cleanupComplete = true; app.quit(); });
});
