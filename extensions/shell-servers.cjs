'use strict';

// SSH (shell, exec and SFTP) and Telnet servers backed by a local shell.
const fsp = require('node:fs').promises;
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { safePath, safeTarget, virtual } = require('./jail.cjs');
const { shellCommand, shellEnvironment, spawnShell, plainAddress } = require('./common.cjs');
const { listLine } = require('./ftp-server.cjs');

const MAX_HANDLES = 64;
const MAX_READ = 256 * 1024;

function attributes(stat) {
  return { mode: (stat.isDirectory() ? 0o040755 : 0o100644), uid: 0, gid: 0, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) };
}

// Serves the SFTP subsystem from root. Paths are virtual, rooted at "/".
function attachSftp(sftp, { root, writable }) {
  const { STATUS_CODE, OPEN_MODE, flagsToString } = require('ssh2').utils.sftp;
  const handles = new Map();
  let counter = 0;
  const status = (id, code, message) => sftp.status(id, code, message);
  const fail = (id, error) => {
    const code = error.code === 'ENOENT' || error.code === 'ENOTDIR' ? STATUS_CODE.NO_SUCH_FILE : error.code === 'EACCES' || error.code === 'EPERM' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE;
    status(id, code, error.code === 'EACCES' ? error.message : undefined);
  };
  const guard = (id, needsWrite, work) => {
    if (needsWrite && !writable) { status(id, STATUS_CODE.PERMISSION_DENIED, 'This server is read-only'); return; }
    Promise.resolve().then(work).catch(error => fail(id, error));
  };
  const newHandle = value => {
    if (handles.size >= MAX_HANDLES) throw Object.assign(new Error('Too many open handles'), { code: 'EMFILE' });
    const key = Buffer.alloc(4); key.writeUInt32BE(++counter >>> 0); handles.set(key.toString('hex'), value); return key;
  };
  const lookup = handle => handles.get(Buffer.from(handle).toString('hex'));

  sftp.on('REALPATH', (id, requested) => sftp.name(id, [{ filename: virtual('/', requested), longname: virtual('/', requested), attrs: {} }]));
  sftp.on('STAT', (id, requested) => guard(id, false, async () => sftp.attrs(id, attributes(await fsp.stat(await safePath(root, virtual('/', requested)))))));
  sftp.on('LSTAT', (id, requested) => guard(id, false, async () => sftp.attrs(id, attributes(await fsp.stat(await safePath(root, virtual('/', requested)))))));
  sftp.on('OPEN', (id, filename, flags) => {
    const writing = Boolean(flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC));
    guard(id, writing, async () => {
      const mode = flagsToString(flags);
      if (!mode) { status(id, STATUS_CODE.OP_UNSUPPORTED); return; }
      const target = writing ? await safeTarget(root, virtual('/', filename)) : await safePath(root, virtual('/', filename));
      const file = await fsp.open(target, mode);
      if (!(await file.stat()).isFile()) { await file.close(); status(id, STATUS_CODE.FAILURE, 'Not a regular file'); return; }
      try { sftp.handle(id, newHandle({ file })); } catch (error) { await file.close(); throw error; }
    });
  });
  sftp.on('READ', (id, handle, offset, length) => guard(id, false, async () => {
    const entry = lookup(handle);
    if (!entry?.file) { status(id, STATUS_CODE.FAILURE, 'Invalid handle'); return; }
    const buffer = Buffer.alloc(Math.min(length, MAX_READ));
    const { bytesRead } = await entry.file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) status(id, STATUS_CODE.EOF); else sftp.data(id, buffer.subarray(0, bytesRead));
  }));
  sftp.on('WRITE', (id, handle, offset, data) => guard(id, true, async () => {
    const entry = lookup(handle);
    if (!entry?.file) { status(id, STATUS_CODE.FAILURE, 'Invalid handle'); return; }
    await entry.file.write(data, 0, data.length, offset); status(id, STATUS_CODE.OK);
  }));
  sftp.on('FSTAT', (id, handle) => guard(id, false, async () => {
    const entry = lookup(handle);
    if (!entry) { status(id, STATUS_CODE.FAILURE, 'Invalid handle'); return; }
    sftp.attrs(id, attributes(entry.file ? await entry.file.stat() : await fsp.stat(entry.directory)));
  }));
  const setTimes = async (id, target, attrs) => {
    if (writable && attrs && Number.isFinite(attrs.mtime)) await fsp.utimes(target, attrs.atime ?? attrs.mtime, attrs.mtime);
    status(id, STATUS_CODE.OK);
  };
  sftp.on('SETSTAT', (id, requested, attrs) => guard(id, false, async () => setTimes(id, await safePath(root, virtual('/', requested)), attrs)));
  sftp.on('FSETSTAT', (id, handle, attrs) => guard(id, false, async () => {
    const entry = lookup(handle);
    if (entry?.file && writable && attrs && Number.isFinite(attrs.mtime)) await entry.file.utimes(attrs.atime ?? attrs.mtime, attrs.mtime);
    status(id, STATUS_CODE.OK);
  }));
  sftp.on('CLOSE', (id, handle) => guard(id, false, async () => {
    const key = Buffer.from(handle).toString('hex'), entry = handles.get(key);
    if (!entry) { status(id, STATUS_CODE.FAILURE, 'Invalid handle'); return; }
    handles.delete(key); await entry.file?.close(); status(id, STATUS_CODE.OK);
  }));
  sftp.on('OPENDIR', (id, requested) => guard(id, false, async () => {
    const directory = await safePath(root, virtual('/', requested));
    if (!(await fsp.stat(directory)).isDirectory()) { status(id, STATUS_CODE.FAILURE, 'Not a directory'); return; }
    sftp.handle(id, newHandle({ directory, names: null }));
  }));
  sftp.on('READDIR', (id, handle) => guard(id, false, async () => {
    const entry = lookup(handle);
    if (!entry?.directory) { status(id, STATUS_CODE.FAILURE, 'Invalid handle'); return; }
    entry.names ??= (await fsp.readdir(entry.directory)).slice(0, 10000);
    if (!entry.names.length) { status(id, STATUS_CODE.EOF); return; }
    const batch = entry.names.splice(0, 100), names = [];
    for (const name of batch) {
      try { const stat = await fsp.stat(path.join(entry.directory, name)); names.push({ filename: name, longname: listLine(name, stat), attrs: attributes(stat) }); } catch {}
    }
    if (names.length) sftp.name(id, names); else status(id, STATUS_CODE.EOF);
  }));
  sftp.on('REMOVE', (id, requested) => guard(id, true, async () => {
    const target = await safePath(root, virtual('/', requested));
    if (!(await fsp.lstat(target)).isFile()) { status(id, STATUS_CODE.FAILURE, 'Not a regular file'); return; }
    await fsp.unlink(target); status(id, STATUS_CODE.OK);
  }));
  sftp.on('RMDIR', (id, requested) => guard(id, true, async () => {
    const next = virtual('/', requested);
    if (next === '/') { status(id, STATUS_CODE.PERMISSION_DENIED, 'The root cannot be removed'); return; }
    await fsp.rmdir(await safePath(root, next)); status(id, STATUS_CODE.OK);
  }));
  sftp.on('MKDIR', (id, requested) => guard(id, true, async () => { await fsp.mkdir(await safeTarget(root, virtual('/', requested))); status(id, STATUS_CODE.OK); }));
  sftp.on('RENAME', (id, from, to) => guard(id, true, async () => {
    const source = virtual('/', from);
    if (source === '/') { status(id, STATUS_CODE.PERMISSION_DENIED); return; }
    const sourcePath = await safePath(root, source), target = await safeTarget(root, virtual('/', to));
    try { await fsp.lstat(target); status(id, STATUS_CODE.FAILURE, 'Destination already exists'); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fsp.rename(sourcePath, target); status(id, STATUS_CODE.OK);
  }));
  for (const event of ['READLINK', 'SYMLINK']) sftp.on(event, id => status(id, STATUS_CODE.OP_UNSUPPORTED));
  sftp.on('close', () => { for (const entry of handles.values()) entry.file?.close().catch(() => {}); handles.clear(); });
}

