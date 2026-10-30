const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { TerminalManager, rloginWindow } = require('../lib/terminals.cjs');
const { CredentialVault } = require('../lib/vault.cjs');
const { sanitizeSessions } = require('../lib/state.cjs');

async function listen(server, port = 0) { server.listen(port, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
function hostKey() { return crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey; }
function until(check, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => { const value = check(); if (value) resolve(value); else if (Date.now() - started > timeout) reject(new Error('Timed out waiting for condition.')); else setTimeout(tick, 20); };
    tick();
  });
}

// SSH target: interactive shell that records input, optional X11 channel, and a
// minimal scp sink/source so SCP transfers are exercised over a real exec channel.
async function sshTarget(t, { x11Payload } = {}) {
  const { Server } = require('ssh2');
  const record = { input: '', x11Requested: false, files: new Map(), clients: new Set() };
  const server = new Server({ hostKeys: [hostKey()] }, client => {
    record.clients.add(client); client.on('error', () => {}); client.on('close', () => record.clients.delete(client));
    client.on('authentication', auth => auth.accept());
    client.on('session', accept => {
      const session = accept();
      session.on('pty', accept => accept?.());
      session.on('x11', accept => { record.x11Requested = true; accept?.(); });
      session.on('shell', accept => {
        const stream = accept();
        stream.write('target-shell-ready\r\n');
        stream.on('data', data => { record.input += data.toString(); });
        if (x11Payload) client.x11('127.0.0.1', 50000, (error, channel) => { if (!error) channel.end(x11Payload); });
      });
      session.on('exec', (accept, reject, info) => {
        const stream = accept();
        const sink = /^scp -t -- '(.+)'$/.exec(info.command), source = /^scp -f -- '(.+)'$/.exec(info.command);
        if (sink) {
          let buffer = Buffer.alloc(0), size = -1, name;
          stream.write(Buffer.from([0]));
          stream.on('data', data => {
            buffer = Buffer.concat([buffer, data]);
            if (size < 0) { const end = buffer.indexOf(10); if (end < 0) return; const header = /^C(\d{4}) (\d+) (.+)$/.exec(buffer.subarray(0, end).toString()); size = Number(header[2]); name = header[3]; buffer = buffer.subarray(end + 1); stream.write(Buffer.from([0])); }
            if (size >= 0 && buffer.length >= size + 1) { record.files.set(sink[1], { name, content: buffer.subarray(0, size) }); stream.write(Buffer.from([0])); stream.exit(0); stream.end(); }
          });
        } else if (source) {
          const file = record.files.get(source[1]);
          let step = 0;
          stream.on('data', () => {
            step++;
            if (!file) { stream.write(Buffer.concat([Buffer.from([1]), Buffer.from('scp: no such file\n')])); stream.exit(1); stream.end(); return; }
            if (step === 1) stream.write(`C0644 ${file.content.length} ${file.name}\n`);
            else if (step === 2) { stream.write(file.content); stream.write(Buffer.from([0])); }
            else { stream.exit(0); stream.end(); }
          });
        } else { stream.exit(127); stream.end(); }
      });
    });
  });
  const port = await listen(server);
  t.after(() => { for (const client of record.clients) client.end(); server.close(); });
  return { port, record };
}

// Jump host: forwards direct-tcpip requests and records each destination.
async function sshGateway(t) {
  const { Server } = require('ssh2');
  const record = { destinations: [], sockets: new Set(), clients: new Set() };
  const server = new Server({ hostKeys: [hostKey()] }, client => {
    record.clients.add(client); client.on('error', () => {}); client.on('close', () => record.clients.delete(client));
    client.on('authentication', auth => auth.accept());
    client.on('tcpip', (accept, reject, info) => {
      record.destinations.push(`${info.destIP}:${info.destPort}`);
      const socket = net.createConnection({ host: info.destIP, port: info.destPort }); record.sockets.add(socket);
      socket.once('error', () => reject()); socket.on('close', () => record.sockets.delete(socket));
      socket.once('connect', () => { const channel = accept(); socket.pipe(channel).pipe(socket); channel.on('close', () => socket.destroy()); });
    });
  });
  const port = await listen(server);
  t.after(() => { for (const socket of record.sockets) socket.destroy(); for (const client of record.clients) client.end(); server.close(); });
  return { port, record };
}

