const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { TerminalManager } = require('../lib/terminals.cjs');

async function listen(server, port = 0, host = '127.0.0.1') { server.listen(port, host); await once(server, 'listening'); return server.address().port; }
async function unusedPort() { const server = net.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
function exchange(port, bytes, expected) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }); let received = Buffer.alloc(0);
    socket.setTimeout(4000, () => { socket.destroy(); reject(new Error('Tunnel response timed out')); });
    socket.on('error', reject); socket.once('connect', () => socket.write(bytes));
    socket.on('data', data => { received = Buffer.concat([received, data]); if (received.includes(Buffer.from(expected))) { socket.destroy(); resolve(received); } });
  });
}
async function fixture(t) {
  const { Server } = require('ssh2');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const sockets = new Set(), forwards = new Map(), clients = new Set();
  const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); return socket; };
  const echo = net.createServer(socket => { track(socket); socket.pipe(socket); });
  const echoPort = await listen(echo);
  const ssh = new Server({ hostKeys: [privateKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => { clients.delete(client); for (const [key, server] of forwards) { if (key.startsWith(client._sock?.remotePort + ':')) { server.close(); forwards.delete(key); } } });
    client.on('authentication', auth => auth.accept());
    client.on('tcpip', (accept, reject, info) => {
      const socket = track(net.createConnection({ host: info.destIP, port: info.destPort }));
      socket.once('error', () => reject());
      socket.once('connect', () => { const channel = track(accept()); socket.pipe(channel).pipe(socket); socket.on('close', () => channel.destroy()); });
    });
    client.on('request', (accept, reject, name, info) => {
      const key = client._sock?.remotePort + ':' + info.bindPort;
      if (name === 'tcpip-forward') {
        const server = net.createServer(socket => {
          track(socket);
          client.forwardOut(info.bindAddr, info.bindPort, socket.remoteAddress, socket.remotePort, (error, channel) => {
            if (error) { socket.destroy(); return; } track(channel); socket.pipe(channel).pipe(socket); socket.on('close', () => channel.destroy());
          });
        });
        server.once('error', () => reject?.());
        server.listen(info.bindPort, info.bindAddr, () => { forwards.set(key, server); accept?.(); });
      } else if (name === 'cancel-tcpip-forward') { forwards.get(key)?.close(); forwards.delete(key); accept?.(); }
      else reject?.();
    });
  });
  const sshPort = await listen(ssh);
  const manager = new TerminalManager({ emit: () => {}, verifyHost: async () => true });
  t.after(async () => { manager.closeAll(); for (const socket of sockets) socket.destroy(); for (const client of clients) client.end(); for (const server of forwards.values()) server.close(); echo.close(); ssh.close(); });
  return { manager, echoPort, config: { host: '127.0.0.1', port: sshPort, username: 'test', password: 'test' } };
}
test('local SSH tunnel carries real TCP data and closing releases its listener', { timeout: 12000 }, async t => {
  const { manager, echoPort, config } = await fixture(t), localPort = await unusedPort();
  const tunnel = await manager.createTunnel({ ...config, mode: 'local', localPort, remoteHost: '127.0.0.1', remotePort: echoPort });
  assert.equal(tunnel.mode, 'local'); assert.equal(tunnel.localHost, '127.0.0.1');
  assert.equal((await exchange(localPort, 'local-tunnel-proof', 'local-tunnel-proof')).toString(), 'local-tunnel-proof');
  manager.closeTunnel(tunnel.id); assert.equal(manager.listTunnels().length, 0);
  await assert.rejects(exchange(localPort, 'no', 'no'), /ECONNREFUSED|closed/);
});
test('reverse SSH tunnel carries real remote-listener data back to a local service', { timeout: 12000 }, async t => {
  const { manager, echoPort, config } = await fixture(t), remotePort = await unusedPort();
  const tunnel = await manager.createTunnel({ ...config, mode: 'remote', localPort: echoPort, remotePort });
  assert.equal(tunnel.remoteHost, '127.0.0.1');
  assert.equal((await exchange(remotePort, 'reverse-tunnel-proof', 'reverse-tunnel-proof')).toString(), 'reverse-tunnel-proof');
  manager.closeTunnel(tunnel.id); assert.equal(manager.listTunnels().length, 0);
});
test('dynamic SSH SOCKS5 handles IPv4 and hostname CONNECT with fragmented greeting', { timeout: 12000 }, async t => {
  const { manager, echoPort, config } = await fixture(t), localPort = await unusedPort();
  await manager.createTunnel({ ...config, mode: 'dynamic', localPort });
  const port = Buffer.alloc(2); port.writeUInt16BE(echoPort);
  const ipv4 = Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1]), port, Buffer.from('socks-ipv4-proof')]);
  const response = await exchange(localPort, ipv4, 'socks-ipv4-proof'); assert.deepEqual([...response.subarray(0, 4)], [5, 0, 5, 0]);
  const name = Buffer.from('127.0.0.1');
  const domain = Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, name.length]), name, port, Buffer.from('socks-host-proof')]);
  assert.match((await exchange(localPort, domain, 'socks-host-proof')).toString(), /socks-host-proof/);
  const rejected = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: localPort });
    socket.on('error', reject); socket.once('connect', () => { socket.write(Buffer.from([5])); setTimeout(() => socket.write(Buffer.from([1, 2])), 5); }); socket.once('data', data => { socket.destroy(); resolve(data); });
  });
  assert.deepEqual([...rejected], [5, 255]);
});
test('tunnel modes reject non-loopback bind requests before making an SSH connection', async () => {
  const manager = new TerminalManager({ emit: () => {}, verifyHost: async () => true });
  await assert.rejects(manager.createTunnel({ localHost: '0.0.0.0' }), /localhost/);
  await assert.rejects(manager.createTunnel({ mode: 'unsupported' }), /mode/);
});
test('dynamic SSH SOCKS5 handles a real IPv6 loopback CONNECT', { timeout: 12000 }, async t => {
  const { manager, config } = await fixture(t), localPort = await unusedPort();
  const sockets = new Set();
  const echo6 = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket); });
  let port6;
  try { port6 = await listen(echo6, 0, '::1'); }
  catch (error) { if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { t.skip('IPv6 loopback is not configured on this host.'); return; } throw error; }
  t.after(() => { for (const socket of sockets) socket.destroy(); echo6.close(); });
  await manager.createTunnel({ ...config, mode: 'dynamic', localPort });
  const ipv6 = Buffer.alloc(16); ipv6[15] = 1;
  const port = Buffer.alloc(2); port.writeUInt16BE(port6);
  const request = Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 4]), ipv6, port, Buffer.from('socks-ipv6-proof')]);
  assert.match((await exchange(localPort, request, 'socks-ipv6-proof')).toString(), /socks-ipv6-proof/);
});
