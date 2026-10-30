const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { validPort, validateHost } = require('./state.cjs');

function clamp(value, fallback, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback; }
const posix = path.posix;
function operation(object, method, ...args) { return new Promise((resolve, reject) => object[method](...args, (error, result) => error ? reject(error) : resolve(result))); }

class TerminalManager {
  constructor({ emit, store, verifyHost }) { this.emit = emit; this.store = store; this.verifyHost = verifyHost; this.sessions = new Map(); this.tunnels = new Map(); this.logging = { enabled: false, directory: '' }; this.logs = new Map(); }
  session(id) { const value = this.sessions.get(id); if (!value) throw new Error('Connection is closed. Open a new connection.'); return value; }
  output(id, data) { const text = String(data); this.logs.get(id)?.write(text); this.emit('terminal:data', { id, data: text }); }
  exited(id, exitCode = 0, error) { this.stopLog(id); this.emit('terminal:exit', { id, exitCode, error: error ? String(error) : undefined }); }
  // Continuous session logs: raw terminal output appended to one file per session.
  setLogging({ enabled, directory } = {}) { this.logging = { enabled: Boolean(enabled), directory: typeof directory === 'string' ? directory : '' }; return this.logging; }
  startLog(state) {
    if (!this.logging.enabled || !this.logging.directory) return;
    try {
      fs.mkdirSync(this.logging.directory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
      const file = path.join(this.logging.directory, `${stamp}_${String(state.label).replace(/[^\w.@-]+/g, '_').slice(0, 80)}.log`);
      const stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 }); stream.on('error', () => this.logs.delete(state.id));
      this.logs.set(state.id, stream); state.logFile = file;
    } catch {}
  }
  stopLog(id) { const stream = this.logs.get(id); if (stream) { this.logs.delete(id); stream.end(); } }
  // Opens an authenticated ssh2 client. With gatewayHost set, the target is
  // reached through a direct-tcpip channel on a separately verified jump host.
  async connectSSH(config, { viaGateway = true } = {}) {
    const { Client } = require('ssh2');
    const host = validateHost(config.host), port = validPort(config.port), username = String(config.username || os.userInfo().username).slice(0, 160);
    if (config.privateKeyPath && fs.statSync(String(config.privateKeyPath)).size > 1024 * 1024) throw new Error('Private key is too large.');
    const privateKey = config.privateKeyPath ? fs.readFileSync(String(config.privateKeyPath)) : undefined;
    if (privateKey && privateKey.length > 1024 * 1024) throw new Error('Private key is too large.');
    const agentPath = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
    let gateway = null, sock;
    if (viaGateway && config.gatewayHost) {
      gateway = await this.connectSSH({ host: config.gatewayHost, port: config.gatewayPort || 22, username: config.gatewayUsername || username, password: config.gatewayPassword, privateKeyPath: config.gatewayPrivateKeyPath, passphrase: config.gatewayPassphrase }, { viaGateway: false });
      try { sock = await operation(gateway.client, 'forwardOut', '127.0.0.1', 0, host, port); }
      catch (error) { gateway.client.end(); throw new Error(`SSH gateway ${gateway.host} could not reach ${host}:${port}: ${error.message}`); }
    }
    const client = new Client();
    const options = { host, port, username, sock, password: config.password || undefined, privateKey, passphrase: config.passphrase || undefined,
      agent: config.agentForward || (!privateKey && !config.password) ? agentPath : undefined, agentForward: Boolean(config.agentForward && agentPath),
      readyTimeout: 30000, keepaliveInterval: 15000, keepaliveCountMax: 3,
      algorithms: config.compression ? { compress: ['zlib@openssh.com', 'zlib', 'none'] } : undefined,
      hostVerifier: (key, callback) => {
        const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        Promise.resolve(this.verifyHost({ host, port, fingerprint })).then(Boolean).then(callback, () => callback(false));
      },
    };
    try { await new Promise((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect(options); }); }
    catch (error) { client.end(); gateway?.client.end(); throw error; }
    if (gateway) client.on('close', () => gateway.client.end());
    return { client, host, port, username, gateway: gateway ? { host: gateway.host, port: gateway.port } : null };
  }
  async open(config = {}) {
    const type = config.type || 'local', id = crypto.randomUUID();
    const cols = clamp(config.cols, 100, 10, 500), rows = clamp(config.rows, 30, 2, 300);
    if (type === 'local' || type === 'wsl') {
      const pty = require('@lydell/node-pty');
      let shell, args;
      if (type === 'wsl') {
        shell = 'wsl.exe'; args = [];
        if (config.distribution) {
          const distribution = String(config.distribution);
          if (/[\r\n\0]/.test(distribution) || distribution.length > 200) throw new Error('Invalid WSL distribution name.');
          args.push('-d', distribution);
        }
        if (config.cwd && (String(config.cwd).startsWith('/') || String(config.cwd).startsWith('~'))) args.push('--cd', String(config.cwd));
      }
      else if (config.shell === 'cmd') { shell = process.env.ComSpec || 'cmd.exe'; args = []; }
      else if (process.platform === 'win32') { shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); args = ['-NoLogo']; }
      else { shell = process.env.SHELL || '/bin/bash'; args = ['-l']; }
      const linuxCwd = type === 'wsl' && config.cwd && (String(config.cwd).startsWith('/') || String(config.cwd).startsWith('~'));
      const cwd = config.cwd && !linuxCwd ? path.resolve(String(config.cwd)) : os.homedir();
      if (!fs.statSync(cwd).isDirectory()) throw new Error('Terminal working directory must be a folder.');
      const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      delete env.ELECTRON_RUN_AS_NODE;
      // The desktop may be launched by a tool-managed PowerShell. Its module
      // search path can point at that tool's private PSReadLine copy, causing
      // Windows PowerShell to prompt about an untrusted publisher before the
      // first command. Let the selected shell rebuild its normal module path.
      for (const key of Object.keys(env)) if (['psmodulepath', 'psmoduleanalysiscachepath'].includes(key.toLowerCase())) delete env[key];
      const terminal = pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env, useConpty: true });
      this.sessions.set(id, { id, kind: type, pty: terminal, cwd, label: config.name || (type === 'wsl' ? 'WSL' : process.platform !== 'win32' ? path.basename(shell) : config.shell === 'cmd' ? 'Command Prompt' : 'PowerShell') }); this.startLog(this.sessions.get(id));
      terminal.onData(data => this.output(id, data));
      terminal.onExit(({ exitCode }) => { if (this.sessions.delete(id)) this.exited(id, exitCode); });
      return { id, label: this.sessions.get(id).label, kind: type };
    }
    if (type === 'ssh' || type === 'sftp') {
      const connection = await this.connectSSH(config);
      const state = { id, kind: 'ssh', ...connection, transfer: config.browserProtocol === 'scp' ? 'scp' : 'sftp', label: config.name || `${connection.username}@${connection.host}` };
      this.sessions.set(id, state); this.startLog(state);
      connection.client.on('error', error => { this.output(id, `\r\nSSH: ${error.message}\r\n`); });
      connection.client.on('close', () => { if (this.sessions.delete(id)) this.exited(id, 0); });
      if (connection.gateway) this.output(id, `Connected through SSH gateway ${connection.gateway.host}:${connection.gateway.port}.\r\n`);
      try {
        state.sftp = await operation(connection.client, 'sftp');
      } catch (error) { state.sftpError = error.message; }
      if (type !== 'sftp') {
        const display = clamp(config.x11Display, 0, 0, 63);
        if (config.x11) connection.client.on('x11', (info, accept, reject) => {
          // Relay each remote X client to the local display (VcXsrv listens on 6000 + display).
          const socket = net.createConnection({ host: '127.0.0.1', port: 6000 + display });
          socket.once('error', () => reject());
          socket.once('connect', () => { const channel = accept(); channel.on('error', () => socket.destroy()); socket.on('error', () => channel.destroy()); socket.pipe(channel).pipe(socket); socket.on('close', () => channel.destroy()); });
        });
        try { state.stream = await operation(connection.client, 'shell', { term: 'xterm-256color', cols, rows }, config.x11 ? { x11: { single: false, screen: 0 } } : {}); }
        catch (error) { this.close(id); throw error; }
        state.stream.on('data', data => this.output(id, data.toString()));
        state.stream.stderr.on('data', data => this.output(id, data.toString()));
        state.stream.on('close', (code) => { if (this.sessions.delete(id)) this.exited(id, code || 0); connection.client.end(); });
        const command = String(config.startupCommand || '').trim();
        if (command) state.stream.write(`${command.slice(0, 4000)}\n`);
      } else { this.output(id, 'SFTP connected. Use the file browser to transfer files.\r\n'); }
      return { id, label: state.label, kind: type };
    }
    if (type === 'mosh') {
      // Like the official client: start mosh-server over SSH, read its UDP port and key, then leave SSH.
      const { MoshClient, MOSH_CONNECT } = require('./mosh.cjs');
      const server = String(config.moshServer || 'mosh-server').trim(), locale = String(config.moshLocale || 'en_US.UTF-8').trim(), ports = String(config.moshPorts || '').trim();
      if (!/^[\w./~-]{1,200}$/.test(server)) throw new Error('Enter the mosh-server command as a plain path.');
      if (!/^[\w.@-]{1,60}$/.test(locale)) throw new Error('Enter a locale such as en_US.UTF-8.');
      if (ports && !/^\d{1,5}(:\d{1,5})?$/.test(ports)) throw new Error('Enter a UDP port or range such as 60000:61000.');
      const connection = await this.connectSSH(config);
      let match;
      try {
        match = await new Promise((resolve, reject) => connection.client.exec(`${server} new -s -c 256 -l LANG=${locale}${ports ? ` -p ${ports}` : ''}`, { pty: { term: 'xterm-256color', cols, rows } }, (error, stream) => {
          if (error) { reject(error); return; }
          let output = '';
          const timer = setTimeout(() => { stream.close(); reject(new Error('mosh-server did not start within 20 seconds.')); }, 20000);
          const seen = data => { output += data.toString(); const found = MOSH_CONNECT.exec(output); if (found) { clearTimeout(timer); resolve(found); } };
          stream.on('data', seen); stream.stderr.on('data', seen);
          stream.on('close', code => { clearTimeout(timer); if (!MOSH_CONNECT.test(output)) reject(new Error(code === 127 || /not found/i.test(output) ? 'mosh-server is not installed on the remote host.' : `mosh-server failed: ${output.trim().slice(-400) || `exit code ${code}`}`)); });
        }));
      } finally { connection.client.end(); }
      const state = { id, kind: 'mosh', label: config.name || `${connection.username}@${connection.host}` };
      state.mosh = new MoshClient({ host: connection.host, port: Number(match[1]), key: match[2], cols, rows,
        onData: data => this.output(id, data),
        onExit: (code, error) => { if (error) this.output(id, `\r\n${error}\r\n`); if (this.sessions.delete(id)) this.exited(id, code); } });
      this.sessions.set(id, state); this.startLog(state);
      try { await state.mosh.start(); } catch (error) { this.sessions.delete(id); throw error; }
      return { id, label: state.label, kind: type };
    }
    if (type === 'rlogin' || type === 'rsh') {
      const host = validateHost(config.host), username = String(config.username || os.userInfo().username).slice(0, 160);
      const command = String(config.startupCommand || '').trim();
      const exec = type === 'rsh' && command;
      // The two standard ports follow the mode; any other port is used as given.
      let port = validPort(config.port, exec ? 514 : 513);
      if (exec && port === 513) port = 514; else if (!exec && port === 514) port = 513;
      const socket = await connectReserved(host, port);
      const local = os.userInfo().username.slice(0, 160);
      // RFC 1282 rlogin handshake, or the rsh/rexec-style command request (no separate stderr port).
      socket.write(exec ? Buffer.from(`0\0${local}\0${username}\0${command.slice(0, 4000)}\0`) : Buffer.from(`\0${local}\0${username}\0xterm-256color/38400\0`));
      const first = await new Promise((resolve, reject) => { socket.once('data', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('The remote host closed the connection.'))); });
      if (first[0] !== 0) { socket.destroy(); throw new Error(`${exec ? 'Rsh' : 'Rlogin'} refused: ${first.subarray(1).toString('utf8').trim() || 'permission denied'}`); }
      const state = { id, kind: type, socket, rlogin: !exec, label: config.name || `${username}@${host}` };
      this.sessions.set(id, state); this.startLog(state);
      if (first.length > 1) this.output(id, first.subarray(1).toString('utf8'));
      if (!exec) socket.write(rloginWindow(rows, cols));
      socket.on('data', data => this.output(id, data.toString('utf8')));
      socket.on('error', error => this.output(id, `\r\n${error.message}\r\n`));
      socket.on('close', () => { if (this.sessions.delete(id)) this.exited(id); });
      return { id, label: state.label, kind: type };
    }
    if (type === 'telnet') {
      const host = validateHost(config.host), port = validPort(config.port, 23);
      const socket = net.createConnection({ host, port });
      const state = { id, kind: 'telnet', socket, label: config.name || `${host}:${port}` };
      this.sessions.set(id, state);
      socket.setTimeout(30000);
      try { await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); socket.once('timeout', () => { socket.destroy(); reject(new Error('Telnet connection timed out.')); }); }); }
      catch (error) { this.sessions.delete(id); socket.destroy(); throw error; }
      socket.setTimeout(0); this.startLog(state);
      const decoder = new TelnetDecoder(socket);
      socket.on('data', data => this.output(id, decoder.decode(data).toString('utf8')));
      socket.on('error', error => this.output(id, `\r\n${error.message}\r\n`));
      socket.on('close', () => { if (this.sessions.delete(id)) this.exited(id); });
      return { id, label: state.label, kind: type };
    }
    if (type === 'serial') {
      const { SerialPort } = require('serialport');
      const portPath = String(config.path || config.host || '');
      if (!portPath || portPath.includes('\0')) throw new Error('Choose a serial port.');
      const serial = new SerialPort({ path: portPath, baudRate: clamp(config.baudRate, 9600, 50, 4000000), autoOpen: false,
        dataBits: [5, 6, 7, 8].includes(Number(config.dataBits)) ? Number(config.dataBits) : 8,
        stopBits: Number(config.stopBits) === 2 ? 2 : 1,
        parity: ['none', 'even', 'odd', 'mark', 'space'].includes(config.parity) ? config.parity : 'none' });
      await operation(serial, 'open');
      this.sessions.set(id, { id, kind: type, serial, label: config.name || portPath }); this.startLog(this.sessions.get(id));
      serial.on('data', data => this.output(id, data.toString('utf8')));
      serial.on('error', error => this.output(id, `\r\nSerial: ${error.message}\r\n`));
      serial.on('close', () => { if (this.sessions.delete(id)) this.exited(id); });
      return { id, kind: type, label: config.name || portPath };
    }
    throw new Error(`Session type "${type}" is not an embedded terminal. Use its dedicated launcher.`);
  }
  write({ id, data }) {
    const state = this.session(id);
    if (typeof data !== 'string' || data.length > 1024 * 1024) throw new Error('Terminal input is invalid or too large.');
    if (state.pty) state.pty.write(data);
    else if (state.stream) state.stream.write(data);
    else if (state.socket) state.socket.write(data);
    else if (state.serial) state.serial.write(data);
    else if (state.mosh) state.mosh.write(data);
    else throw new Error('This connection does not have an interactive shell.');
  }
  resize({ id, cols, rows }) { const state = this.session(id); cols = clamp(cols, 100, 10, 500); rows = clamp(rows, 30, 2, 300); if (state.pty) state.pty.resize(cols, rows); if (state.stream) state.stream.setWindow(rows, cols, 0, 0); if (state.rlogin) state.socket.write(rloginWindow(rows, cols)); state.mosh?.resize(cols, rows); }
  // Embedded VNC: authenticated here, then relayed to the noVNC viewer as binary IPC.
  async openVnc(config = {}) {
    const { connectVnc, ViewerBridge } = require('./vnc.cjs');
    const host = validateHost(config.host), port = validPort(config.port, 5900);
    const { socket, leftover, security } = await connectVnc({ host, port, password: config.password });
    const id = crypto.randomUUID(), state = { id, kind: 'vnc', socket, label: config.name || `${host}:${port}` };
    state.viewer = new ViewerBridge({ socket, leftover, send: data => this.emit('vnc:data', { id, data }) });
    socket.on('data', data => state.viewer.fromServer(data));
    socket.on('error', () => {});
    socket.on('close', () => { if (this.sessions.delete(id)) this.exited(id); });
    this.sessions.set(id, state);
    return { id, kind: 'vnc', label: state.label, security };
  }
  vncStart(id) { const state = this.session(id); if (!state.viewer) throw new Error('This is not a VNC session.'); state.viewer.start(); return { ok: true }; }
  vncWrite({ id, data } = {}) {
    const state = this.session(id);
    if (!state.viewer) throw new Error('This is not a VNC session.');
    if (!(data instanceof Uint8Array) || data.length > 4 * 1024 * 1024) throw new Error('Invalid VNC data.');
    try { state.viewer.fromViewer(Buffer.from(data)); } catch (error) { this.close(id); throw error; }
  }
  scpConnection(id) { const state = this.session(id); if (!state.client) throw new Error('SCP requires an SSH connection.'); return state.client; }
  scpUpload(id, localPath, remotePath) { return require('./scp.cjs').scpUpload(this.scpConnection(id), localPath, remotePath); }
  scpDownload(id, remotePath, localPath) { return require('./scp.cjs').scpDownload(this.scpConnection(id), remotePath, localPath); }
  close(id) { const state = this.sessions.get(id); if (!state) return; this.sessions.delete(id); try { state.pty?.kill(); state.stream?.close(); state.client?.end(); state.socket?.destroy(); state.ftp?.close(); state.mosh?.close(); if (state.serial?.isOpen) state.serial.close(); } catch {} this.exited(id); }
  async openFiles(config) {
    if (config.type === 'sftp' || config.type === 'ssh') return this.open({ ...config, type: 'sftp' });
    if (config.type === 's3') {
      const { S3Client } = require('./s3.cjs');
      const s3 = new S3Client({ endpoint: config.host, region: config.region, accessKeyId: config.username, secretAccessKey: config.password, pathStyle: config.pathStyle === undefined ? undefined : Boolean(config.pathStyle) });
      const bucket = String(config.path || '').replace(/^\/+|\/+$/g, '');
      if (bucket && !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) throw new Error('Bucket names use lowercase letters, digits, dots and dashes.');
      // Verify the credentials before the tab opens.
      if (bucket) await s3.list(bucket, ''); else await s3.listBuckets();
      const id = crypto.randomUUID(), label = config.name || (bucket ? `s3://${bucket}` : s3.url.host);
      this.sessions.set(id, { id, kind: 's3', s3, bucket, label });
      return { id, kind: 's3', label };
    }
    if (!['ftp', 'ftps'].includes(config.type)) throw new Error('Choose FTP, FTPS, SFTP or S3.');
    const { Client } = require('basic-ftp');
    const ftp = new Client(30000);
    try { await ftp.access({ host: validateHost(config.host), port: validPort(config.port, 21), user: config.username || 'anonymous', password: config.password || '', secure: config.type === 'ftps' ? (config.ftpsMode === 'implicit' ? 'implicit' : true) : false }); }
    catch (error) { ftp.close(); throw error; }
    const id = crypto.randomUUID();
    this.sessions.set(id, { id, kind: config.type, ftp, label: config.name || config.host });
    return { id, kind: config.type, label: config.name || config.host };
  }
  async listSerialPorts() { try { return await require('serialport').SerialPort.list(); } catch { return []; } }
  listTunnels() { return [...this.tunnels.values()].map(({ id, name, mode, localHost, localPort, remoteHost, remotePort, host }) => ({ id, name, mode, localHost, localPort, remoteHost, remotePort, host })); }
  async createTunnel(config) {
    if (config.localHost && config.localHost !== '127.0.0.1' && config.localHost !== 'localhost') throw new Error('Tunnels bind to localhost only.');
    const mode = config.mode || 'local';
    if (!['local', 'remote', 'dynamic'].includes(mode)) throw new Error('Choose local, remote, or dynamic tunnel mode.');
    const localPort = validPort(config.localPort, 8080), remotePort = mode === 'dynamic' ? null : validPort(config.remotePort, 80);
    const remoteHost = mode === 'dynamic' ? null : mode === 'remote' ? '127.0.0.1' : validateHost(config.remoteHost || '127.0.0.1');
    const connection = await this.connectSSH(config), id = crypto.randomUUID();
    const sockets = new Set();
    const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy()); };
    let server;
    if (mode === 'remote') {
      connection.client.on('tcp connection', (details, accept, reject) => {
        if (details.destPort !== remotePort || !['127.0.0.1', 'localhost'].includes(details.destIP)) { reject(); return; }
        const socket = net.createConnection({ host: '127.0.0.1', port: localPort }); track(socket);
        socket.once('connect', () => { const channel = accept(); track(channel); channel.on('error', () => socket.destroy()); socket.pipe(channel).pipe(socket); socket.once('close', () => channel.destroy()); });
        socket.once('error', () => reject());
      });
    } else {
      server = net.createServer(socket => {
        track(socket);
        if (mode === 'dynamic') { attachSocks5(socket, connection.client, track); return; }
        connection.client.forwardOut('127.0.0.1', socket.remotePort || 0, remoteHost, remotePort, (error, channel) => {
          if (error) { socket.destroy(); return; }
          track(channel); channel.on('error', () => socket.destroy()); socket.pipe(channel).pipe(socket); socket.on('close', () => channel.destroy());
        });
      });
    }
    try {
      if (mode === 'remote') await operation(connection.client, 'forwardIn', '127.0.0.1', remotePort);
      else await new Promise((resolve, reject) => { server.once('error', reject); server.listen(localPort, '127.0.0.1', resolve); });
    }
    catch (error) { connection.client.end(); throw error; }
    server?.on('error', () => this.closeTunnel(id));
    connection.client.on('error', () => this.closeTunnel(id));
    connection.client.on('close', () => this.closeTunnel(id));
    this.tunnels.set(id, { id, name: String(config.name || (mode === 'dynamic' ? `SOCKS5 :${localPort}` : `${mode === 'remote' ? 'Remote' : 'Local'} ${localPort} ↔ ${remoteHost}:${remotePort}`)), mode, localHost: '127.0.0.1', localPort, remoteHost, remotePort, host: connection.host, server, client: connection.client, sockets });
    return this.listTunnels().find(tunnel => tunnel.id === id);
  }
  closeTunnel(id) { const state = this.tunnels.get(id); if (!state) return this.listTunnels(); this.tunnels.delete(id); for (const socket of state.sockets) socket.destroy(); state.server?.close(); if (state.mode === 'remote') state.client.unforwardIn('127.0.0.1', state.remotePort, () => state.client.end()); else state.client.end(); return this.listTunnels(); }
  closeAll() { for (const id of [...this.sessions.keys()]) this.close(id); for (const id of [...this.tunnels.keys()]) this.closeTunnel(id); }
}

