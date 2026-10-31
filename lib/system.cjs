const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns/promises');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { validateHost, validPort } = require('./state.cjs');
function findExecutable(name, candidates = []) {
  for (const candidate of [...candidates, ...(process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, name))]) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}
function installedTools() {
  if (process.platform === 'darwin') {
    const bundledRdp = process.resourcesPath && path.resolve(process.resourcesPath, '../Helpers/TermoraRDP');
    return { powershell: findExecutable('pwsh', ['/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh']), cmd: null, wsl: null, rdp: bundledRdp && fs.existsSync(bundledRdp) ? bundledRdp : null, vnc: '/usr/bin/open', x11: findExecutable('Xquartz', ['/opt/X11/bin/Xquartz']) };
  }
  const root = process.env.SystemRoot || 'C:\\Windows';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return {
    powershell: findExecutable('powershell.exe', [path.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe')]),
    cmd: findExecutable('cmd.exe', [process.env.ComSpec || path.join(root, 'System32/cmd.exe')]),
    wsl: findExecutable('wsl.exe', [path.join(root, 'System32/wsl.exe')]),
    rdp: findExecutable('mstsc.exe', [path.join(root, 'System32/mstsc.exe')]),
    vnc: findExecutable('vncviewer.exe', [path.join(programFiles, 'TigerVNC/vncviewer.exe'), path.join(programFiles, 'RealVNC/VNC Viewer/vncviewer.exe'), path.join(programFiles86, 'RealVNC/VNC Viewer/vncviewer.exe'), path.join(local, 'Programs/TigerVNC/vncviewer.exe')]),
    x11: findExecutable('vcxsrv.exe', [path.join(programFiles, 'VcXsrv/vcxsrv.exe'), path.join(programFiles86, 'VcXsrv/vcxsrv.exe')]),
  };
}
function runProcess(executable, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const add = data => { if (output.length < 1024 * 1024) output += data.toString(); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve((output.trim() || `Process exited with code ${code}.`) + (timedOut ? '\n[Stopped after time limit.]' : '')); });
  });
}
const SERVICE_NAMES = { 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns', 80: 'http', 110: 'pop3', 111: 'rpcbind', 135: 'msrpc', 139: 'netbios', 143: 'imap', 389: 'ldap', 443: 'https', 445: 'smb', 465: 'smtps', 513: 'rlogin', 514: 'rsh', 587: 'submission', 636: 'ldaps', 873: 'rsync', 990: 'ftps', 993: 'imaps', 995: 'pop3s', 1433: 'mssql', 1521: 'oracle', 2049: 'nfs', 3306: 'mysql', 3389: 'rdp', 5201: 'iperf3', 5432: 'postgresql', 5900: 'vnc', 5985: 'winrm', 6000: 'x11', 6379: 'redis', 8080: 'http-alt', 8443: 'https-alt', 9200: 'elasticsearch', 27017: 'mongodb' };
const MAX_SCAN_PORTS = 4096;

// "22,80,8000-8010" -> sorted unique port numbers.
function parsePorts(spec) {
  const ports = new Set();
  for (const part of String(spec || '').split(',').map(value => value.trim()).filter(Boolean)) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!match) throw new Error(`Invalid port list entry "${part}". Use numbers and ranges like 22,80,8000-8100.`);
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start < 1 || end > 65535 || start > end) throw new Error('Ports must be between 1 and 65535, with ranges written low-high.');
    if (ports.size + end - start + 1 > MAX_SCAN_PORTS) throw new Error(`Scan at most ${MAX_SCAN_PORTS} ports at a time.`);
    for (let port = start; port <= end; port++) ports.add(port);
  }
  if (!ports.size) throw new Error('Enter at least one port.');
  return [...ports].sort((a, b) => a - b);
}

function probe(host, port, timeout) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const done = state => { socket.destroy(); resolve(state); };
    socket.setTimeout(timeout, () => done('filtered'));
    socket.once('connect', () => done('open'));
    socket.once('error', error => done(error.code === 'ECONNREFUSED' ? 'closed' : 'filtered'));
  });
}

