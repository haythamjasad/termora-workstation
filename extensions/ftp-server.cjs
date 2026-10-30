'use strict';

// Minimal passive-mode FTP server with explicit (AUTH TLS) or implicit FTPS.
// Every path is confined to the chosen root; writes need the writable option.
const fs = require('node:fs');
const fsp = fs.promises;
const net = require('node:net');
const tls = require('node:tls');
const { pipeline } = require('node:stream/promises');
const { safePath, safeTarget, virtual } = require('./jail.cjs');
const { plainAddress } = require('./common.cjs');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = value => String(value).padStart(2, '0');
const stamp = date => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
const OPEN_COMMANDS = new Set(['USER', 'PASS', 'AUTH', 'PBSZ', 'PROT', 'FEAT', 'SYST', 'QUIT', 'NOOP', 'OPTS']);
const WRITE_COMMANDS = new Set(['STOR', 'APPE', 'DELE', 'MKD', 'XMKD', 'RMD', 'XRMD', 'RNFR', 'RNTO']);

function listLine(name, stat) {
  const date = new Date(stat.mtimeMs);
  const time = Date.now() - date.getTime() < 180 * 86400000 ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : ` ${date.getFullYear()}`;
  return `${stat.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--'} 1 owner group ${String(stat.size).padStart(12)} ${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2)} ${time} ${name}`;
}
function factLine(name, stat) { return `type=${stat.isDirectory() ? 'dir' : 'file'};size=${stat.size};modify=${stamp(new Date(stat.mtimeMs))}; ${name}`; }

function failure(error) {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [550, 'No such file or directory'];
  if (error.code === 'ENOTEMPTY') return [550, 'Directory not empty'];
  if (error.code === 'EEXIST') return [553, 'Destination already exists'];
  return [550, error.code === 'EACCES' || error.code === 'EPERM' ? 'Permission denied' : 'Operation failed'];
}