function manager(t, output) {
  const value = new TerminalManager({ emit: (channel, data) => { if (channel === 'terminal:data') output.push(data.data); }, verifyHost: async () => true });
  t.after(() => value.closeAll());
  return value;
}

test('SSH gateway reaches the target through the jump host, with startup command and compression', { timeout: 20000 }, async t => {
  const target = await sshTarget(t), gateway = await sshGateway(t), output = [];
  const terminals = manager(t, output);
  const session = await terminals.open({ type: 'ssh', host: '127.0.0.1', port: target.port, username: 'test', password: 'test', gatewayHost: '127.0.0.1', gatewayPort: gateway.port, gatewayUsername: 'jump', gatewayPassword: 'jump', startupCommand: 'echo started', compression: true });
  await until(() => output.join('').includes('target-shell-ready'));
  assert.deepEqual(gateway.record.destinations, [`127.0.0.1:${target.port}`]);
  assert.match(output.join(''), /Connected through SSH gateway 127\.0\.0\.1/);
  await until(() => target.record.input.includes('echo started\n'));
  terminals.close(session.id);
});

test('SSH gateway failures name the gateway and do not fall back to a direct connection', { timeout: 20000 }, async t => {
  const gateway = await sshGateway(t);
  const closed = net.createServer(); const deadPort = await listen(closed); await new Promise(resolve => closed.close(resolve));
  const terminals = manager(t, []);
  await assert.rejects(terminals.open({ type: 'ssh', host: '127.0.0.1', port: deadPort, password: 'x', gatewayHost: '127.0.0.1', gatewayPort: gateway.port, gatewayPassword: 'x' }), /SSH gateway 127\.0\.0\.1 could not reach/);
});

test('SSH X11 forwarding relays a remote X client to the local display port', { timeout: 20000 }, async t => {
  let display, xServer, received = Buffer.alloc(0);
  for (let candidate = 63; candidate > 10 && !xServer; candidate--) {
    const server = net.createServer(socket => socket.on('data', data => { received = Buffer.concat([received, data]); }));
    try { await listen(server, 6000 + candidate); xServer = server; display = candidate; } catch { server.close(); }
  }
  assert.ok(xServer, 'no free X display port available');
  t.after(() => xServer.close());
  const target = await sshTarget(t, { x11Payload: 'x11-forwarding-proof' }), output = [];
  const terminals = manager(t, output);
  await terminals.open({ type: 'ssh', host: '127.0.0.1', port: target.port, password: 'x', x11: true, x11Display: display });
  await until(() => received.toString().includes('x11-forwarding-proof'));
  assert.equal(target.record.x11Requested, true);
});

test('SCP uploads and downloads a file over an exec channel, separate from SFTP', { timeout: 20000 }, async t => {
  const target = await sshTarget(t), output = [];
  const terminals = manager(t, output);
  const session = await terminals.open({ type: 'ssh', host: '127.0.0.1', port: target.port, password: 'x', browserProtocol: 'scp' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termora-scp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = crypto.randomBytes(200000);
  fs.writeFileSync(path.join(dir, 'upload.bin'), payload);
  const { FileManager } = require('../lib/files.cjs');
  const files = new FileManager(terminals);
  const up = await files.upload(session.id, path.join(dir, 'upload.bin'), '/srv/it\'s here.bin', { overwrite: true });
  assert.equal(up.bytes, payload.length);
  assert.deepEqual(target.record.files.get('/srv/it\'\\\'\'s here.bin').content, payload);
  await files.download(session.id, '/srv/it\'s here.bin', path.join(dir, 'download.bin'));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'download.bin')), payload);
  await assert.rejects(files.download(session.id, '/missing', path.join(dir, 'missing.bin')), /no such file/);
  assert.equal(fs.existsSync(path.join(dir, 'missing.bin')), false);
});

