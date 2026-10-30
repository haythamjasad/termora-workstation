'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const { randomUUID, createHash } = require('node:crypto');
const { denied, safePath } = require('./jail.cjs');
const { createLogin } = require('./common.cjs');
const { loadOrCreateCertificate } = require('./cert.cjs');
const { createFtpServer } = require('./ftp-server.cjs');
const { createSshServer, createTelnetServer } = require('./shell-servers.cjs');
const { createIperfServer } = require('./iperf.cjs');
const { CronScheduler } = require('./cron.cjs');

const HOST = '127.0.0.1';
const MAX_TFTP_BYTES = 16 * 1024 * 1024;
const MAX_TRANSFERS = 8;
const html = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.pdf': 'application/pdf', '.zip': 'application/zip' };

function errorPacket(code, message) {
  const text = Buffer.from(String(message).slice(0, 160) + '\0');
  const packet = Buffer.alloc(4 + text.length);
  packet.writeUInt16BE(5, 0);
  packet.writeUInt16BE(code, 2);
  text.copy(packet, 4);
  return packet;
}

function closeSocket(socket) {
  return new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } });
}

const TYPES = ['http', 'tftp', 'echo', 'ftp', 'ssh', 'telnet', 'iperf', 'cron'];
const ROOT_REQUIRED = new Set(['http', 'tftp', 'ftp']);
const ROOT_OPTIONAL = new Set(['ssh', 'telnet']);
const LOGIN_REQUIRED = new Set(['ftp', 'ssh', 'telnet']);

function fingerprint(buffer) { return 'SHA256:' + createHash('sha256').update(buffer).digest('base64').replace(/=+$/, ''); }

// The SSH host key persists in the data directory so clients see a stable identity.
function loadOrCreateHostKey(directory) {
  const { utils } = require('ssh2');
  const file = directory && path.join(directory, 'ssh-host-key');
  let key = null;
  if (file) { try { key = fs.readFileSync(file, 'utf8'); } catch {} }
  if (!key || utils.parseKey(key) instanceof Error) {
    key = utils.generateKeyPairSync('ed25519').private;
    if (file) { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(file, key, { mode: 0o600 }); }
  }
  return { key, fingerprint: fingerprint(utils.parseKey(key).getPublicSSH()) };
}

class ServerManager {
  constructor({ dataDir = null, cronJobs = () => [], onCronResult } = {}) {
    this.services = new Map();
    this.closed = false;
    this.dataDir = dataDir;
    this.cron = new CronScheduler({ jobs: cronJobs, onResult: onCronResult });
  }

  list() { return [...this.services.values()].map(service => ({ ...service.info })); }

  cronResults() { return Object.fromEntries(this.cron.results); }
  runCronJob(job) { return this.cron.run(job); }

