'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const { ServerManager } = require('../extensions/servers.cjs');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'termora-server-test-'));
  const root = path.join(temporary, 'root');
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'hello.txt'), 'hello world');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside-secret');
  const manager = new ServerManager();
  t.after(async () => { await manager.closeAll(); await fs.rm(temporary, { recursive: true, force: true }); });
  return { root, outside, manager };
}

function request(port, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, agent: false }, response => {
      const chunks = []; response.on('data', data => chunks.push(data));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('HTTP timeout'))); req.end();
  });
}

function rrq(name, opcode = 1) {
  const prefix = Buffer.alloc(2); prefix.writeUInt16BE(opcode);
  return Buffer.concat([prefix, Buffer.from(name + '\0octet\0')]);
}

function tftp(port, packet, acknowledge = true) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4'); const chunks = [];
    const timer = setTimeout(() => finish(new Error('TFTP timeout')), 4000);
    const finish = (error, result) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(result); };
    socket.on('error', error => finish(error));
    socket.on('message', (message, remote) => {
      const opcode = message.readUInt16BE(0);
      if (opcode === 5) { finish(null, { error: message.readUInt16BE(2), message: message.subarray(4).toString() }); return; }
      if (opcode !== 3) { finish(new Error('Expected DATA')); return; }
      chunks.push(message.subarray(4));
      if (acknowledge) { const ack = Buffer.alloc(4); ack.writeUInt16BE(4); ack.writeUInt16BE(message.readUInt16BE(2), 2); socket.send(ack, remote.port, '127.0.0.1'); }
      if (message.length < 516) finish(null, { data: Buffer.concat(chunks) });
    });
    socket.bind(0, '127.0.0.1', () => socket.send(packet, port, '127.0.0.1'));
  });
}

test('HTTP serves files and HEAD, escapes directory listing and rejects writes', async t => {
  const { root, manager } = await fixture(t);
  await fs.writeFile(path.join(root, '<unsafe>.txt'), 'data').catch(async error => {
    // Windows forbids angle brackets in filenames; ampersand is valid on both hosts.
    if (process.platform !== 'win32') throw error;
    await fs.writeFile(path.join(root, 'a&b.txt'), 'data');
  });
  const server = await manager.start({ type: 'http', root, port: 0 });
  assert.equal(server.host, '127.0.0.1'); assert.ok(server.port > 0); assert.equal(server.status, 'running');
  const file = await request(server.port, '/hello.txt'); assert.equal(file.status, 200); assert.equal(file.body, 'hello world');
  const head = await request(server.port, '/hello.txt', 'HEAD'); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], '11');
  const directory = await request(server.port, '/'); assert.equal(directory.status, 200);
  assert.match(directory.body, process.platform === 'win32' ? /a&amp;b\.txt/ : /&lt;unsafe&gt;\.txt/);
  assert.equal((await request(server.port, '/', 'POST')).status, 405);
  assert.equal((await request(server.port, '/missing')).status, 404);
  assert.equal((await request(server.port, '/%zz')).status, 400);
});

test('HTTP refuses encoded traversal, Windows ADS and root-leaving symlinks', async t => {
  const { root, outside, manager } = await fixture(t);
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const server = await manager.start({ type: 'http', root });
  for (const url of ['/../outside/secret.txt', '/%2e%2e/outside/secret.txt', '/..%5coutside%5csecret.txt', '/C:%5cWindows', '/hello.txt:stream', '/linked/secret.txt']) {
    const result = await request(server.port, url);
    assert.equal(result.status, 403, url); assert.doesNotMatch(result.body, /outside-secret/);
  }
});

test('TFTP reads multiple DATA blocks with ACKs and rejects writes/traversal/symlinks', async t => {
  const { root, outside, manager } = await fixture(t);
  const expected = Buffer.alloc(1300); for (let i = 0; i < expected.length; i++) expected[i] = i % 256;
  await fs.writeFile(path.join(root, 'binary.dat'), expected);
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const server = await manager.start({ type: 'tftp', root });
  assert.deepEqual((await tftp(server.port, rrq('binary.dat'))).data, expected);
  assert.equal((await tftp(server.port, rrq('upload.txt', 2))).error, 2);
  assert.equal((await tftp(server.port, rrq('../outside/secret.txt'))).error, 2);
  assert.equal((await tftp(server.port, rrq('linked/secret.txt'))).error, 2);
  assert.equal((await tftp(server.port, rrq('missing.txt'))).error, 1);
});

test('TCP echo returns real data and stop closes active clients', async t => {
  const { manager } = await fixture(t);
  const server = await manager.start({ type: 'echo' });
  const client = net.connect({ host: '127.0.0.1', port: server.port });
  client.on('error', () => {});
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
  const data = new Promise(resolve => client.once('data', resolve));
  client.write('echo-this'); assert.equal((await data).toString(), 'echo-this');
  const closed = new Promise(resolve => client.once('close', resolve));
  assert.equal(await manager.stop(server.id), true); await closed;
  assert.equal(await manager.stop(server.id), false); assert.deepEqual(manager.list(), []);
});

test('TFTP handles exact block-size EOF and refuses files at the 16 MiB ceiling', async t => {
  const { root, manager } = await fixture(t);
  const exact = Buffer.alloc(512, 0xa5);
  await fs.writeFile(path.join(root, 'exact.bin'), exact);
  await fs.writeFile(path.join(root, 'empty.bin'), '');
  const large = await fs.open(path.join(root, 'large.bin'), 'w');
  await large.truncate(16 * 1024 * 1024); await large.close();
  const server = await manager.start({ type: 'tftp', root });
  assert.deepEqual((await tftp(server.port, rrq('exact.bin'))).data, exact);
  assert.equal((await tftp(server.port, rrq('empty.bin'))).data.length, 0);
  assert.equal((await tftp(server.port, rrq('large.bin'))).error, 2);
});

test('TFTP retransmits an unacknowledged block then closes its transfer on stop', async t => {
  const { root, manager } = await fixture(t);
  const server = await manager.start({ type: 'tftp', root });
  const socket = dgram.createSocket('udp4');
  t.after(() => { try { socket.close(); } catch {} });
  const packets = [];
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Expected TFTP retransmission')), 2500);
    socket.on('message', data => { packets.push(Buffer.from(data)); if (packets.length === 2) { clearTimeout(timeout); resolve(); } });
    socket.on('error', reject);
    socket.bind(0, '127.0.0.1', () => socket.send(rrq('hello.txt'), server.port, '127.0.0.1'));
  });
  assert.deepEqual(packets[0], packets[1]);
  assert.equal(packets[0].readUInt16BE(0), 3);
  await manager.stop(server.id);
  assert.deepEqual(manager.list(), []);
});

test('validation does not start services and closeAll disposes all listeners', async t => {
  const { root, manager } = await fixture(t);
  await assert.rejects(manager.start({ type: 'nfs' }), /Supported server/);
  await assert.rejects(manager.start({ type: 'http', root: 'relative' }), /absolute/);
  await assert.rejects(manager.start({ type: 'echo', port: 70000 }), /Port/);
  await assert.rejects(manager.start({ type: 'http', root: path.join(root, 'hello.txt') }), /directory/);
  await manager.start({ type: 'http', root }); await manager.start({ type: 'tftp', root }); await manager.start({ type: 'echo' });
  assert.equal(manager.list().length, 3); await manager.closeAll(); assert.deepEqual(manager.list(), []);
  await assert.rejects(manager.start({ type: 'echo' }), /closed/);
});