test('rlogin performs the RFC 1282 handshake, sends window size and relays data', { timeout: 15000 }, async t => {
  let handshake = Buffer.alloc(0), connected;
  const server = net.createServer(socket => {
    connected = socket; let ready = false;
    socket.on('data', data => {
      handshake = Buffer.concat([handshake, data]);
      if (!ready && handshake.filter(byte => byte === 0).length >= 4) { ready = true; socket.write(Buffer.concat([Buffer.from([0]), Buffer.from('rlogin-ready\r\n')])); }
    });
  });
  const port = await listen(server);
  t.after(() => { connected?.destroy(); server.close(); });
  const output = [], terminals = manager(t, output);
  const session = await terminals.open({ type: 'rlogin', host: '127.0.0.1', port, username: 'remoteuser', rows: 33, cols: 120 });
  await until(() => output.join('').includes('rlogin-ready'));
  const fields = handshake.subarray(1).toString('latin1').split('\0');
  assert.equal(handshake[0], 0); assert.equal(fields[1], 'remoteuser'); assert.equal(fields[2], 'xterm-256color/38400');
  await until(() => handshake.includes(rloginWindow(33, 120)));
  terminals.write({ id: session.id, data: 'ls\r' });
  await until(() => handshake.toString('latin1').endsWith('ls\r'));
});

test('rsh executes the command, streams output to the log file and exits', { timeout: 15000 }, async t => {
  let request = Buffer.alloc(0);
  const server = net.createServer(socket => socket.on('data', data => {
    request = Buffer.concat([request, data]);
    if (request.filter(byte => byte === 0).length >= 4) socket.end(Buffer.concat([Buffer.from([0]), Buffer.from('rsh-command-output\n')]));
  }));
  const port = await listen(server);
  t.after(() => server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termora-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = [], exits = [];
  const terminals = new TerminalManager({ emit: (channel, data) => { if (channel === 'terminal:data') output.push(data.data); if (channel === 'terminal:exit') exits.push(data); }, verifyHost: async () => true });
  t.after(() => terminals.closeAll());
  terminals.setLogging({ enabled: true, directory: dir });
  await terminals.open({ type: 'rsh', host: '127.0.0.1', port, username: 'remoteuser', startupCommand: 'uname -a', name: 'rsh test' });
  await until(() => exits.length);
  const fields = request.toString('latin1').split('\0');
  assert.equal(fields[0], '0'); assert.equal(fields[2], 'remoteuser'); assert.equal(fields[3], 'uname -a');
  assert.match(output.join(''), /rsh-command-output/);
  const [log] = await until(() => { const found = fs.readdirSync(dir); return found.length && fs.readFileSync(path.join(dir, found[0]), 'utf8').includes('rsh-command-output') ? found : null; });
  assert.match(log, /rsh_test\.log$/);
});

test('rsh refusal reports the server message', { timeout: 15000 }, async t => {
  const server = net.createServer(socket => socket.once('data', () => socket.end(Buffer.concat([Buffer.from([1]), Buffer.from('Permission denied.\n')]))));
  const port = await listen(server);
  t.after(() => server.close());
  await assert.rejects(manager(t, []).open({ type: 'rsh', host: '127.0.0.1', port, startupCommand: 'id' }), /Rsh refused: Permission denied/);
});

test('credential vault encrypts at rest and releases secrets only to the saved destination', () => {
  let state = { sessions: [{ id: 's1', host: 'server.example', gatewayHost: '' }] };
  const store = { read: () => state, update: (key, value) => { state = { ...state, [key]: value }; return value; } };
  const cipher = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(byte => byte ^ 0x5a), decryptString: buffer => Buffer.from(buffer).map(byte => byte ^ 0x5a).toString() };
  const vault = new CredentialVault(store, cipher);
  vault.save('s1', { password: 'hunter2', passphrase: '', other: 'ignored' });
  assert.deepEqual(Object.keys(state.vault.s1), ['password']);
  assert.ok(!JSON.stringify(state).includes('hunter2'));
  assert.equal(vault.apply({ id: 's1', host: 'server.example' }).password, 'hunter2');
  assert.equal(vault.apply({ id: 's1', host: 'server.example', password: 'typed' }).password, 'typed');
  assert.equal(vault.apply({ id: 's1', host: 'attacker.example' }).password, undefined);
  assert.equal(vault.apply({ id: 's1', host: 'server.example', gatewayHost: 'other' }).password, undefined);
  vault.prune([]);
  assert.deepEqual(state.vault, {});
  const locked = new CredentialVault(store, { isEncryptionAvailable: () => false });
  assert.throws(() => locked.save('s1', { password: 'x' }), /not available/);
});

