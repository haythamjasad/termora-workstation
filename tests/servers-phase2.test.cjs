'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const { ServerManager } = require('../extensions/servers.cjs');
const { TerminalManager } = require('../lib/terminals.cjs');
const { FileManager } = require('../lib/files.cjs');
const { STATE, COOKIE_SIZE } = require('../extensions/iperf.cjs');
const { parseSchedule, matches, nextRun, runCommand, CronScheduler } = require('../extensions/cron.cjs');

const login = { username: 'tester', password: 'correct horse' };

async function fixture(t) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'termora-phase2-'));
  const root = path.join(temporary, 'root'), outside = path.join(temporary, 'outside'), data = path.join(temporary, 'data');
  await fsp.mkdir(root); await fsp.mkdir(outside);
  await fsp.writeFile(path.join(root, 'hello.txt'), 'hello world');
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'outside-secret');
  const manager = new ServerManager({ dataDir: data });
  t.after(async () => { await manager.closeAll(); await fsp.rm(temporary, { recursive: true, force: true }); });
  return { temporary, root, outside, data, manager };
}
function until(check, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => { const value = check(); if (value) resolve(value); else if (Date.now() - started > timeout) reject(new Error('Timed out waiting for condition.')); else setTimeout(tick, 25); };
    tick();
  });
}
async function ftpClient(port, options = {}) {
  const { Client } = require('basic-ftp');
  const client = new Client(10000);
  await client.access({ host: '127.0.0.1', port, user: login.username, password: login.password, ...options });
  return client;
}
async function download(client, remote) {
  const chunks = [];
  await client.downloadTo(new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } }), remote);
  return Buffer.concat(chunks).toString();
}
// Line-oriented raw FTP control connection for protocol-level checks.
async function rawFtp(port) {
  const socket = net.connect(port, '127.0.0.1'); let buffer = '';
  socket.on('data', data => { buffer += data.toString(); });
  const next = async () => { const line = await until(() => { const index = buffer.indexOf('\r\n'); if (index < 0) return null; const value = buffer.slice(0, index); buffer = buffer.slice(index + 2); return value; }); return line; };
  await next();
  return { send: async line => { socket.write(line + '\r\n'); return next(); }, close: () => socket.destroy() };
}

test('FTP server: login, listing, transfers, rename, mkdir, delete and root confinement', async t => {
  const { root, manager } = await fixture(t);
  const server = await manager.start({ type: 'ftp', root, port: 0, writable: true, ...login });
  assert.equal(server.host, '127.0.0.1'); assert.equal(server.username, 'tester'); assert.equal(server.password, undefined);
  const client = await ftpClient(server.port); t.after(() => client.close());
  assert.deepEqual((await client.list()).map(entry => entry.name), ['hello.txt']);
  assert.equal(await download(client, 'hello.txt'), 'hello world');
  await client.uploadFrom(Readable.from(['uploaded data']), 'new.txt');
  assert.equal(await fsp.readFile(path.join(root, 'new.txt'), 'utf8'), 'uploaded data');
  await client.ensureDir('/sub/inner'); await client.cd('/');
  assert.ok(fs.statSync(path.join(root, 'sub', 'inner')).isDirectory());
  await client.rename('new.txt', 'sub/renamed.txt');
  assert.equal(await fsp.readFile(path.join(root, 'sub', 'renamed.txt'), 'utf8'), 'uploaded data');
  await client.remove('sub/renamed.txt'); assert.equal(fs.existsSync(path.join(root, 'sub', 'renamed.txt')), false);
  await client.cd('..'); assert.equal(await client.pwd(), '/');
  await assert.rejects(download(client, '../outside/secret.txt'), /550/);
  await assert.rejects(download(client, '/C:/Windows/win.ini'), /550/);
  await assert.rejects(client.uploadFrom(Readable.from(['x']), 'CON'), /550/);
  const raw = await rawFtp(server.port); t.after(() => raw.close());
  assert.match(await raw.send('LIST'), /^530/);
  assert.match(await raw.send('USER tester'), /^331/);
  assert.match(await raw.send('PASS wrong-password'), /^530/);
});

test('FTP server read-only mode refuses changes', async t => {
  const { root, manager } = await fixture(t);
  const server = await manager.start({ type: 'ftp', root, port: 0, ...login });
  const client = await ftpClient(server.port); t.after(() => client.close());
  assert.equal(await download(client, 'hello.txt'), 'hello world');
  await assert.rejects(client.uploadFrom(Readable.from(['x']), 'blocked.txt'), /550/);
  await assert.rejects(client.remove('hello.txt'), /550/);
  assert.equal(fs.existsSync(path.join(root, 'blocked.txt')), false);
});