  async start(config) {
    if (this.closed) throw new Error('Server manager is closed');
    if (!config || !TYPES.includes(config.type)) throw new Error(`Supported server types: ${TYPES.join(', ')}`);
    const port = config.port === undefined || config.port === '' ? 0 : Number(config.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535');
    if (this.services.size >= 16) throw new Error('At most 16 services may run at once');
    if (config.type === 'cron' && [...this.services.values()].some(service => service.info.type === 'cron')) throw new Error('The cron service is already running');
    let root = null;
    if (ROOT_REQUIRED.has(config.type) || (ROOT_OPTIONAL.has(config.type) && config.root)) {
      if (typeof config.root !== 'string' || !path.isAbsolute(config.root)) throw new Error('Choose an absolute existing directory as the root');
      root = await fsp.realpath(config.root);
      if (!(await fsp.stat(root)).isDirectory()) throw new Error('Server root must be a directory');
    }
    // Listening beyond this computer is an explicit choice; tftp/http/echo stay local.
    const listen = config.listen === 'all' && ['ftp', 'ssh', 'telnet', 'iperf'].includes(config.type) ? 'all' : 'local';
    const host = listen === 'all' ? '0.0.0.0' : HOST;
    const login = LOGIN_REQUIRED.has(config.type) ? createLogin({ username: config.username, password: config.password }) : null;
    const shell = config.shell === 'cmd' ? 'cmd' : 'powershell';
    const writable = Boolean(config.writable);
    const id = randomUUID();
    const service = { info: { id, type: config.type, host, listen, port: 0, root, status: 'running', writable: ROOT_REQUIRED.has(config.type) || root ? writable : undefined, username: login?.username }, sockets: new Set(), transfers: new Set(), closing: false };
    if (config.type === 'cron') {
      this.cron.start();
      service.info.host = null; service.info.writable = undefined;
      this.services.set(id, service);
      return { ...service.info };
    }
    if (config.type === 'http') service.server = this._http(service);
    else if (config.type === 'echo') service.server = this._echo(service);
    else if (config.type === 'tftp') service.server = this._tftp(service);
    else if (config.type === 'ftp') {
      const tlsMode = ['explicit', 'implicit'].includes(config.tls) ? config.tls : 'none';
      const credentials = tlsMode === 'none' ? null : loadOrCreateCertificate(this.dataDir);
      if (credentials) { service.info.tls = tlsMode; service.info.certificate = fingerprint(new (require('node:crypto').X509Certificate)(credentials.cert).raw); }
      service.server = createFtpServer(service, { root, host, writable, login, tlsMode, credentials });
    } else if (config.type === 'ssh') {
      const hostKey = loadOrCreateHostKey(this.dataDir);
      service.info.fingerprint = hostKey.fingerprint;
      service.server = createSshServer(service, { hostKey: hostKey.key, login, shell, root, writable, cwd: root || os.homedir() });
    } else if (config.type === 'telnet') service.server = createTelnetServer(service, { login, shell, cwd: root || os.homedir() });
    else if (config.type === 'iperf') {
      service.info.lastResult = null;
      service.server = createIperfServer(service, { onResult: result => { service.info.lastResult = result; } });
    }
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { service.server.off('listening', onListening); reject(error); };
        const onListening = () => { service.server.off('error', onError); resolve(); };
        service.server.once('error', onError);
        service.server.once('listening', onListening);
        if (config.type === 'tftp') service.server.bind(port, HOST);
        else service.server.listen({ port, host, exclusive: true });
      });
      if (this.closed) throw new Error('Server manager closed while starting');
      service.info.port = service.server.address().port;
      // Keep asynchronous errors handled after bind, while making failure visible.
      service.server.on('error', () => { service.info.status = 'error'; });
      this.services.set(id, service);
      return { ...service.info };
    } catch (error) {
      if (config.type === 'tftp') await closeSocket(service.server);
      else { for (const socket of service.sockets) socket.destroy(); try { service.server.close(); } catch {} }
      throw error;
    }
  }

  _http(service) {
    const server = http.createServer(async (request, response) => {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      // Hosted content has no access to the workstation UI and cannot run scripts.
      response.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      const send = (status, message) => {
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(request.method === 'HEAD' ? undefined : message);
      };
      if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); send(405, 'Read-only server'); return; }
      let pathname;
      try { pathname = decodeURIComponent((request.url || '/').split('?')[0]); }
      catch { send(400, 'Invalid URL encoding'); return; }
      try {
        const target = await safePath(service.info.root, pathname);
        if (service.closing || response.destroyed) return;
        const stat = await fsp.stat(target);
        if (stat.isDirectory()) {
          const entries = await fsp.readdir(target, { withFileTypes: true });
          const sorted = entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
          const prefix = pathname.replace(/\/+$/, '') + '/';
          const rows = sorted.slice(0, 1000).map(entry => `<li><a href="${html(prefix + encodeURIComponent(entry.name) + (entry.isDirectory() ? '/' : ''))}">${html(entry.name)}${entry.isDirectory() ? '/' : ''}</a></li>`).join('');
          const body = Buffer.from(`<!doctype html><meta charset="utf-8"><title>Directory</title><h1>${html(pathname)}</h1><ul>${rows}</ul>${entries.length > 1000 ? '<p>First 1000 entries shown.</p>' : ''}`);
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
          response.end(request.method === 'HEAD' ? undefined : body);
        } else if (stat.isFile()) {
          const handle = await fsp.open(target, 'r');
          const actual = await handle.stat();
          if (!actual.isFile()) { await handle.close(); send(403, 'Not a regular file'); return; }
          response.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': actual.size });
          if (request.method === 'HEAD') { await handle.close(); response.end(); return; }
          const stream = handle.createReadStream({ autoClose: true });
          stream.on('error', () => response.destroy());
          response.on('close', () => stream.destroy());
          stream.pipe(response);
        } else send(403, 'Not a regular file');
      } catch (error) {
        if (response.headersSent) { response.destroy(); return; }
        send(error.code === 'EACCES' || error.code === 'EPERM' ? 403 : error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'Not found' : 'Access denied');
      }
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.keepAliveTimeout = 2000;
    server.maxRequestsPerSocket = 16;
    server.maxConnections = 32;
    server.on('connection', socket => {
      service.sockets.add(socket);
      socket.setTimeout(15000, () => socket.destroy());
      socket.on('close', () => service.sockets.delete(socket));
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    return server;
  }

  _echo(service) {
    const server = net.createServer(socket => {
      service.sockets.add(socket);
      let total = 0;
      socket.setTimeout(30000, () => socket.destroy());
      socket.on('data', data => {
        total += data.length;
        if (total > 16 * 1024 * 1024) { socket.destroy(); return; }
        if (!socket.write(data)) socket.pause();
      });
      socket.on('drain', () => socket.resume());
      socket.on('error', () => {});
      socket.on('close', () => service.sockets.delete(socket));
    });
    server.maxConnections = 16;
    return server;
  }

  _tftp(service) {
    const server = dgram.createSocket('udp4');
    let pending = 0;
    const sendError = (socket, peer, code, message) => { try { socket.send(errorPacket(code, message), peer.port, peer.address, () => {}); } catch {} };
    server.on('message', async (message, peer) => {
      if (peer.address !== HOST || service.closing) return;
      if (message.length < 2 || message.length > 1024) { sendError(server, peer, 4, 'Invalid request'); return; }
      const opcode = message.readUInt16BE(0);
      if (opcode === 2) { sendError(server, peer, 2, 'Read-only server; writes are forbidden'); return; }
      if (opcode !== 1) { sendError(server, peer, 4, 'Expected RRQ'); return; }
      const fields = message.subarray(2).toString('utf8').split('\0');
      if (fields.length !== 3 || fields[2] !== '' || !fields[0] || fields[1].toLowerCase() !== 'octet') { sendError(server, peer, 4, 'Only basic octet RRQ is supported'); return; }
      if (pending + service.transfers.size >= MAX_TRANSFERS) { sendError(server, peer, 0, 'Too many transfers'); return; }
      pending++;
      let handle;
      try {
        const target = await safePath(service.info.root, fields[0]);
        const stat = await fsp.stat(target);
        if (!stat.isFile()) throw denied('Not a regular file');
        if (stat.size >= MAX_TFTP_BYTES) throw denied('File must be smaller than 16 MiB');
        handle = await fsp.open(target, 'r');
        const actual = await handle.stat();
        if (!actual.isFile() || actual.size >= MAX_TFTP_BYTES) throw denied('File exceeds size limit');
        if (service.closing) { await handle.close(); return; }
        const socket = dgram.createSocket('udp4');
        const transfer = { socket, handle, size: actual.size, timer: null, deadline: null, closed: false, expectedBlock: 1, packet: null, retries: 0, reading: false, done: null };
        service.transfers.add(transfer);
        handle = null;
        const finish = () => {
          if (transfer.closed) return transfer.done;
          transfer.closed = true;
          clearTimeout(transfer.timer);
          clearTimeout(transfer.deadline);
          service.transfers.delete(transfer);
          transfer.done = Promise.all([closeSocket(socket), transfer.handle.close().catch(() => {})]);
          return transfer.done;
        };
        transfer.finish = finish;
        const send = () => {
          if (transfer.closed) return;
          clearTimeout(transfer.timer);
          socket.send(transfer.packet, peer.port, peer.address, error => { if (error) finish(); });
          transfer.timer = setTimeout(() => { if (++transfer.retries > 5) finish(); else send(); }, 500);
          transfer.timer.unref();
        };
        const readBlock = async () => {
          transfer.reading = true;
          try {
            const block = transfer.expectedBlock;
            const data = Buffer.alloc(512);
            const position = (block - 1) * 512;
            // Do not stream an endlessly growing file past its admitted snapshot size.
            const read = await transfer.handle.read(data, 0, Math.max(0, Math.min(512, transfer.size - position)), position);
            if (transfer.closed) return;
            const packet = Buffer.alloc(4 + read.bytesRead);
            packet.writeUInt16BE(3, 0); packet.writeUInt16BE(block, 2); data.copy(packet, 4, 0, read.bytesRead);
            transfer.packet = packet; transfer.retries = 0; transfer.reading = false; send();
          } catch { finish(); }
        };
        socket.on('error', finish);
        socket.on('message', (ack, sender) => {
          if (sender.port !== peer.port || sender.address !== peer.address) { sendError(socket, sender, 5, 'Unknown transfer ID'); return; }
          if (ack.length >= 2 && ack.readUInt16BE(0) === 5) { finish(); return; }
          if (ack.length !== 4 || ack.readUInt16BE(0) !== 4 || transfer.reading || ack.readUInt16BE(2) !== transfer.expectedBlock) return;
          clearTimeout(transfer.timer);
          if (transfer.packet.length < 516) { finish(); return; }
          transfer.expectedBlock++;
          readBlock();
        });
        transfer.deadline = setTimeout(finish, 60000); transfer.deadline.unref();
        socket.bind(0, HOST, readBlock);
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        sendError(server, peer, error.code === 'ENOENT' ? 1 : 2, error.code === 'ENOENT' ? 'File not found' : 'Access denied');
      } finally { pending--; }
    });
    return server;
  }

  async stop(id) {
    const service = this.services.get(id);
    if (!service) return false;
    this.services.delete(id);
    service.closing = true;
    if (service.info.type === 'cron') { this.cron.stop(); return true; }
    await Promise.all([...service.transfers].map(transfer => transfer.finish()));
    for (const socket of service.sockets) socket.destroy();
    if (service.info.type === 'tftp') await closeSocket(service.server);
    else await new Promise(resolve => { try { service.server.close(resolve); } catch { resolve(); } });
    return true;
  }

  async closeAll() {
    this.closed = true;
    await Promise.all([...this.services.keys()].map(id => this.stop(id)));
  }
}

module.exports = { ServerManager };
