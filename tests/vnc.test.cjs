'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { desEncrypt } = require('../lib/des.cjs');
const { vncResponse } = require('../lib/vnc.cjs');
const { TerminalManager } = require('../lib/terminals.cjs');
const { createVncServer } = require('./fixtures/vnc-server.cjs');

function until(check, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => { const value = check(); if (value) resolve(value); else if (Date.now() - started > timeout) reject(new Error('Timed out waiting for condition.')); else setTimeout(tick, 10); };
    tick();
  });
}
async function fixture(t, options) {
  const { server, record } = createVncServer(options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const received = new Map();
  const terminals = new TerminalManager({ emit: (channel, payload) => { if (channel === 'vnc:data') received.set(payload.id, Buffer.concat([received.get(payload.id) || Buffer.alloc(0), payload.data])); }, store: null, verifyHost: () => true });
  t.after(() => { terminals.closeAll(); for (const client of record.clients) client.destroy(); server.close(); });
  return { port: server.address().port, record, terminals, received };
}

test('DES matches the FIPS 46 worked example and VNC keys are bit-reversed', () => {
  assert.equal(desEncrypt(Buffer.from('133457799BBCDFF1', 'hex'), Buffer.from('0123456789ABCDEF', 'hex')).toString('hex'), '85e813540f0ab405');
  // "password" bit-reversed per byte, as RFB requires.
  assert.deepEqual(vncResponse(Buffer.alloc(16), 'password'), desEncrypt(Buffer.from([0x0e, 0x86, 0xce, 0xce, 0xee, 0xf6, 0x4e, 0x26]), Buffer.alloc(16)));
});

test('VNC password is answered in the main process and the viewer sees a None handshake', async t => {
  const { port, record, terminals, received } = await fixture(t, { password: 'secret12' });
  const session = await terminals.openVnc({ host: '127.0.0.1', port, password: 'secret12' });
  assert.equal(session.security, 'VNC password'); assert.equal(record.authenticated, 1);
  terminals.vncStart(session.id);
  await until(() => received.get(session.id)?.toString('latin1') === 'RFB 003.008\n');
  terminals.vncWrite({ id: session.id, data: new Uint8Array(Buffer.from('RFB 003.008\n')) });
  await until(() => received.get(session.id).length === 14);
  assert.deepEqual([...received.get(session.id).subarray(12)], [1, 1]); // one type: None
  terminals.vncWrite({ id: session.id, data: new Uint8Array([1, 1]) }); // choose None + ClientInit(shared)
  await until(() => received.get(session.id).length >= 18 + 24);
  const afterResult = received.get(session.id).subarray(14);
  assert.equal(afterResult.readUInt32BE(0), 0);
  assert.equal(afterResult.readUInt16BE(4), 64); assert.equal(afterResult.readUInt16BE(6), 48);
  assert.match(afterResult.subarray(28).toString(), /Termora test desktop/);
  // Input from the viewer is relayed verbatim once authenticated.
  const key = Buffer.alloc(8); key[0] = 4; key[1] = 1; key.writeUInt32BE(0x61, 4);
  terminals.vncWrite({ id: session.id, data: new Uint8Array(key) });
  await until(() => record.keys.length === 1);
  assert.deepEqual(record.keys[0], { down: true, keysym: 0x61 });
});

test('VNC rejects wrong passwords, missing passwords and unsupported security', async t => {
  const protectedServer = await fixture(t, { password: 'secret12' });
  await assert.rejects(protectedServer.terminals.openVnc({ host: '127.0.0.1', port: protectedServer.port, password: 'wrong' }), /authentication failed: Authentication failed/i);
  await assert.rejects(protectedServer.terminals.openVnc({ host: '127.0.0.1', port: protectedServer.port }), /requires a password/);
  const vencrypt = await fixture(t, { securityTypes: [19, 18] });
  await assert.rejects(vencrypt.terminals.openVnc({ host: '127.0.0.1', port: vencrypt.port }), /VeNCrypt, TLS/);
  const open = await fixture(t, {});
  const session = await open.terminals.openVnc({ host: '127.0.0.1', port: open.port });
  assert.equal(session.security, 'None');
  const notVnc = net.createServer(socket => socket.end('SSH-2.0-OpenSSH\r\n')); notVnc.listen(0, '127.0.0.1'); await once(notVnc, 'listening'); t.after(() => notVnc.close());
  await assert.rejects(open.terminals.openVnc({ host: '127.0.0.1', port: notVnc.address().port }), /does not speak the VNC/);
});