function createSshServer(service, { hostKey, login, shell, root, writable, cwd }) {
  const { Server } = require('ssh2');
  const server = new Server({ hostKeys: [hostKey], ident: 'Termora' }, (client, info) => {
    const peer = plainAddress(info.ip);
    const handle = { destroy: () => client.end() };
    service.sockets.add(handle);
    client.on('close', () => service.sockets.delete(handle));
    client.on('error', () => {});
    let attempts = 0;
    client.on('authentication', context => {
      if (context.method !== 'password') { context.reject(['password']); return; }
      if (login.check(context.username, context.password, peer)) { context.accept(); return; }
      if (++attempts >= 3) { client.end(); return; }
      setTimeout(() => context.reject(['password']), 500);
    });
    // Port forwarding and other global requests are not offered.
    client.on('tcpip', (_accept, reject) => reject?.());
    client.on('request', (_accept, reject) => reject?.());
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      let size = { cols: 80, rows: 24 }, terminal = null;
      session.on('pty', (ok, _reject, info) => { size = { cols: info.cols || 80, rows: info.rows || 24 }; ok?.(); });
      session.on('window-change', (ok, _reject, info) => { size = { cols: info.cols, rows: info.rows }; try { terminal?.resize(Math.max(10, info.cols), Math.max(2, info.rows)); } catch {} ok?.(); });
      session.on('env', (ok) => ok?.());
      session.on('shell', ok => {
        const stream = ok();
        try { terminal = spawnShell(shell, { ...size, cwd }); }
        catch (error) { stream.stderr.write(`Cannot start shell: ${error.message}\r\n`); stream.exit(1); stream.end(); return; }
        terminal.onData(data => stream.write(data));
        terminal.onExit(({ exitCode }) => { try { stream.exit(exitCode || 0); stream.end(); } catch {} });
        stream.on('data', data => terminal.write(data.toString('utf8')));
        stream.on('close', () => { try { terminal.kill(); } catch {} });
      });
      session.on('exec', (ok, _reject, info) => {
        const stream = ok();
        const [file, args] = shellCommand(shell).exec(String(info.command).slice(0, 32768));
        const child = spawn(file, args, { cwd, env: shellEnvironment(), windowsHide: true });
        child.stdout.on('data', data => stream.write(data));
        child.stderr.on('data', data => stream.stderr.write(data));
        stream.on('data', data => child.stdin.write(data));
        stream.on('end', () => child.stdin.end());
        child.stdin.on('error', () => {});
        child.on('error', error => { stream.stderr.write(`${error.message}\n`); stream.exit(127); stream.end(); });
        child.on('close', code => { try { stream.exit(code ?? 1); stream.end(); } catch {} });
        stream.on('close', () => { if (child.exitCode === null) child.kill(); });
      });
      session.on('sftp', (ok, reject) => { if (!root) { reject?.(); return; } attachSftp(ok(), { root, writable }); });
      session.on('subsystem', (_ok, reject) => reject?.());
      session.on('x11', (_ok, reject) => reject?.());
      session.on('auth-agent', (_ok, reject) => reject?.());
    }));
  });
  server.maxConnections = 16;
  return server;
}

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240, IP = 244;
const ECHO = 1, SGA = 3, NAWS = 31;