test('saved sessions keep gateway, X11, compression, transfer and r-services fields', () => {
  const [saved] = sanitizeSessions([{ type: 'rsh', host: 'h', name: 'r', gatewayHost: 'jump', gatewayPort: '2222', gatewayUsername: 'j', compression: 1, agentForward: true, x11: true, x11Display: '2', browserProtocol: 'scp', ftpsMode: 'implicit', savePassword: true, password: 'never' }]);
  assert.equal(saved.type, 'rsh'); assert.equal(saved.gatewayHost, 'jump'); assert.equal(saved.gatewayPort, 2222); assert.equal(saved.compression, true);
  assert.equal(saved.agentForward, true); assert.equal(saved.x11Display, 2); assert.equal(saved.browserProtocol, 'scp'); assert.equal(saved.ftpsMode, 'implicit');
  assert.equal(saved.savePassword, true); assert.equal('password' in saved, false);
});

test('Mac vault capability does not touch Keychain and saving still requires encryption', () => {
  let probes = 0;
  const state = { vault: {} };
  const store = { read: () => state, update: () => assert.fail('Unavailable encryption must never persist a credential') };
  const cipher = { isEncryptionAvailable: () => { probes++; return false; }, encryptString: () => assert.fail('Must not encrypt without access'), decryptString: () => assert.fail('Must not decrypt at startup') };
  const vault = new CredentialVault(store, cipher);
  assert.equal(vault.canSave('darwin'), true);
  assert.equal(probes, 0, 'Mac startup must not request Keychain access');
  assert.equal(vault.canSave('win32'), false);
  assert.equal(probes, 1, 'Windows keeps its existing availability check');
  assert.throws(() => vault.save('s1', { password: 'fixture-only' }), /encryption is not available/);
  assert.equal(probes, 2);
  assert.deepEqual(state.vault, {});
});

test('vault requests encryption access only for a missing secret at the saved destination', () => {
  let probes = 0, decryptions = 0;
  const state = { sessions: [{ id: 's1', host: 'server.example' }], vault: { s1: { password: Buffer.from('encrypted-fixture').toString('base64') } } };
  const vault = new CredentialVault({ read: () => state }, {
    isEncryptionAvailable: () => { probes++; return true; },
    decryptString: () => { decryptions++; return 'fixture-only'; },
  });
  assert.equal(vault.apply({ id: 's1', host: 'attacker.example' }).password, undefined);
  assert.equal(vault.apply({ id: 's1', host: 'server.example', gatewayHost: 'other.example' }).password, undefined);
  assert.equal(vault.apply({ id: 's1', host: 'server.example', password: 'typed-fixture' }).password, 'typed-fixture');
  assert.equal(probes, 0);
  assert.equal(decryptions, 0);
  assert.equal(vault.apply({ id: 's1', host: 'server.example' }).password, 'fixture-only');
  assert.equal(probes, 1);
  assert.equal(decryptions, 1);
});
