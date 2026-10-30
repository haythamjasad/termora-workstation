const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = { theme: 'dark', fontSize: 14, fontFamily: 'Cascadia Code, Consolas, monospace', scrollback: 10000 };
const SESSION_TYPES = new Set(['local', 'ssh', 'sftp', 'ftp', 'ftps', 'telnet', 'wsl', 'rdp', 'vnc', 'serial', 'rsh', 'rlogin', 'file', 'browser', 's3', 'xdmcp', 'mosh']);
function text(value, max = 1000) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function validPort(value, fallback = 22) {
  const number = value === '' || value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('Port must be between 1 and 65535.');
  return number;
}
function validateHost(value) {
  const host = text(value, 253).trim();
  if (!host || /[\s\x00-\x1f/\\]/.test(host) || host.startsWith('-')) throw new Error('Enter a hostname or IP address without spaces.');
  return host;
}
function sanitizeSessions(sessions) {
  if (!Array.isArray(sessions) || sessions.length > 10000) throw new Error('Sessions must be an array with at most 10,000 entries.');
  return sessions.map(s => {
    if (!s || !SESSION_TYPES.has(s.type || 'ssh')) throw new Error('Unsupported session type.');
    return {
      id: text(s.id, 100) || crypto.randomUUID(), name: text(s.name || s.label || s.host || 'New session', 160),
      type: s.type || 'ssh', host: text(s.host, 253), port: validPort(s.port, ({ rdp: 3389, vnc: 5900, telnet: 23, ftp: 21, ftps: 21, xdmcp: 177 }[s.type] || 22)),
      username: text(s.username, 160), folder: text(s.folder || s.group, 200), group: text(s.group || s.folder, 200), shell: text(s.shell, 100),
      privateKeyPath: text(s.privateKeyPath, 4096), cwd: text(s.cwd, 4096), color: text(s.color, 20),
      favorite: Boolean(s.favorite), x11: Boolean(s.x11), startupCommand: text(s.startupCommand, 4000),
      lastUsed: Number.isFinite(s.lastUsed) ? s.lastUsed : 0, path: text(s.path, 4096), baudRate: Number(s.baudRate) || 9600, distribution: text(s.distribution, 200),
      dataBits: [5, 6, 7, 8].includes(Number(s.dataBits)) ? Number(s.dataBits) : 8,
      stopBits: Number(s.stopBits) === 2 ? 2 : 1,
      parity: ['none', 'even', 'odd', 'mark', 'space'].includes(s.parity) ? s.parity : 'none',
      gatewayHost: text(s.gatewayHost, 253).trim(), gatewayPort: s.gatewayHost ? validPort(s.gatewayPort, 22) : 22, gatewayUsername: text(s.gatewayUsername, 160), gatewayPrivateKeyPath: text(s.gatewayPrivateKeyPath, 4096),
      compression: Boolean(s.compression), agentForward: Boolean(s.agentForward), x11Display: Math.max(0, Math.min(63, Math.floor(Number(s.x11Display) || 0))),
      browserProtocol: s.browserProtocol === 'scp' ? 'scp' : 'sftp', ftpsMode: s.ftpsMode === 'implicit' ? 'implicit' : 'explicit', savePassword: Boolean(s.savePassword),
      region: text(s.region, 40).trim(), pathStyle: Boolean(s.pathStyle), vncViewer: s.vncViewer === 'external' ? 'external' : 'embedded', viewOnly: Boolean(s.viewOnly),
      domain: text(s.domain, 160), rdpSize: text(s.rdpSize, 20) || 'fit', rdpMultimon: Boolean(s.rdpMultimon), rdpClipboard: s.rdpClipboard !== false, rdpDrives: Boolean(s.rdpDrives), rdpPrinters: Boolean(s.rdpPrinters), rdpAudio: ['local', 'remote', 'none'].includes(s.rdpAudio) ? s.rdpAudio : 'local', rdpMicrophone: Boolean(s.rdpMicrophone), rdpAdmin: Boolean(s.rdpAdmin), rdpGateway: text(s.rdpGateway, 253).trim(),
      xdmcpMode: s.xdmcpMode === 'fullscreen' ? 'fullscreen' : 'window', xdmcpSize: /^\d{3,4}x\d{3,4}$/.test(s.xdmcpSize || '') ? s.xdmcpSize : '1280x800', xdmcpDisplay: Math.max(1, Math.min(63, Math.floor(Number(s.xdmcpDisplay) || 1))),
      moshServer: text(s.moshServer, 200).trim(), moshPorts: /^\d{1,5}(:\d{1,5})?$/.test(s.moshPorts || '') ? s.moshPorts : '', moshLocale: text(s.moshLocale, 60).trim(),
    };
  });
}
class StateStore {
  constructor(directory) { this.directory = directory; fs.mkdirSync(directory, { recursive: true }); this.file = path.join(directory, 'state.json'); }
  read() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`Cannot read saved state: ${e.message}`); }
    return { sessions: [], macros: [], cronJobs: [], knownHosts: {}, settings: { ...DEFAULT_SETTINGS }, ...saved, settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) } };
  }
  update(key, value) {
    const state = this.read(); state[key] = value;
    const tmp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, this.file); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
    return value;
  }
  saveSessions(value) { return this.update('sessions', sanitizeSessions(value)); }
  saveSettings(value) {
    const current = this.read().settings;
    if (!value || typeof value !== 'object') throw new Error('Settings must be an object.');
    const view = { ...(current.ui || {}), ...(value.ui && typeof value.ui === 'object' ? value.ui : {}) };
    const ui = { sidebarSide: view.sidebarSide === 'right' ? 'right' : 'left', sidebarHidden: Boolean(view.sidebarHidden), chrome: ['menu','toolbar'].includes(view.chrome) ? view.chrome : 'both', toolbarStyle: ['standard','small'].includes(view.toolbarStyle) ? view.toolbarStyle : 'captions', tabNumbers: Boolean(view.tabNumbers), tabClose: view.tabClose !== false, roundedTabs: view.roundedTabs !== false };
    const loggingSource = value.logging && typeof value.logging === 'object' ? value.logging : current.logging || {};
    const logging = { enabled: Boolean(loggingSource.enabled), directory: text(loggingSource.directory, 4096) };
    const highlight = value.highlight === undefined ? current.highlight !== false : Boolean(value.highlight);
    const x11 = require('./remote-desktop.cjs').x11Settings(value.x11 && typeof value.x11 === 'object' ? value.x11 : current.x11 || {});
    return this.update('settings', { ...current, ui, logging, highlight, x11, theme: value.theme === 'light' ? 'light' : 'dark', fontSize: Math.max(9, Math.min(32, Number(value.fontSize) || 14)), fontFamily: text(value.fontFamily, 200) || DEFAULT_SETTINGS.fontFamily, scrollback: Math.max(1000, Math.min(100000, Number(value.scrollback) || 10000)) });
  }
  saveCronJobs(value) {
    if (!Array.isArray(value) || value.length > 200) throw new Error('Invalid cron job list.');
    const { parseSchedule } = require('../extensions/cron.cjs');
    return this.update('cronJobs', value.map(job => {
      const schedule = text(job?.schedule, 200).trim(), command = text(job?.command, 4000).trim();
      parseSchedule(schedule);
      if (!command) throw new Error('Enter the command the job runs.');
      return { id: text(job.id, 100) || crypto.randomUUID(), name: text(job.name, 160) || command.slice(0, 40), schedule, command, shell: job.shell === 'cmd' ? 'cmd' : 'powershell', enabled: job.enabled !== false };
    }));
  }
  saveMacros(value) {
    if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid macro list.');
    const steps = list => Array.isArray(list) ? list.slice(0, 10000).map(step => ({ data: text(step?.data, 4096), delay: Math.max(0, Math.min(60000, Math.floor(Number(step?.delay) || 0))) })).filter(step => step.data) : undefined;
    return this.update('macros', value.map(m => { const recorded = steps(m.steps); return { id: text(m.id, 100) || crypto.randomUUID(), name: text(m.name, 160) || 'Macro', command: text(m.command, 16000), appendEnter: m.appendEnter !== false, ...(recorded?.length ? { steps: recorded } : {}) }; }));
  }
}