test('FTPS explicit and implicit modes verify against the saved certificate', async t => {
  const { root, data, manager } = await fixture(t);
  const explicit = await manager.start({ type: 'ftp', root, port: 0, tls: 'explicit', writable: true, ...login });
  const ca = await fsp.readFile(path.join(data, 'ftps-cert.pem'), 'utf8');
  assert.match(explicit.certificate, /^SHA256:/);
  const raw = await rawFtp(explicit.port); t.after(() => raw.close());
  assert.match(await raw.send('USER tester'), /^530 .*TLS/);
  const secure = await ftpClient(explicit.port, { secure: true, secureOptions: { ca } }); t.after(() => secure.close());
  assert.equal(await download(secure, 'hello.txt'), 'hello world');
  await secure.uploadFrom(Readable.from(['over tls']), 'tls.txt');
  assert.equal(await fsp.readFile(path.join(root, 'tls.txt'), 'utf8'), 'over tls');
  // A client that does not trust the certificate must refuse to continue.
  await assert.rejects(ftpClient(explicit.port, { secure: true }), /self-signed|certificate/i);
  const implicit = await manager.start({ type: 'ftp', root, port: 0, tls: 'implicit', ...login });
  assert.equal(implicit.certificate, explicit.certificate);
  const client = await ftpClient(implicit.port, { secure: 'implicit', secureOptions: { ca } }); t.after(() => client.close());
  assert.deepEqual((await client.list()).map(entry => entry.name).sort(), ['hello.txt', 'tls.txt']);
  assert.equal(await download(client, 'tls.txt'), 'over tls');
});

test('SSH server: Termora client shell, exec, SFTP browser and a stable host key', async t => {
  const { root, data, manager } = await fixture(t);
  const server = await manager.start({ type: 'ssh', root, port: 0, writable: true, shell: 'cmd', ...login });
  assert.match(server.fingerprint, /^SHA256:/);
  const fingerprints = [], events = [];
  const terminals = new TerminalManager({ emit: (channel, payload) => events.push({ channel, payload }), store: null, verifyHost: ({ fingerprint }) => { fingerprints.push(fingerprint); return fingerprint === server.fingerprint; } });
  t.after(() => terminals.closeAll());
  const files = new FileManager(terminals);
  const session = await terminals.open({ type: 'ssh', host: '127.0.0.1', port: server.port, ...login, cols: 100, rows: 30 });
  assert.deepEqual(fingerprints, [server.fingerprint]);
  const output = () => events.filter(event => event.channel === 'terminal:data' && event.payload.id === session.id).map(event => event.payload.data).join('');
  terminals.write({ id: session.id, data: 'echo termora-ssh-%COMPUTERNAME:~0,0%ok\r' });
  await until(() => output().includes('termora-ssh-ok'), 20000);
  const listing = await files.list({ id: session.id });
  assert.equal(listing.path, '/'); assert.deepEqual(listing.entries.map(entry => entry.name), ['hello.txt']);
  assert.equal((await files.read({ id: session.id, path: '/hello.txt' })).content, 'hello world');
  await files.write({ id: session.id, path: '/written.txt', content: 'from sftp' });
  assert.equal(await fsp.readFile(path.join(root, 'written.txt'), 'utf8'), 'from sftp');
  await files.action({ id: session.id, action: 'mkdir', path: '/folder' });
  await files.action({ id: session.id, action: 'rename', path: '/written.txt', newPath: '/folder/moved.txt' });
  assert.ok(fs.existsSync(path.join(root, 'folder', 'moved.txt')));
  await assert.rejects(files.read({ id: session.id, path: '/../outside/secret.txt' }));
  await assert.rejects(files.list({ id: session.id, path: '/..' }).then(result => { if (result.entries.some(entry => entry.name === 'outside')) throw new Error('escaped'); throw new Error('stayed'); }), /stayed/);
  terminals.close(session.id);

  const { Client } = require('ssh2');
  const exec = () => new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => client.exec('echo exec-works', (error, stream) => {
      if (error) { reject(error); return; }
      let text = ''; stream.on('data', chunk => { text += chunk; });
      stream.on('close', code => { client.end(); resolve({ text, code }); });
    })).on('error', reject).connect({ host: '127.0.0.1', port: server.port, ...login, hostVerifier: () => true });
  });
  const result = await exec();
  assert.match(result.text, /exec-works/); assert.equal(result.code, 0);
  await assert.rejects(new Promise((resolve, reject) => { const client = new Client(); client.on('ready', () => { client.end(); resolve(); }).on('error', reject).connect({ host: '127.0.0.1', port: server.port, username: 'tester', password: 'wrong-password', hostVerifier: () => true }); }), /authentication/i);

  await manager.stop(server.id);
  const again = await manager.start({ type: 'ssh', port: 0, ...login });
  assert.equal(again.fingerprint, server.fingerprint);
  assert.ok(fs.existsSync(path.join(data, 'ssh-host-key')));
});

