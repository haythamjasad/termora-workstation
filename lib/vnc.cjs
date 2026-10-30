// VNC connections for the embedded noVNC viewer. The main process performs the
// RFB security handshake (so the password never reaches the renderer), then
// presents the viewer with an already-authenticated "None" security handshake
// and relays the rest of the protocol unchanged.
const net = require('node:net');
const { desEncrypt } = require('./des.cjs');

const SECURITY_NAMES = { 1: 'None', 2: 'VNC password', 5: 'RA2', 6: 'RA2ne', 16: 'Tight', 18: 'TLS', 19: 'VeNCrypt', 22: 'XVP', 30: 'Apple ARD', 113: 'MSLogonII', 129: 'Unix login' };

class Reader {
  constructor(socket) {
    this.socket = socket; this.chunks = []; this.length = 0; this.waiter = null; this.error = null;
    this.onData = data => { this.chunks.push(data); this.length += data.length; this.pump(); };
    this.onEnd = error => { this.error = error || new Error('The VNC server closed the connection.'); this.pump(); };
    socket.on('data', this.onData); socket.on('close', () => this.onEnd()); socket.on('error', this.onEnd);
  }
  read(size) { return new Promise((resolve, reject) => { this.waiter = { size, resolve, reject }; this.pump(); }); }
  pump() {
    const waiter = this.waiter;
    if (!waiter) return;
    if (this.length >= waiter.size) {
      const all = Buffer.concat(this.chunks);
      this.chunks = [all.subarray(waiter.size)]; this.length -= waiter.size; this.waiter = null;
      waiter.resolve(all.subarray(0, waiter.size));
    } else if (this.error) { this.waiter = null; waiter.reject(this.error); }
  }
  detach() { this.socket.off('data', this.onData); this.socket.off('error', this.onEnd); return Buffer.concat(this.chunks); }
}

// VNC authentication: DES-encrypt the challenge with the bit-reversed password.
function vncResponse(challenge, password) {
  const key = Buffer.alloc(8);
  Buffer.from(String(password), 'latin1').copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) { let b = key[i], r = 0; for (let bit = 0; bit < 8; bit++) { r = (r << 1) | (b & 1); b >>= 1; } key[i] = r; }
  return desEncrypt(key, challenge);
}

async function readReason(reader) { const size = (await reader.read(4)).readUInt32BE(0); return size ? (await reader.read(Math.min(size, 4096))).toString('utf8') : ''; }

// Client side of the RFB 3.3/3.7/3.8 security handshake.
async function authenticate(socket, password) {
  const reader = new Reader(socket);
  const banner = (await reader.read(12)).toString('latin1');
  const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner);
  if (!match) throw new Error('This server does not speak the VNC (RFB) protocol.');
  const major = Number(match[1]), minor = Number(match[2]);
  const version = major > 3 || minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
  socket.write(`RFB 003.00${version}\n`);
  let type;
  if (version === 3) {
    type = (await reader.read(4)).readUInt32BE(0);
    if (type === 0) throw new Error(`VNC server refused the connection: ${await readReason(reader) || 'no reason given'}`);
  } else {
    const count = (await reader.read(1))[0];
    if (count === 0) throw new Error(`VNC server refused the connection: ${await readReason(reader) || 'no reason given'}`);
    const offered = [...await reader.read(count)];
    if (offered.includes(2) && password) type = 2;
    else if (offered.includes(1)) type = 1;
    else if (offered.includes(2)) throw new Error('This VNC server requires a password.');
    else throw new Error(`This VNC server offers only security types Termora does not support: ${offered.map(value => SECURITY_NAMES[value] || value).join(', ')}.`);
    socket.write(Buffer.from([type]));
  }
  if (type === 2) {
    if (!password) throw new Error('This VNC server requires a password.');
    socket.write(vncResponse(await reader.read(16), password));
  } else if (type !== 1) throw new Error(`This VNC server requires unsupported security type ${SECURITY_NAMES[type] || type}.`);
  if (type === 2 || version === 8) {
    const result = (await reader.read(4)).readUInt32BE(0);
    if (result !== 0) {
      const reason = version === 8 ? await readReason(reader) : '';
      throw new Error(`VNC authentication failed${reason ? `: ${reason}` : '. Check the password.'}`);
    }
  }
  return { reader, version, security: SECURITY_NAMES[type] };
}

// Plays the server side of a 3.8 "None" handshake toward the viewer, then
// relays bytes in both directions.
class ViewerBridge {
  constructor({ socket, leftover, send }) {
    this.socket = socket; this.send = send; this.phase = 'waiting'; this.pending = Buffer.alloc(0);
    this.leftover = leftover;
  }
  // Called once the viewer is attached, so the banner is not lost.
  start() { if (this.phase !== 'waiting') return; this.phase = 'version'; this.send(Buffer.from('RFB 003.008\n')); }
  fromServer(data) { if (this.phase === 'relay') this.send(data); else this.leftover = Buffer.concat([this.leftover, data]); }
  fromViewer(data) {
    if (this.phase === 'relay') { this.socket.write(data); return; }
    if (this.phase === 'waiting') throw new Error('The viewer has not started.');
    this.pending = Buffer.concat([this.pending, data]);
    if (this.phase === 'version' && this.pending.length >= 12) {
      if (!/^RFB 003\.00[378]\n$/.test(this.pending.subarray(0, 12).toString('latin1'))) throw new Error('Unexpected viewer handshake.');
      this.pending = this.pending.subarray(12); this.phase = 'security';
      this.send(Buffer.from([1, 1]));
    }
    if (this.phase === 'security' && this.pending.length >= 1) {
      if (this.pending[0] !== 1) throw new Error('Unexpected viewer security choice.');
      this.pending = this.pending.subarray(1); this.phase = 'relay';
      this.send(Buffer.alloc(4)); // SecurityResult OK
      if (this.leftover.length) this.send(this.leftover);
      if (this.pending.length) this.socket.write(this.pending);
      this.pending = null;
    }
  }
}

async function connectVnc({ host, port, password, timeout = 15000 }) {
  const socket = net.createConnection({ host, port });
  socket.setNoDelay(true);
  socket.setTimeout(timeout, () => socket.destroy(new Error('The VNC server did not answer in time.')));
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const result = await authenticate(socket, password);
    socket.setTimeout(0);
    return { socket, leftover: result.reader.detach(), security: result.security };
  } catch (error) { socket.destroy(); throw error; }
}

module.exports = { connectVnc, authenticate, vncResponse, ViewerBridge };