// MobaXterm bookmark records are positional, hash-delimited values. Only the
// supported basic SSH/RDP/VNC/Telnet identity fields are imported; passwords and
// opaque options deliberately do not enter the new application's state.
function importMobaIni(source) {
  const sessions = [], warnings = [];
  let section = '', folder = '';
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[;#]/.test(line)) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { section = header[1]; folder = ''; continue; }
    if (!/^Bookmarks(?:_\d+)?$/i.test(section)) continue;
    const equals = line.indexOf('='); if (equals < 0) continue;
    const name = line.slice(0, equals), value = line.slice(equals + 1);
    if (name === 'SubRep') { folder = value; continue; }
    if (name === 'ImgNum') continue;
    const record = /^#\d+#([^#]+)/.exec(value);
    if (!record) { warnings.push(`Skipped unrecognized bookmark: ${name}`); continue; }
    const fields = record[1].split('%');
    const type = ({ '0': 'ssh', '1': 'telnet', '2': 'rsh', '3': 'xdmcp', '4': 'rdp', '5': 'vnc', '6': 'ftp', '7': 'sftp', '8': 'serial' })[fields[0]];
    if (!type || !SESSION_TYPES.has(type)) { warnings.push(`Skipped unsupported bookmark type for ${name}.`); continue; }
    const host = fields[1] || '';
    const defaultPort = ({ telnet: 23, rdp: 3389, vnc: 5900, ftp: 21 }[type] || 22);
    let port = defaultPort;
    try { port = validPort(fields[2], defaultPort); } catch { warnings.push(`Used default port for ${name}.`); }
    sessions.push({ id: crypto.randomUUID(), name, type, host, port, username: fields[3] || '', folder });
  }
  return { sessions: sanitizeSessions(sessions), warnings };
}
module.exports = { StateStore, DEFAULT_SETTINGS, sanitizeSessions, importMobaIni, validPort, validateHost };