// TCP connect scan with bounded concurrency; only open ports are listed.
async function scanPorts({ host, ports, timeout = 1500, concurrency = 64 }) {
  const target = validateHost(host), list = parsePorts(ports), started = Date.now();
  const [{ address }] = await dns.lookup(target, { all: true }).catch(() => { throw new Error(`Cannot resolve ${target}.`); });
  const results = new Map();
  let next = 0;
  const worker = async () => { while (next < list.length) { const port = list[next++]; results.set(port, await probe(address, port, timeout)); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  const open = list.filter(port => results.get(port) === 'open');
  const closed = list.filter(port => results.get(port) === 'closed').length;
  return { host: target, address, scanned: list.length, open: open.map(port => ({ port, service: SERVICE_NAMES[port] || '' })), closed, filtered: list.length - open.length - closed, milliseconds: Date.now() - started };
}

function formatScan(result) {
  const lines = [`Scanned ${result.scanned} TCP port${result.scanned === 1 ? '' : 's'} on ${result.host}${result.address !== result.host ? ` (${result.address})` : ''} in ${(result.milliseconds / 1000).toFixed(1)} s.`, ''];
  if (result.open.length) { lines.push('PORT      STATE  SERVICE'); for (const { port, service } of result.open) lines.push(`${String(port).padEnd(9)} open   ${service}`); }
  else lines.push('No open ports found.');
  lines.push('', `${result.closed} closed, ${result.filtered} filtered or timed out.`);
  return lines.join('\n');
}

async function runTool(config) {
  if (config.tool === 'scan') { const result = await scanPorts({ host: config.host, ports: config.ports }); return { ...result, output: formatScan(result) }; }
  const host = validateHost(config.host);
  if (config.tool === 'dns') {
    const answers = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host), dns.resolveMx(host), dns.resolveTxt(host)]);
    return answers.map((answer, index) => `${['A', 'AAAA', 'MX', 'TXT'][index]}\n${answer.status === 'fulfilled' ? JSON.stringify(answer.value, null, 2) : answer.reason.code || answer.reason.message}`).join('\n\n');
  }
  if (config.tool === 'ports') {
    const port = validPort(config.port, 22), start = Date.now();
    return new Promise(resolve => {
      const socket = net.createConnection({ host, port });
      let complete = false;
      const done = message => { if (complete) return; complete = true; socket.destroy(); resolve(message); };
      socket.setTimeout(4000);
      socket.once('connect', () => done(`${host}:${port} is open (${Date.now() - start} ms).`));
      socket.once('error', error => done(`${host}:${port}: ${error.code || error.message}`));
      socket.once('timeout', () => done(`${host}:${port}: connection timed out.`));
    });
  }
  if (config.tool === 'ping') return runProcess(process.platform === 'win32' ? 'ping.exe' : 'ping', process.platform === 'win32' ? ['-n', '4', '-w', '1500', host] : ['-c', '4', host]);
  if (config.tool === 'trace') return runProcess(process.platform === 'win32' ? 'tracert.exe' : 'traceroute', process.platform === 'win32' ? ['-d', '-h', '12', '-w', '500', host] : ['-n', '-m', '12', host], 30000);
  throw new Error('Choose Ping, DNS lookup, Traceroute, TCP port check or Port scanner.');
}
async function launchExternal(config, tools, settings = {}, { onFailure } = {}) {
  const { writeRdpFile, xServerArgs, xdmcpArgs } = require('./remote-desktop.cjs');
  let executable, args, cleanup = null;
  const mac = process.platform === 'darwin';
  if (config.type === 'rdp') { executable = tools.rdp; if (executable) { const file = writeRdpFile(config); args = [file]; cleanup = () => fs.rm(file, { force: true }, () => {}); } }
  else if (config.type === 'vnc') { executable = tools.vnc; const host = validateHost(config.host), port = validPort(config.port, 5900); args = mac ? [`vnc://${host.includes(':') ? `[${host}]` : host}:${port}`] : [`${host}::${port}`]; }
  else if (config.type === 'x11') { executable = tools.x11; args = mac ? [`:${Math.max(0, Math.min(63, Number(settings.x11?.display) || 0))}`] : xServerArgs(settings.x11); }
  else if (config.type === 'xdmcp') { executable = tools.x11; args = xdmcpArgs(config, settings.x11).filter(arg => !mac || !['-wgl', '-clipboard', '-noclipboard'].includes(arg)); }
  else throw new Error('Unknown external application type.');
  if (!executable && mac && config.type === 'rdp') throw new Error('The bundled FreeRDP engine is missing. Install the complete updated Termora Mac build.');
  if (!executable) throw new Error(`${config.type.toUpperCase()} requires an installed ${config.type === 'vnc' ? 'VNC viewer (TigerVNC or RealVNC)' : ['x11', 'xdmcp'].includes(config.type) ? (mac ? 'XQuartz X server' : 'VcXsrv X server') : (mac ? 'bundled FreeRDP engine; install the complete updated Termora Mac build' : 'Remote Desktop client')}. This application does not bundle one.`);
  if (mac && config.type === 'rdp') {
    const modules = path.resolve(path.dirname(executable), '../Frameworks/FreeRDP/ossl-modules');
    if (!fs.existsSync(path.join(modules, 'legacy.dylib'))) { cleanup?.(); throw new Error('The bundled RDP authentication provider is missing. Install the complete updated Termora Mac build.'); }
    const { startRdpClient } = require('./rdp-launch.cjs');
    try { return await startRdpClient(executable, args, { env: { ...process.env, OPENSSL_MODULES: modules }, onFailure }); }
    finally { if (cleanup) setTimeout(cleanup, 120000).unref(); }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: config.type === 'x11' });
    child.once('error', error => { cleanup?.(); reject(error); });
    child.once('spawn', () => { child.unref(); if (cleanup) setTimeout(cleanup, 120000).unref(); resolve({ ok: true, launched: config.type, external: true, args }); });
  });
}
module.exports = { findExecutable, installedTools, runTool, runProcess, launchExternal, parsePorts, scanPorts };