test('SSH server read-only SFTP refuses uploads', async t => {
  const { root, manager } = await fixture(t);
  const server = await manager.start({ type: 'ssh', root, port: 0, shell: 'cmd', ...login });
  const terminals = new TerminalManager({ emit: () => {}, store: null, verifyHost: () => true });
  t.after(() => terminals.closeAll());
  const files = new FileManager(terminals);
  const session = await terminals.openFiles({ type: 'sftp', host: '127.0.0.1', port: server.port, ...login });
  assert.equal((await files.read({ id: session.id, path: '/hello.txt' })).content, 'hello world');
  await assert.rejects(files.write({ id: session.id, path: '/blocked.txt', content: 'x' }), /denied|read-only/i);
  assert.equal(fs.existsSync(path.join(root, 'blocked.txt')), false);
});

test('Telnet server: negotiation, login and an interactive shell', async t => {
  const { root, manager } = await fixture(t);
  const server = await manager.start({ type: 'telnet', root, port: 0, shell: 'cmd', ...login });
  const run = async password => {
    const socket = net.connect(server.port, '127.0.0.1'); let text = ''; const negotiation = [];
    t.after(() => socket.destroy());
    socket.on('data', data => { for (let i = 0; i < data.length; i++) { if (data[i] === 255) { negotiation.push([...data.subarray(i, i + 3)]); i += 2; } else text += String.fromCharCode(data[i]); } });
    await until(() => text.includes('login: '));
    // Report a window size, as real clients do after DO NAWS.
    socket.write(Buffer.from([255, 251, 31, 255, 250, 31, 0, 120, 0, 40, 255, 240]));
    socket.write('tester\r\n'); await until(() => text.includes('Password: '));
    socket.write(`${password}\r\n`);
    return { socket, negotiation, text: () => text };
  };
  const bad = await run('wrong-password');
  await until(() => bad.text().includes('Login incorrect'));
  assert.ok(bad.negotiation.some(([, verb, option]) => verb === 251 && option === 1), 'server offers WILL ECHO');
  const good = await run(login.password);
  assert.ok(!good.text().includes('correct horse'), 'password is not echoed');
  good.socket.write('echo telnet-%COMPUTERNAME:~0,0%works\r\n');
  await until(() => good.text().includes('telnet-works'), 20000);
});

function iperfClient(port, { reverse = false, parallel = 2, seconds = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const cookie = crypto.randomBytes(18).toString('hex') + '\0';
    const control = net.connect(port, '127.0.0.1'); const streams = []; let received = 0, sent = 0, buffer = Buffer.alloc(0), phase = 'state';
    const fail = error => { control.destroy(); streams.forEach(stream => stream.destroy()); reject(error); };
    control.on('error', fail);
    const json = value => { const body = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(4); head.writeUInt32BE(body.length); return Buffer.concat([head, body]); };
    control.on('connect', () => control.write(cookie));
    control.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length) {
        if (phase === 'results') {
          if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) return;
          const size = buffer.readUInt32BE(0); const results = JSON.parse(buffer.subarray(4, 4 + size)); buffer = buffer.subarray(4 + size); phase = 'state';
          control.results = results; continue;
        }
        const value = buffer.readInt8(0); buffer = buffer.subarray(1);
        if (value === STATE.PARAM_EXCHANGE) control.write(json({ tcp: true, time: seconds, parallel, len: 16384, reverse, client_version: 'test' }));
        else if (value === STATE.CREATE_STREAMS) {
          for (let i = 0; i < parallel; i++) {
            const stream = net.connect(port, '127.0.0.1', () => stream.write(cookie)); streams.push(stream);
            stream.on('data', chunk => { received += chunk.length; }); stream.on('error', () => {});
          }
        } else if (value === STATE.TEST_RUNNING) {
          const block = Buffer.alloc(16384, 7); const deadline = Date.now() + seconds * 1000;
          if (!reverse) for (const stream of streams) { const pump = () => { while (Date.now() < deadline && !stream.destroyed) { sent += block.length; if (!stream.write(block)) { stream.once('drain', pump); return; } } }; pump(); setTimeout(pump, 50); }
          setTimeout(() => control.write(Buffer.from([STATE.TEST_END])), seconds * 1000);
        } else if (value === STATE.EXCHANGE_RESULTS) { control.write(json({ cpu_util_total: 0, cpu_util_user: 0, cpu_util_system: 0, sender_has_retransmits: -1, streams: streams.map((_, index) => ({ id: index ? index + 2 : 1, bytes: reverse ? received : sent, retransmits: -1, jitter: 0, errors: 0, packets: 0 })) })); phase = 'results'; }
        else if (value === STATE.DISPLAY_RESULTS) { control.write(Buffer.from([STATE.IPERF_DONE])); setTimeout(() => { streams.forEach(stream => stream.destroy()); control.destroy(); resolve({ results: control.results, received, sent }); }, 50); }
        else if (value === STATE.ACCESS_DENIED) { resolve({ denied: true }); control.destroy(); }
      }
    });
  });
}

