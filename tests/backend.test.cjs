const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { StateStore, sanitizeSessions, importMobaIni, validateHost, validPort } = require('../lib/state.cjs');
const { TerminalManager, TelnetDecoder } = require('../lib/terminals.cjs');
const { FileManager } = require('../lib/files.cjs');
const { runTool } = require('../lib/system.cjs');

function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termora-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test('state persists session identity and never stores authentication secrets', t => {
  const store = new StateStore(temporary(t));
  const saved = store.saveSessions([{ type: 'ssh', name: 'Example', host: '127.0.0.1', port: 2222, group: 'Lab', username: 'tester', password: 'SENSITIVE', passphrase: 'SECRET', privateKey: 'SECRETKEY' }]);
  assert.equal(saved[0].group, 'Lab'); assert.equal(saved[0].port, 2222);
  const bytes = fs.readFileSync(store.file, 'utf8'); assert.doesNotMatch(bytes, /SENSITIVE|SECRET|password|passphrase|privateKey"/);
  assert.equal(new StateStore(store.directory).read().sessions[0].id, saved[0].id);
  assert.equal(fs.readdirSync(store.directory).length, 1);
});
test('settings clamps terminal resource settings and macros survive restart', t => {
  const store = new StateStore(temporary(t));
  const settings = store.saveSettings({ theme: 'light', fontSize: 999, scrollback: -1 });
  assert.equal(settings.fontSize, 32); assert.equal(settings.scrollback, 1000);
  store.saveMacros([{ name: 'Where am I?', command: 'pwd', appendEnter: true }]);
  assert.equal(new StateStore(store.directory).read().macros[0].command, 'pwd');
});
test('display preferences persist with constrained values and exclude arbitrary UI keys', t => {
  const store = new StateStore(temporary(t));
  const saved=store.saveSettings({theme:'dark',ui:{sidebarSide:'right',toolbarStyle:'small',chrome:'menu',tabNumbers:true,tabClose:false,roundedTabs:false,extra:'discard'}});
  assert.equal(new StateStore(store.directory).read().settings.ui.sidebarSide,'right');
  assert.equal(saved.ui.tabNumbers,true);assert.equal(saved.ui.tabClose,false);assert.equal(saved.ui.extra,undefined);
  const invalid=store.saveSettings({ui:{sidebarSide:'elsewhere',toolbarStyle:'giant',chrome:'none'}});
  assert.equal(invalid.ui.sidebarSide,'left');assert.equal(invalid.ui.toolbarStyle,'captions');assert.equal(invalid.ui.chrome,'both');
});
test('host and port validation rejects process-option injection and invalid ports', () => {
  for (const host of ['-oProxyCommand=bad', 'example.com /admin', 'a\nb', 'a/b', '']) assert.throws(() => validateHost(host));
  assert.equal(validateHost('::1'), '::1'); assert.equal(validPort('2222'), 2222);
  for (const port of [0, -1, 65536, 'abc', 2.2]) assert.throws(() => validPort(port));
  assert.throws(() => sanitizeSessions([{ type: 'unexpected' }]));
});
test('basic MobaXterm INI bookmark identity import excludes opaque/password fields', () => {
  const ini = '[Bookmarks]\r\nSubRep=Servers\r\nImgNum=41\r\nExample=#109#0%example.test%2222%alice%OPAQUE_PASSWORD#rest\r\nUnsupported=#109#99%host%22%a#rest\r\n';
  const result = importMobaIni(ini);
  assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].host, 'example.test'); assert.equal(result.sessions[0].username, 'alice'); assert.equal(result.sessions[0].port, 2222); assert.equal(result.sessions[0].folder, 'Servers');
  assert.doesNotMatch(JSON.stringify(result), /OPAQUE_PASSWORD/); assert.equal(result.warnings.length, 1);
  assert.equal(importMobaIni('[Bookmarks]\nSubRep=\nImgNum=41').sessions.length, 0);
});
test('local file browser/editor handles real files and prevents accidental overwrite/recursive delete', async t => {
  const root = temporary(t), manager = new FileManager({ session: () => { throw new Error('unexpected'); } });
  fs.mkdirSync(path.join(root, 'folder')); fs.writeFileSync(path.join(root, 'hello.txt'), 'hello'); fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 1]));
  const listing = await manager.list({ path: root }); assert.equal(listing.entries[0].name, 'folder');
  assert.equal((await manager.read({ path: path.join(root, 'hello.txt') })).content, 'hello');
  await manager.write({ path: path.join(root, 'hello.txt'), content: 'updated' }); assert.equal(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), 'updated');
  await assert.rejects(manager.read({ path: path.join(root, 'binary.bin') }), /binary/);
  await assert.rejects(manager.action({ action: 'rename', path: path.join(root, 'hello.txt'), newPath: path.join(root, 'binary.bin') }), /exists/);
  await manager.action({ action: 'mkdir', path: path.join(root, 'new') });
  await manager.action({ action: 'rename', path: path.join(root, 'hello.txt'), newPath: path.join(root, 'renamed.txt') });
  await manager.upload(null, path.join(root, 'renamed.txt'), path.join(root, 'copied.txt')); assert.equal(fs.readFileSync(path.join(root, 'copied.txt'), 'utf8'), 'updated');
  await assert.rejects(manager.upload(null, path.join(root, 'renamed.txt'), path.join(root, 'copied.txt')), /EEXIST/);
  fs.writeFileSync(path.join(root, 'folder', 'keep'), 'important');
  await assert.rejects(manager.action({ action: 'delete', path: path.join(root, 'folder') })); assert.equal(fs.readFileSync(path.join(root, 'folder', 'keep'), 'utf8'), 'important');
});
test('Telnet option negotiation handles split IAC sequences and escaped IAC', () => {
  const responses = [], decoder = new TelnetDecoder({ write: bytes => responses.push([...bytes]) });
  assert.equal(decoder.decode(Buffer.from([65, 255, 251])).toString(), 'A');
  assert.equal(decoder.decode(Buffer.from([1, 66])).toString(), 'B'); assert.deepEqual(responses, [[255, 253, 1]]);
  assert.deepEqual([...decoder.decode(Buffer.from([255, 255]))], [255]);
  assert.equal(decoder.decode(Buffer.from([255, 250, 24, 1])).length, 0);
  assert.equal(decoder.decode(Buffer.from([255, 240, 67])).toString(), 'C');
});
test('TCP diagnostics uses a real localhost socket and reports closed ports', async t => {
  const server = net.createServer(socket => socket.end()); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  assert.match(await runTool({ tool: 'ports', host: '127.0.0.1', port }), /is open/);
  await new Promise(resolve => server.close(resolve));
  assert.match(await runTool({ tool: 'ports', host: '127.0.0.1', port }), /ECONNREFUSED|timed out/);
});
test('real SSH shell rejects untrusted keys and supports verified shell I/O and SFTP-unavailable explanation', { timeout: 15000 }, async t => {
  const { Server } = require('ssh2');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const clients = new Set();
  const server = new Server({ hostKeys: [privateKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => context.method === 'password' && context.password === 'test' ? context.accept() : context.reject());
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('pty', acceptPty => acceptPty?.());
      session.on('sftp', (_accept, reject) => reject());
      session.on('shell', acceptShell => { const stream = acceptShell(); stream.write('ready\r\n'); stream.on('data', data => stream.write(`echo:${data}`)); });
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const client of clients) client.end(); server.close(); });
  const config = { type: 'ssh', host: '127.0.0.1', port: server.address().port, username: 'tester', password: 'test' };
  const rejectManager = new TerminalManager({ emit: () => {}, verifyHost: async () => false });
  await assert.rejects(rejectManager.open(config), /Host denied|verification|Handshake|host key/i);
  let fingerprint, output = '';
  const manager = new TerminalManager({ emit: (channel, event) => { if (channel === 'terminal:data') output += event.data; }, verifyHost: async request => { fingerprint = request.fingerprint; return true; } });
  t.after(() => manager.closeAll());
  const terminal = await manager.open(config); assert.match(fingerprint, /^SHA256:/); assert.equal(terminal.kind, 'ssh');
  manager.write({ id: terminal.id, data: 'hello\r' });
  const start = Date.now(); while (!output.includes('echo:hello') && Date.now() - start < 3000) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(output, /echo:hello/);
  await assert.rejects(new FileManager(manager).list({ id: terminal.id }), /SFTP|support|subsystem|request|channel/i);
});
