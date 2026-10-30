const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = channel => callback => {
  if (typeof callback !== 'function') throw new Error('Event callback must be a function.');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('bridge', Object.freeze({
  platform: process.platform,
  onAppMenu: subscribe('app:menu'),
  bootstrap: invoke('app:bootstrap'), saveSessions: invoke('state:sessions'), saveSettings: invoke('state:settings'), saveMacros: invoke('state:macros'),
  openTerminal: invoke('terminal:open'), writeTerminal: invoke('terminal:write'), resizeTerminal: invoke('terminal:resize'), closeTerminal: invoke('terminal:close'),
  onTerminalData: subscribe('terminal:data'), onTerminalExit: subscribe('terminal:exit'),
  listFiles: invoke('files:list'), fileAction: invoke('files:action'), transfer: invoke('files:transfer'), readFile: invoke('files:read'), writeFile: invoke('files:write'),
  openFiles: invoke('files:open'), runTool: invoke('tools:run'), launchExternal: invoke('tools:launch'),
  importSessions: invoke('sessions:import'), exportSessions: invoke('sessions:export'), pickFile: invoke('dialog:pick'),
  createTunnel: invoke('tunnels:create'), closeTunnel: invoke('tunnels:close'), listTunnels: invoke('tunnels:list'), listSerialPorts: invoke('serial:list'),
  listServers: invoke('servers:list'), startServer: invoke('servers:start'), stopServer: invoke('servers:stop'),
  listCronJobs: invoke('cron:list'), saveCronJobs: invoke('cron:save'), runCronJob: invoke('cron:run'), onCronResult: subscribe('cron:result'),
  openVnc: invoke('vnc:open'), startVnc: invoke('vnc:start'), writeVnc: invoke('vnc:write'), onVncData: subscribe('vnc:data'),
  openBrowser: invoke('browser:open'), openPath: invoke('path:open'), createShortcut: invoke('session:shortcut'),
  launchRequest: invoke('app:launch-request'), onSessionLaunch: subscribe('session:launch'),
  readClipboard: invoke('clipboard:read'), writeClipboard: invoke('clipboard:write'),
  windowAction: invoke('window:action'), saveCredentials: invoke('vault:save'), forgetCredentials: invoke('vault:forget'),
  detachTerminal: invoke('window:detach'), detachedInfo: invoke('window:detached-info'), reattachTerminal: invoke('window:reattach'), onTerminalAttach: subscribe('terminal:attach'),
}));