test('iperf3 server: normal and reverse TCP tests report stream results', async t => {
  const { manager } = await fixture(t);
  const server = await manager.start({ type: 'iperf', port: 0 });
  const normal = await iperfClient(server.port, { parallel: 2 });
  assert.deepEqual(normal.results.streams.map(stream => stream.id), [1, 3]);
  const counted = normal.results.streams.reduce((sum, stream) => sum + stream.bytes, 0);
  assert.ok(counted > 0 && counted <= normal.sent, `server counted ${counted} of ${normal.sent}`);
  assert.equal(normal.results.sender_has_retransmits, -1);
  const reverse = await iperfClient(server.port, { reverse: true, parallel: 1 });
  assert.ok(reverse.received > 0); assert.ok(reverse.results.streams[0].bytes >= reverse.received);
  assert.ok(manager.list()[0].lastResult.bitsPerSecond > 0);
  // A second client during a test is told the server is busy.
  const first = iperfClient(server.port, { seconds: 1 });
  await new Promise(resolve => setTimeout(resolve, 200));
  const raw = net.connect(server.port, '127.0.0.1'); t.after(() => raw.destroy());
  raw.write(crypto.randomBytes(18).toString('hex') + '\0');
  const reply = await new Promise(resolve => raw.once('data', resolve));
  assert.equal(reply.readInt8(0), STATE.ACCESS_DENIED);
  await first;
  assert.equal(COOKIE_SIZE, 37);
});

test('cron schedules parse, match and find the next run', () => {
  assert.equal(matches('*/15 9-17 * * 1-5', new Date(2026, 9, 26, 9, 30)), true); // Monday
  assert.equal(matches('*/15 9-17 * * 1-5', new Date(2026, 9, 25, 9, 30)), false); // Sunday
  assert.equal(matches('0 0 1 * 0', new Date(2026, 10, 1, 0, 0)), true); // 1st, either day field
  assert.equal(matches('0 0 1 * 0', new Date(2026, 10, 8, 0, 0)), true); // a Sunday
  assert.equal(matches('0 0 1 * 0', new Date(2026, 10, 9, 0, 0)), false);
  assert.equal(matches('@hourly', new Date(2026, 0, 1, 5, 0)), true);
  assert.equal(matches('0 12 * * 7', new Date(2026, 9, 25, 12, 0)), true); // 7 is Sunday
  assert.deepEqual(nextRun('30 2 * * *', new Date(2026, 9, 25, 3, 0)), new Date(2026, 9, 26, 2, 30));
  assert.deepEqual(nextRun('0 0 29 2 *', new Date(2026, 0, 1)), new Date(2028, 1, 29, 0, 0));
  for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', '*/0 * * * *', 'a b c d e']) assert.throws(() => parseSchedule(bad), /field|five/);
});

test('cron jobs run through the shell and never overlap', async () => {
  const result = await runCommand('echo cron-ran', { shell: 'cmd' });
  assert.equal(result.exitCode, 0); assert.match(result.output, /cron-ran/);
  const results = [];
  const scheduler = new CronScheduler({ jobs: () => [], onResult: value => results.push(value), shell: 'cmd' });
  const job = { id: 'job-1', command: 'ping -n 2 127.0.0.1 > nul & echo slow-done', enabled: true };
  const [first, second] = await Promise.all([scheduler.run(job), scheduler.run(job)]);
  assert.match(first.output, /slow-done/); assert.equal(second.skipped, true);
  assert.equal(results.length, 1); assert.equal(scheduler.results.get('job-1').exitCode, 0);
});

test('server validation: credentials, listen scope and single cron service', async t => {
  const { root, manager } = await fixture(t);
  await assert.rejects(manager.start({ type: 'ssh', username: 'tester', password: 'short' }), /at least 8/);
  await assert.rejects(manager.start({ type: 'telnet', username: 'bad user', password: login.password }), /username/);
  await assert.rejects(manager.start({ type: 'ftp', ...login }), /directory/);
  const local = await manager.start({ type: 'http', root, listen: 'all' });
  assert.equal(local.host, '127.0.0.1');
  const all = await manager.start({ type: 'iperf', listen: 'all' });
  assert.equal(all.host, '0.0.0.0'); assert.equal(all.listen, 'all');
  const cron = await manager.start({ type: 'cron' });
  assert.equal(cron.port, 0);
  await assert.rejects(manager.start({ type: 'cron' }), /already running/);
  assert.equal(await manager.stop(cron.id), true);
});
