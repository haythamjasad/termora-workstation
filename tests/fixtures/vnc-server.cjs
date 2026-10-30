'use strict';
// Minimal RFB 3.8 server for tests: VNC-password or no authentication, a solid
// colour framebuffer sent with Raw encoding, and a record of input events.
const net = require('node:net');
const { desEncrypt } = require('../../lib/des.cjs');

function reversedKey(password) {
  const key = Buffer.alloc(8); Buffer.from(password, 'latin1').copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) { let b = key[i], r = 0; for (let bit = 0; bit < 8; bit++) { r = (r << 1) | (b & 1); b >>= 1; } key[i] = r; }
  return key;
}

function createVncServer({ password = '', width = 64, height = 48, color = [0, 160, 80], name = 'Termora test desktop', securityTypes } = {}) {
  const record = { keys: [], pointers: [], clipboard: [], authenticated: 0, failures: 0, clients: new Set() };
  const server = net.createServer(socket => {
    record.clients.add(socket); socket.on('close', () => record.clients.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0), phase = 'version', challenge = null;
    let format = { bpp: 32, bigEndian: 0, redShift: 16, greenShift: 8, blueShift: 0 };
    socket.write('RFB 003.008\n');
    const types = securityTypes || (password ? [2] : [1]);
    const frame = () => {
      const bytes = format.bpp / 8, pixels = Buffer.alloc(width * height * bytes);
      const value = ((color[0] << format.redShift) | (color[1] << format.greenShift) | (color[2] << format.blueShift)) >>> 0;
      for (let i = 0; i < width * height; i++) { if (format.bigEndian) pixels.writeUInt32BE(value, i * 4); else pixels.writeUInt32LE(value, i * 4); }
      const head = Buffer.alloc(16); head[0] = 0; head.writeUInt16BE(1, 2); head.writeUInt16BE(0, 4); head.writeUInt16BE(0, 6); head.writeUInt16BE(width, 8); head.writeUInt16BE(height, 10); head.writeInt32BE(0, 12);
      socket.write(Buffer.concat([head, pixels]));
    };
    record.sendClipboard = text => { const head = Buffer.alloc(8); head[0] = 3; head.writeUInt32BE(Buffer.byteLength(text, 'latin1'), 4); for (const client of record.clients) client.write(Buffer.concat([head, Buffer.from(text, 'latin1')])); };
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        if (phase === 'version') { if (buffer.length < 12) return; buffer = buffer.subarray(12); socket.write(Buffer.from([types.length, ...types])); phase = 'security'; continue; }
        if (phase === 'security') {
          if (buffer.length < 1) return;
          const chosen = buffer[0]; buffer = buffer.subarray(1);
          if (chosen === 2) { challenge = Buffer.from('0123456789abcdef'); socket.write(challenge); phase = 'response'; }
          else { socket.write(Buffer.alloc(4)); phase = 'init'; }
          continue;
        }
        if (phase === 'response') {
          if (buffer.length < 16) return;
          const response = buffer.subarray(0, 16); buffer = buffer.subarray(16);
          if (!response.equals(desEncrypt(reversedKey(password), challenge))) {
            record.failures++; const reason = Buffer.from('Authentication failed'); const out = Buffer.alloc(8); out.writeUInt32BE(1, 0); out.writeUInt32BE(reason.length, 4); socket.end(Buffer.concat([out, reason])); return;
          }
          record.authenticated++; socket.write(Buffer.alloc(4)); phase = 'init'; continue;
        }
        if (phase === 'init') {
          if (buffer.length < 1) return;
          buffer = buffer.subarray(1);
          const nameBytes = Buffer.from(name), init = Buffer.alloc(24);
          init.writeUInt16BE(width, 0); init.writeUInt16BE(height, 2);
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
          init.writeUInt32BE(nameBytes.length, 20);
          socket.write(Buffer.concat([init, nameBytes])); phase = 'normal'; continue;
        }
        if (!buffer.length) return;
        const type = buffer[0];
        const need = { 0: 20, 3: 10, 4: 8, 5: 6, 150: 10 }[type] ?? (type === 2 ? (buffer.length >= 4 ? 4 + 4 * buffer.readUInt16BE(2) : Infinity) : type === 6 ? (buffer.length >= 8 ? 8 + buffer.readUInt32BE(4) : Infinity) : -1);
        if (need === -1) { buffer = Buffer.alloc(0); return; }
        if (buffer.length < need) return;
        const message = buffer.subarray(0, need); buffer = buffer.subarray(need);
        if (type === 0) format = { bpp: message[4], bigEndian: message[6], redShift: message[14], greenShift: message[15], blueShift: message[16] };
        else if (type === 3) frame();
        else if (type === 4) record.keys.push({ down: message[1] === 1, keysym: message.readUInt32BE(4) });
        else if (type === 5) record.pointers.push({ mask: message[1], x: message.readUInt16BE(2), y: message.readUInt16BE(4) });
        else if (type === 6) record.clipboard.push(message.subarray(8).toString('latin1'));
      }
    });
  });
  return { server, record };
}

module.exports = { createVncServer, reversedKey };