function createTelnetServer(service, { login, shell, cwd }) {
  const server = net.createServer(socket => {
    service.sockets.add(socket);
    socket.on('close', () => service.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const peer = plainAddress(socket.remoteAddress);
    let phase = 'user', line = '', user = '', terminal = null, attempts = 0, size = { cols: 80, rows: 24 };
    let mode = 'data', option = 0, sub = [], afterCR = false;
    const early = [];
    const decoder = new StringDecoder('utf8');
    socket.setTimeout(120000, () => { if (!terminal) socket.destroy(); });
    socket.write(Buffer.from([IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, NAWS]));
    socket.write('\r\nTermora Telnet server\r\n\r\nlogin: ');

    const loginInput = byte => {
      if (phase === 'checking') { if (early.length < 4096) early.push(byte); return; }
      if (byte === 13 || byte === 10) {
        socket.write('\r\n');
        if (phase === 'user') { user = line; line = ''; phase = 'password'; socket.write('Password: '); return; }
        const password = line; line = ''; phase = 'checking';
        const ok = login.check(user, password, peer);
        setTimeout(() => {
          if (socket.destroyed) return;
          if (!ok) {
            early.length = 0;
            socket.write(login.blocked(peer) ? 'Too many failed logins; try again later.\r\n' : 'Login incorrect\r\n');
            if (++attempts >= 3 || login.blocked(peer)) { socket.end(); return; }
            phase = 'user'; socket.write('\r\nlogin: '); return;
          }
          socket.setTimeout(0);
          try { terminal = spawnShell(shell, { ...size, cwd }); }
          catch (error) { socket.end(`Cannot start shell: ${error.message}\r\n`); return; }
          terminal.onData(data => socket.write(data));
          terminal.onExit(() => socket.end());
          // Type-ahead sent while the password was being checked.
          if (early.length) deliver(early.splice(0));
        }, ok ? 0 : 800);
        return;
      }
      if (byte === 127 || byte === 8) { if (line) { line = line.slice(0, -1); if (phase === 'user') socket.write('\b \b'); } return; }
      if (byte === 3 || byte === 4) { socket.end(); return; }
      if (byte < 32 || line.length >= 256) return;
      line += String.fromCharCode(byte);
      if (phase === 'user') socket.write(String.fromCharCode(byte));
    };
    const deliver = bytes => {
      if (!bytes.length) return;
      if (terminal) { const text = decoder.write(Buffer.from(bytes)); if (text) terminal.write(text); }
      else for (const byte of bytes) loginInput(byte);
    };
    socket.on('data', chunk => {
      const out = [];
      for (const byte of chunk) {
        if (mode === 'data') {
          if (byte === IAC) { mode = 'iac'; continue; }
          // Telnet sends Enter as CR LF or CR NUL; the shell wants a single CR.
          if (afterCR && (byte === 10 || byte === 0)) { afterCR = false; continue; }
          afterCR = byte === 13;
          out.push(byte);
        } else if (mode === 'iac') {
          if (byte === IAC) { out.push(IAC); mode = 'data'; }
          else if (byte >= WILL && byte <= DONT) { option = byte; mode = 'option'; }
          else if (byte === SB) { sub = []; mode = 'sub'; }
          else { if (byte === IP) out.push(3); mode = 'data'; }
        } else if (mode === 'option') {
          // Refuse anything we did not offer, so negotiation always settles.
          if (option === DO && ![ECHO, SGA].includes(byte)) socket.write(Buffer.from([IAC, WONT, byte]));
          if (option === WILL && byte !== NAWS) socket.write(Buffer.from([IAC, DONT, byte]));
          mode = 'data';
        } else if (mode === 'sub') {
          if (byte === IAC) mode = 'subiac'; else if (sub.length < 64) sub.push(byte);
        } else if (mode === 'subiac') {
          if (byte === SE) {
            if (sub[0] === NAWS && sub.length >= 5) {
              size = { cols: Math.max(10, (sub[1] << 8) | sub[2]), rows: Math.max(2, (sub[3] << 8) | sub[4]) };
              try { terminal?.resize(size.cols, size.rows); } catch {}
            }
            mode = 'data';
          } else { if (sub.length < 64) sub.push(byte); mode = 'sub'; }
        }
      }
      deliver(out);
    });
    socket.on('close', () => { try { terminal?.kill(); } catch {} });
  });
  server.maxConnections = 8;
  return server;
}

module.exports = { createSshServer, createTelnetServer, attachSftp };
