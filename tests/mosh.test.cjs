'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { OCB } = require('../lib/ocb.cjs');
const { MoshClient, Connection, Assembler, fragment, encodeInstruction, decodeInstruction, encodeUserDiff, decodeUserDiff, varint, decode, MAX_NUM } = require('../lib/mosh.cjs');
const { TerminalManager } = require('../lib/terminals.cjs');
const { createMoshServer } = require('./fixtures/mosh-server.cjs');

function until(check, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => { const value = check(); if (value) resolve(value); else if (Date.now() - started > timeout) reject(new Error('Timed out waiting for condition.')); else setTimeout(tick, 10); };
    tick();
  });
}

test('AES-128-OCB matches the RFC 7253 sample results', () => {
  const ocb = new OCB(Buffer.from('000102030405060708090A0B0C0D0E0F', 'hex'));
  const vectors = [
    ['BBAA99887766554433221100', '', '', '785407BFFFC8AD9EDCC5520AC9111EE6'],
    ['BBAA99887766554433221101', '0001020304050607', '0001020304050607', '6820B3657B6F615A5725BDA0D3B4EB3A257C9AF1F8F03009'],
    ['BBAA99887766554433221102', '0001020304050607', '', '81017F8203F081277152FADE694A0A00'],
    ['BBAA99887766554433221103', '', '0001020304050607', '45DD69F8F5AAE72414054CD1F35D82760B2CD00D2F99BFA9'],
  ];
  for (const [nonce, aad, plain, expected] of vectors) {
    const sealed = ocb.encrypt(Buffer.from(nonce, 'hex'), Buffer.from(plain, 'hex'), Buffer.from(aad, 'hex'));
    assert.equal(sealed.toString('hex').toUpperCase(), expected);
    assert.equal(ocb.decrypt(Buffer.from(nonce, 'hex'), sealed, Buffer.from(aad, 'hex')).toString('hex').toUpperCase(), plain);
  }
  const tampered = ocb.encrypt(Buffer.alloc(12), Buffer.from('mosh')); tampered[0] ^= 1;
  assert.throws(() => ocb.decrypt(Buffer.alloc(12), tampered), /authentication/);
});

test('protobuf, instruction and fragment encodings round-trip', () => {
  assert.deepEqual([...varint(300)], [0xac, 0x02]);
  assert.deepEqual([...varint(MAX_NUM)], [255, 255, 255, 255, 255, 255, 255, 255, 255, 1]);
  const instruction = { oldNum: 3n, newNum: MAX_NUM, ackNum: 7n, throwawayNum: 3n, diff: Buffer.from('diff') };
  assert.deepEqual(decodeInstruction(encodeInstruction(instruction)), { protocolVersion: 2n, ...instruction });
  const events = [{ type: 'resize', cols: 120, rows: 40 }, { type: 'keys', data: Buffer.from('l') }, { type: 'keys', data: Buffer.from('s\r') }];
  const diff = encodeUserDiff(events);
  assert.equal(decode(diff).get(1).length, 2, 'consecutive keystrokes share one instruction');
  assert.deepEqual(decodeUserDiff(diff), [{ type: 'resize', cols: 120, rows: 40 }, { type: 'keys', data: Buffer.from('ls\r') }]);
  const big = encodeInstruction({ ...instruction, diff: crypto.randomBytes(5000) });
  const pieces = fragment(big, 9n, 500), assembler = new Assembler();
  assert.ok(pieces.length > 5);
  const results = [...pieces].reverse().map(piece => assembler.add(piece));
  assert.deepEqual(results.filter(Boolean)[0], big, 'fragments reassemble in any order');
});

test('datagrams reject the wrong key, direction and tampering', () => {
  const key = crypto.randomBytes(16), server = new Connection(key, true), client = new Connection(key, false);
  const packet = server.seal(Buffer.from('payload'));
  assert.equal(client.open(packet).payload.toString(), 'payload');
  assert.throws(() => server.open(server.seal(Buffer.from('x'))), /direction/);
  assert.throws(() => new Connection(crypto.randomBytes(16), false).open(packet), /authentication/);
});