// rlogin window-size control message: magic 0xff 0xff 's' 's', then rows, cols, x/y pixels.
function rloginWindow(rows, cols) { const message = Buffer.alloc(12); message.write('\xff\xffss', 0, 'latin1'); message.writeUInt16BE(rows, 4); message.writeUInt16BE(cols, 6); return message; }
// Classic r-services expect a client source port in 512–1023; fall back to an
// ephemeral port when none can be bound so modern lenient servers still work.
async function connectReserved(host, port) {
  const attempt = localPort => new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, localPort });
    socket.setTimeout(30000, () => { socket.destroy(); reject(Object.assign(new Error('Connection timed out.'), { code: 'ETIMEDOUT' })); });
    socket.once('connect', () => { socket.setTimeout(0); resolve(socket); });
    socket.once('error', reject);
  });
  for (let localPort = 1023; localPort >= 512; localPort--) {
    try { return await attempt(localPort); }
    catch (error) { if (!['EADDRINUSE', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  return attempt(undefined);
}

function attachSocks5(socket, client, track = () => {}) {
  let pending = Buffer.alloc(0), stage = 'greeting';
  socket.setTimeout(30000, () => socket.destroy());
  const fail = code => { socket.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); };
  const onData = data => {
    pending = Buffer.concat([pending, data]);
    if (pending.length > 65536) { socket.destroy(); return; }
    if (stage === 'greeting') {
      if (pending.length < 2) return;
      if (pending[0] !== 5 || pending[1] === 0) { socket.destroy(); return; }
      const length = 2 + pending[1]; if (pending.length < length) return;
      if (!pending.subarray(2, length).includes(0)) { socket.end(Buffer.from([5, 255])); return; }
      pending = pending.subarray(length); stage = 'request'; socket.write(Buffer.from([5, 0]));
    }
    if (stage !== 'request' || pending.length < 4) return;
    if (pending[0] !== 5 || pending[1] !== 1 || pending[2] !== 0) { fail(7); stage = 'done'; return; }
    let host, length;
    if (pending[3] === 1) { length = 10; if (pending.length < length) return; host = [...pending.subarray(4, 8)].join('.'); }
    else if (pending[3] === 3) { if (pending.length < 5) return; length = 7 + pending[4]; if (pending.length < length) return; host = pending.subarray(5, length - 2).toString('utf8'); }
    else if (pending[3] === 4) { length = 22; if (pending.length < length) return; host = Array.from({ length: 8 }, (_, index) => pending.readUInt16BE(4 + index * 2).toString(16)).join(':'); }
    else { fail(8); stage = 'done'; return; }
    const port = pending.readUInt16BE(length - 2);
    try { validateHost(host); validPort(port); } catch { fail(4); stage = 'done'; return; }
    const earlyData = pending.subarray(length); pending = Buffer.alloc(0); stage = 'connecting'; socket.pause(); socket.removeListener('data', onData);
    client.forwardOut('127.0.0.1', socket.remotePort || 0, host, port, (error, channel) => {
      if (error || socket.destroyed) { channel?.destroy(); if (!socket.destroyed) fail(5); return; }
      track(channel); socket.setTimeout(0); channel.on('error', () => socket.destroy()); socket.on('close', () => channel.destroy());
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); if (earlyData.length) channel.write(earlyData);
      socket.pipe(channel).pipe(socket); socket.resume();
    });
  };
  socket.on('data', onData);
}

class TelnetDecoder {
  constructor(socket) { this.socket = socket; this.pending = Buffer.alloc(0); }
  decode(input) {
    const data = Buffer.concat([this.pending, input]), out = []; this.pending = Buffer.alloc(0);
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 255) { out.push(data[i]); continue; }
      if (i + 1 >= data.length) { this.pending = data.subarray(i); break; }
      const command = data[++i];
      if (command === 255) { out.push(255); continue; }
      if (command === 250) {
        let end = i + 1; while (end + 1 < data.length && !(data[end] === 255 && data[end + 1] === 240)) end++;
        if (end + 1 >= data.length) { this.pending = data.subarray(i - 1); break; } i = end + 1; continue;
      }
      if ([251, 252, 253, 254].includes(command)) {
        if (i + 1 >= data.length) { this.pending = data.subarray(i - 1); break; }
        const option = data[++i];
        // Accept server ECHO/SUPPRESS-GO-AHEAD, reject other options explicitly.
        if (command === 251) this.socket.write(Buffer.from([255, [1, 3].includes(option) ? 253 : 254, option]));
        else if (command === 253) this.socket.write(Buffer.from([255, option === 3 ? 251 : 252, option]));
      }
    }
    if (this.pending.length > 65536) this.pending = Buffer.alloc(0);
    return Buffer.from(out);
  }
}
module.exports = { TerminalManager, TelnetDecoder, operation, clamp, attachSocks5, rloginWindow };