function createFtpServer(service, { root, host, writable, login, tlsMode = 'none', credentials }) {
  const context = tlsMode !== 'none' ? tls.createSecureContext({ ...credentials, minVersion: 'TLSv1.2' }) : null;
  const track = socket => { service.sockets.add(socket); socket.on('close', () => service.sockets.delete(socket)); socket.on('error', () => socket.destroy()); };

  function control(raw) {
    track(raw);
    let socket = raw, buffer = '', cwd = '/', user = null, authenticated = false, failures = 0;
    let secure = tlsMode === 'implicit', protection = secure ? 'P' : 'C', renameFrom = null, passive = null, queue = Promise.resolve();
    const peer = plainAddress(raw.remoteAddress);
    const reply = (code, text) => { if (!socket.destroyed) socket.write(`${code} ${text}\r\n`); };
    socket.setTimeout(300000, () => socket.destroy());
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 8192) { socket.destroy(); return; }
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        queue = queue.then(() => command(line)).catch(() => reply(451, 'Local error'));
      }
    };
    socket.on('data', onData);
    raw.on('close', () => closePassive());
    reply(220, 'Termora FTP server ready');

    function closePassive() { if (passive) { passive.listener.close(); passive.ready.then(data => data.destroy(), () => {}); passive = null; } }
    async function openPassive(extended) {
      closePassive();
      const address = plainAddress(socket.localAddress);
      if (!extended && !net.isIPv4(address)) { reply(522, 'Use EPSV'); return; }
      const listener = protection === 'P' ? tls.createServer({ ...credentials, minVersion: 'TLSv1.2' }) : net.createServer();
      listener.maxConnections = 1;
      let timer;
      const ready = new Promise((resolve, reject) => {
        listener.on(protection === 'P' ? 'secureConnection' : 'connection', data => {
          // Only the client on this control connection may use the data port.
          if (plainAddress(data.remoteAddress) !== peer) { data.destroy(); return; }
          track(data); clearTimeout(timer); listener.close(); resolve(data);
        });
        listener.on('tlsClientError', () => {});
        timer = setTimeout(() => { listener.close(); reject(new Error('timeout')); }, 15000);
      });
      ready.catch(() => {});
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, host, resolve); });
      passive = { listener, ready };
      const port = listener.address().port;
      if (extended) reply(229, `Entering Extended Passive Mode (|||${port}|)`);
      else reply(227, `Entering Passive Mode (${address.replace(/\./g, ',')},${port >> 8},${port & 255})`);
    }
    async function withData(transfer) {
      if (!passive) { reply(425, 'Use PASV or EPSV first'); return; }
      const { ready } = passive; passive = null;
      let data;
      try { data = await ready; } catch { reply(425, 'Data connection was not opened'); return; }
      reply(150, 'Opening data connection');
      try { await transfer(data); reply(226, 'Transfer complete'); }
      catch (error) { data.destroy(); const [, text] = failure(error); reply(451, `Transfer failed: ${text}`); }
    }
    async function sendText(data, lines) { await pipeline(async function* () { for (const line of lines) yield `${line}\r\n`; }, data); }
    async function directoryLines(argument, format) {
      const target = await safePath(root, virtual(cwd, argument));
      const stat = await fsp.stat(target);
      if (!stat.isDirectory()) return [format(argument.split('/').pop(), stat)];
      const lines = [];
      for (const entry of (await fsp.readdir(target)).slice(0, 10000)) {
        try { lines.push(format(entry, await fsp.stat(`${target}/${entry}`))); } catch {}
      }
      return lines;
    }

    async function command(line) {
      if (socket.destroyed) return;
      const space = line.indexOf(' ');
      const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase(), argument = space < 0 ? '' : line.slice(space + 1);
      if (!authenticated && !OPEN_COMMANDS.has(verb)) { reply(530, 'Please log in with USER and PASS'); return; }
      if (WRITE_COMMANDS.has(verb) && !writable) { reply(550, 'This server is read-only'); return; }
      if (verb !== 'RNTO' && verb !== 'RNFR') renameFrom = null;
      try {
        switch (verb) {
          case 'AUTH':
            if (tlsMode !== 'explicit' || secure) { reply(502, 'AUTH is not available'); return; }
            if (!/^(TLS|SSL|TLS-C)$/i.test(argument)) { reply(504, 'Use AUTH TLS'); return; }
            // Swap the line reader onto the TLS socket before the handshake starts.
            socket.removeListener('data', onData);
            reply(234, 'Begin TLS negotiation');
            socket = new tls.TLSSocket(raw, { isServer: true, secureContext: context });
            socket.on('error', () => raw.destroy());
            socket.on('data', onData);
            secure = true; buffer = '';
            return;
          case 'PBSZ': reply(200, 'PBSZ=0'); return;
          case 'PROT':
            if (/^P$/i.test(argument) && secure) { protection = 'P'; reply(200, 'Protection level set to Private'); }
            else if (/^C$/i.test(argument) && tlsMode === 'none') { protection = 'C'; reply(200, 'Protection level set to Clear'); }
            else reply(536, secure || tlsMode !== 'none' ? 'Only PROT P is accepted on this server' : 'Use AUTH TLS first');
            return;
          case 'USER':
            if (tlsMode !== 'none' && !secure) { reply(530, 'This server requires TLS. Use AUTH TLS first.'); return; }
            user = argument; authenticated = false; reply(331, 'Password required'); return;
          case 'PASS':
            if (user === null) { reply(503, 'Send USER first'); return; }
            if (login.check(user, argument, peer)) { authenticated = true; reply(230, 'Logged in'); return; }
            user = null;
            await new Promise(resolve => setTimeout(resolve, 500));
            reply(530, login.blocked(peer) ? 'Too many failed logins; try again later' : 'Login incorrect');
            if (++failures >= 3) socket.end();
            return;
          case 'SYST': reply(215, 'UNIX Type: L8'); return;
          case 'FEAT':
            socket.write(`211-Features:\r\n UTF8\r\n EPSV\r\n PASV\r\n SIZE\r\n MDTM\r\n MLST type*;size*;modify*;\r\n${tlsMode === 'explicit' ? ' AUTH TLS\r\n' : ''}${tlsMode !== 'none' ? ' PBSZ\r\n PROT\r\n' : ''}211 End\r\n`);
            return;
          case 'OPTS': reply(/^UTF8( ON)?$/i.test(argument) ? 200 : 501, /^UTF8/i.test(argument) ? 'UTF8 mode enabled' : 'Option not supported'); return;
          case 'NOOP': reply(200, 'OK'); return;
          case 'QUIT': reply(221, 'Goodbye'); socket.end(); return;
          case 'TYPE': reply(/^[AI]( N)?$/i.test(argument) ? 200 : 504, /^[AI]/i.test(argument) ? `Type set to ${argument.toUpperCase()}` : 'Type not supported'); return;
          case 'STRU': reply(/^F$/i.test(argument) ? 200 : 504, 'Structure'); return;
          case 'MODE': reply(/^S$/i.test(argument) ? 200 : 504, 'Mode'); return;
          case 'ALLO': reply(202, 'No storage allocation necessary'); return;
          case 'PORT': case 'EPRT': reply(502, 'Active mode is disabled; use passive mode'); return;
          case 'PASV': await openPassive(false); return;
          case 'EPSV': if (/^ALL$/i.test(argument)) reply(200, 'EPSV ALL accepted'); else await openPassive(true); return;
          case 'PWD': case 'XPWD': reply(257, `"${cwd.replace(/"/g, '""')}" is the current directory`); return;
          case 'CWD': case 'XCWD': case 'CDUP': case 'XCUP': {
            const next = virtual(cwd, verb.endsWith('UP') ? '..' : argument);
            if (!(await fsp.stat(await safePath(root, next))).isDirectory()) { reply(550, 'Not a directory'); return; }
            cwd = next; reply(250, `Directory changed to ${cwd}`); return;
          }
          case 'SIZE': { const stat = await fsp.stat(await safePath(root, virtual(cwd, argument))); if (!stat.isFile()) { reply(550, 'Not a regular file'); return; } reply(213, String(stat.size)); return; }
          case 'MDTM': { const stat = await fsp.stat(await safePath(root, virtual(cwd, argument))); reply(213, stamp(new Date(stat.mtimeMs))); return; }
          case 'MLST': { const target = virtual(cwd, argument); const stat = await fsp.stat(await safePath(root, target)); socket.write(`250-Listing\r\n ${factLine(target, stat)}\r\n250 End\r\n`); return; }
          case 'LIST': case 'NLST': case 'MLSD': {
            // Clients often pass ls flags such as "-a"; they carry no path.
            const target = argument.split(' ').filter(part => !part.startsWith('-')).join(' ');
            const lines = await directoryLines(target, verb === 'MLSD' ? factLine : verb === 'NLST' ? name => name : listLine);
            await withData(data => sendText(data, lines)); return;
          }
          case 'RETR': {
            const target = await safePath(root, virtual(cwd, argument));
            if (!(await fsp.stat(target)).isFile()) { reply(550, 'Not a regular file'); return; }
            await withData(data => pipeline(fs.createReadStream(target), data)); return;
          }
          case 'STOR': case 'APPE': {
            const target = await safeTarget(root, virtual(cwd, argument));
            try { if ((await fsp.stat(target)).isDirectory()) { reply(550, 'A directory has that name'); return; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
            await withData(data => pipeline(data, fs.createWriteStream(target, { flags: verb === 'APPE' ? 'a' : 'w' }))); return;
          }
          case 'DELE': { const target = await safePath(root, virtual(cwd, argument)); if (!(await fsp.lstat(target)).isFile()) { reply(550, 'Not a regular file'); return; } await fsp.unlink(target); reply(250, 'File deleted'); return; }
          case 'MKD': case 'XMKD': { const next = virtual(cwd, argument); await fsp.mkdir(await safeTarget(root, next)); reply(257, `"${next.replace(/"/g, '""')}" created`); return; }
          case 'RMD': case 'XRMD': { const next = virtual(cwd, argument); if (next === '/') { reply(550, 'The root cannot be removed'); return; } await fsp.rmdir(await safePath(root, next)); reply(250, 'Directory removed'); return; }
          case 'RNFR': { const next = virtual(cwd, argument); if (next === '/') { reply(550, 'The root cannot be renamed'); return; } await safePath(root, next); renameFrom = next; reply(350, 'Ready for destination name'); return; }
          case 'RNTO': {
            const from = renameFrom; renameFrom = null;
            if (!from) { reply(503, 'Send RNFR first'); return; }
            const source = await safePath(root, from), target = await safeTarget(root, virtual(cwd, argument));
            try { await fsp.lstat(target); reply(553, 'Destination already exists'); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
            await fsp.rename(source, target); reply(250, 'Renamed'); return;
          }
          case 'ABOR': closePassive(); reply(226, 'No transfer to abort'); return;
          default: reply(502, 'Command not implemented');
        }
      } catch (error) { const [code, text] = failure(error); reply(code, text); }
    }
  }

  const server = tlsMode === 'implicit'
    ? tls.createServer({ ...credentials, minVersion: 'TLSv1.2' }, control)
    : net.createServer(control);
  if (tlsMode === 'implicit') { server.on('connection', socket => track(socket)); server.on('tlsClientError', () => {}); }
  server.maxConnections = 16;
  return server;
}

module.exports = { createFtpServer, listLine };