test('Mosh client syncs keystrokes, resizes and screen output, and survives packet loss', async t => {
  const server = createMoshServer(); const port = await server.listen(); t.after(() => server.close());
  let screen = '', exit = null;
  const client = new MoshClient({ host: '127.0.0.1', port, key: server.key, cols: 100, rows: 30, onData: data => { screen += data; }, onExit: code => { exit = code; } });
  await client.start(); t.after(() => client.finish(0));
  await until(() => screen.includes('Welcome to the test Mosh server'));
  assert.deepEqual(server.record.sizes, [[100, 30]]);
  client.write('echo hi\r');
  await until(() => screen.endsWith('echo hi\r'));
  // Lose the next two client packets and one server packet; retransmission recovers.
  server.record.dropFromClient = 2; server.record.dropToClient = 1;
  client.write('abc'); client.resize(120, 40);
  await until(() => server.record.keys === 'echo hi\rabc' && screen.endsWith('abc'));
  await until(() => server.record.sizes.length === 2);
  assert.deepEqual(server.record.sizes[1], [120, 40]);
  assert.equal(screen.split('abc').length - 1, 1, 'output is applied exactly once');
  server.output('\r\nlogout\r\n'); await until(() => screen.includes('logout'));
  server.endSession();
  await until(() => exit !== null);
  assert.equal(exit, 0);
});

test('closing a Mosh tab tells the server to end the session', async t => {
  const server = createMoshServer(); const port = await server.listen(); t.after(() => server.close());
  let exit = null;
  const client = new MoshClient({ host: '127.0.0.1', port, key: server.key, onExit: code => { exit = code; } });
  await client.start();
  await until(() => server.record.received > 0);
  client.close();
  await until(() => server.record.shutdown && exit === 0);
});

test('Mosh sessions start mosh-server over SSH and then run over UDP', async t => {
  const mosh = createMoshServer({ welcome: 'MOSH-READY\r\n' }); const udpPort = await mosh.listen(); t.after(() => mosh.close());
  const { Server } = require('ssh2');
  const commands = [];
  const hostKey = require('ssh2').utils.generateKeyPairSync('ed25519').private;
  const ssh = new Server({ hostKeys: [hostKey] }, client => {
    client.on('error', () => {});
    client.on('authentication', context => context.method === 'password' && context.password === 'pw' ? context.accept() : context.reject(['password']));
    client.on('session', accept => {
      const session = accept();
      session.on('pty', ok => ok?.());
      session.on('exec', (ok, _reject, info) => {
        commands.push(info.command); const stream = ok();
        if (info.command.startsWith('missing-server')) { stream.stderr.write('bash: missing-server: command not found\n'); stream.exit(127); stream.end(); return; }
        stream.write(`\r\nMOSH CONNECT ${udpPort} ${mosh.key}\r\n\r\nmosh-server (mosh 1.4.0) [build mosh 1.4.0]\r\n`); stream.exit(0); stream.end();
      });
    });
  });
  ssh.listen(0, '127.0.0.1'); await once(ssh, 'listening'); t.after(() => ssh.close());
  const events = [];
  const terminals = new TerminalManager({ emit: (channel, payload) => events.push({ channel, payload }), store: null, verifyHost: () => true });
  t.after(() => terminals.closeAll());
  const output = id => events.filter(event => event.channel === 'terminal:data' && event.payload.id === id).map(event => event.payload.data).join('');
  const session = await terminals.open({ type: 'mosh', host: '127.0.0.1', port: ssh.address().port, username: 'qa', password: 'pw', cols: 90, rows: 25, moshPorts: '60000:61000' });
  assert.equal(session.kind, 'mosh');
  assert.equal(commands[0], 'mosh-server new -s -c 256 -l LANG=en_US.UTF-8 -p 60000:61000');
  await until(() => output(session.id).includes('MOSH-READY'));
  assert.deepEqual(mosh.record.sizes, [[90, 25]]);
  terminals.write({ id: session.id, data: 'uptime\r' });
  await until(() => output(session.id).includes('uptime'));
  terminals.resize({ id: session.id, cols: 132, rows: 43 });
  await until(() => mosh.record.sizes.some(([cols, rows]) => cols === 132 && rows === 43));
  terminals.close(session.id);
  await until(() => mosh.record.shutdown);
  await assert.rejects(terminals.open({ type: 'mosh', host: '127.0.0.1', port: ssh.address().port, username: 'qa', password: 'pw', moshServer: 'missing-server' }), /not installed/);
  await assert.rejects(terminals.open({ type: 'mosh', host: '127.0.0.1', port: ssh.address().port, username: 'qa', password: 'pw', moshServer: 'mosh-server; rm -rf /' }), /plain path/);
});
