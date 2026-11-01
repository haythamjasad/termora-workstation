// Windowless FreeRDP -> in-process RFB adapter for Termora's existing viewer.
// No listening socket is opened. Credentials travel only through child stdin.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeRdpFile } = require('./remote-desktop.cjs');
const { rdpFailure } = require('./rdp-launch.cjs');
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_MESSAGE = 4 * MAX_PIXELS + 16;
function packet(type, data = Buffer.alloc(0)) { const out = Buffer.alloc(5 + data.length); out[0] = type.charCodeAt(0); out.writeUInt32BE(data.length, 1); data.copy(out, 5); return out; }
class PacketReader {
  constructor(receive) { this.receive = receive; this.header = Buffer.alloc(5); this.used = 0; this.payload = null; this.offset = 0; }
  push(data) {
    let offset = 0;
    while (offset < data.length) {
      if (!this.payload) {
        const count = Math.min(5 - this.used, data.length - offset); data.copy(this.header, this.used, offset, offset + count); offset += count; this.used += count;
        if (this.used < 5) continue;
        const length = this.header.readUInt32BE(1); if (length > MAX_MESSAGE) throw new Error('RDP helper message exceeds the display limit.');
        this.payload = Buffer.alloc(length); this.offset = 0;
      }
      const count = Math.min(this.payload.length - this.offset, data.length - offset); data.copy(this.payload, this.offset, offset, offset + count); this.offset += count; offset += count;
      if (this.offset === this.payload.length) { const type = String.fromCharCode(this.header[0]), payload = this.payload; this.payload = null; this.used = 0; this.receive(type, payload); }
    }
  }
}
function secretPacket(config) {
  let username=String(config.username||''), domain=String(config.domain||'');
  if(!domain && username.includes('\\')) { const split=username.indexOf('\\');domain=username.slice(0,split);username=username.slice(split+1); }
  const strings = [username, domain, config.password, config.gatewayUsername, domain, config.gatewayPassword].map(value => Buffer.from(String(value || ''), 'utf8'));
  if (strings.some(value => value.length > 4096 || value.includes(0))) throw new Error('RDP credentials are too long or contain a null character.');
  const data = Buffer.alloc(strings.reduce((size, value) => size + 4 + value.length, 0)); let offset = 0;
  for (const value of strings) { data.writeUInt32BE(value.length, offset); offset += 4; value.copy(data, offset); offset += value.length; value.fill(0); }
  const out = packet('S', data); data.fill(0); return out;
}
function certificateDetails(data) {
  if (data.length < 2) throw new Error('Invalid RDP certificate request.');
  const result = { port: data.readUInt16BE(0) }; let offset = 2;
  for (const key of ['host', 'commonName', 'subject', 'issuer', 'fingerprint']) {
    if (offset + 4 > data.length) throw new Error('Invalid RDP certificate request.');
    const length = data.readUInt32BE(offset); offset += 4;
    if (length > 16384 || offset + length > data.length) throw new Error('Invalid RDP certificate request.');
    result[key] = data.toString('utf8', offset, offset + length); offset += length;
  }
  if (offset !== data.length || !result.fingerprint) throw new Error('Invalid RDP certificate request.');
  return result;
}
class EmbeddedRdp {
  constructor({ send, input, ended = () => {}, verifyCertificate = async () => false }) {
    this.send = send; this.input = input; this.ended = ended; this.verifyCertificate = verifyCertificate;
    this.phase = 'waiting'; this.pending = Buffer.alloc(0); this.width = 0; this.height = 0; this.pixels = null; this.dirty = false; this.requested = false; this.closed = false;
    this.format = { big: false, red: 16, green: 8, blue: 0 }; this.resizeEncoding = false;
  }
  async open(config, executable, { fixture = false } = {}) {
    if (!fixture && (!String(config.username || '').trim() || !config.password)) throw new Error('Enter your Windows username and password in the RDP connection settings.');
    const secret = fixture ? null : secretPacket(config);
    let file; try { file = fixture ? null : writeRdpFile({ ...config, rdpSize: config.rdpSize === 'fit' || config.rdpSize === 'fullscreen' ? '1280x720' : config.rdpSize }); } catch(error) { secret?.fill(0); throw error; }
    this.file = file; this.clipboardAllowed = config.rdpClipboard !== false;
    const modules = path.resolve(path.dirname(executable), '../Frameworks/FreeRDP/ossl-modules');
    const env = { ...process.env, WLOG_LEVEL: 'WARN' };
    if (fs.existsSync(path.join(modules, 'legacy.dylib'))) env.OPENSSL_MODULES = modules;
    const reader = new PacketReader((type, data) => this.fromHelper(type, data));
    return new Promise((resolve, reject) => {
      let spawned = false;
      const child = this.child = spawn(executable, [fixture ? '--self-test' : file], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
      this.input = (type, data) => { if (!this.closed && child.stdin.writable) child.stdin.write(packet(type, data)); };
      child.stdin.on('error', () => {}); child.stderr.on('data', () => {}); // never persist protocol diagnostics
      child.stdout.on('data', data => { try { reader.push(data); } catch (error) { this.fail(error.message); } });
      child.once('spawn', () => {
        spawned = true;
        if (secret) child.stdin.write(secret, () => secret.fill(0));
        resolve();
      });
      child.once('error', () => { secret?.fill(0); const error = new Error('The embedded RDP engine could not start. Install the complete Termora Mac build.'); if (!spawned) reject(error); this.fail(error.message); });
      child.once('close', (code, signal) => { this.removeFile(); clearTimeout(this.timer); if (!this.closed) { this.closed = true; this.ended(this.error || (code ? `RDP session ended (${signal || code}).` : undefined)); } });
      this.timer = setTimeout(() => this.fail('The RDP server did not complete the connection. Check the host, VPN, and credentials.'), 45000);
    });
  }
  removeFile() { if (this.file) { try { fs.rmSync(this.file, { force: true }); } catch {} this.file = null; } }
  fromHelper(type, data) {
    if (this.closed) return;
    if (type === 'R') {
      if (data.length !== 8) throw new Error('Invalid RDP desktop dimensions.');
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4);
      if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_PIXELS) throw new Error('RDP desktop exceeds the display limit.');
      const resized = Boolean(this.width); this.width = width; this.height = height; this.pixels = Buffer.alloc(width * height * 4); this.dirty = true; this.dirtyRect={x:0,y:0,w:width,h:height};
      clearTimeout(this.timer); this.removeFile();
      if (this.phase === 'waiting-engine') this.begin();
      else if (resized && this.phase === 'ready') {
        if (!this.resizeEncoding) throw new Error('The viewer does not support the new RDP screen size.');
        const update = Buffer.alloc(16); update.writeUInt16BE(1, 2); update.writeUInt16BE(width, 8); update.writeUInt16BE(height, 10); update.writeInt32BE(-223, 12); this.send(update);
      }
    } else if (type === 'F') {
      if (!this.pixels || data.length < 16) throw new Error('Invalid RDP framebuffer.');
      const x = data.readUInt32BE(0), y = data.readUInt32BE(4), w = data.readUInt32BE(8), h = data.readUInt32BE(12);
      if (!w || !h || x + w > this.width || y + h > this.height || data.length !== 16 + w * h * 4) throw new Error('Invalid RDP framebuffer bounds.');
      for (let row = 0; row < h; row++) data.copy(this.pixels, ((y + row) * this.width + x) * 4, 16 + row * w * 4, 16 + (row + 1) * w * 4);
      const old=this.dirtyRect;const left=old?Math.min(old.x,x):x,top=old?Math.min(old.y,y):y,right=old?Math.max(old.x+old.w,x+w):x+w,bottom=old?Math.max(old.y+old.h,y+h):y+h;this.dirtyRect={x:left,y:top,w:right-left,h:bottom-top};
      this.dirty = true; this.paint();
    } else if (type === 'C') {
      clearTimeout(this.timer);
      Promise.resolve(this.verifyCertificate(certificateDetails(data))).then(accepted => { this.input('V', Buffer.from([accepted ? 1 : 0])); if (!this.closed) this.timer = setTimeout(() => this.fail('RDP sign-in did not complete.'), 45000); }, () => this.input('V', Buffer.from([0])));
    } else if (type === 'E') this.fail(rdpFailure(data.toString('ascii'), 128) || 'RDP sign-in was cancelled or refused.');
    else if (type !== 'A') throw new Error('Unexpected RDP helper message.');
  }
  fail(message) { if (this.closed) return; this.error = message; this.close(); this.ended(message); }
  close() { if (this.closed) return; this.input?.('Q'); this.closed = true; clearTimeout(this.timer); this.removeFile(); if (this.child) { const child = this.child; child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref(); child.once('close', () => clearTimeout(timer)); } }
  start() { if (this.phase !== 'waiting') return; if (this.width) this.begin(); else this.phase = 'waiting-engine'; }
  begin() { this.phase = 'version'; this.send(Buffer.from('RFB 003.008\n')); }
  fromViewer(data) {
    if (this.closed) return;
    if (this.pending.length + data.length > 1024 * 1024) throw new Error('RDP viewer message exceeds the input limit.');
    this.pending = Buffer.concat([this.pending, data]);
    while (this.pending.length) {
      if (this.phase === 'waiting' || this.phase === 'waiting-engine') throw new Error('RDP viewer has not started.');
      if (this.phase === 'version') { if (this.pending.length < 12) return; if (this.pending.subarray(0, 12).toString() !== 'RFB 003.008\n') throw new Error('Invalid RDP viewer handshake.'); this.pending = this.pending.subarray(12); this.phase = 'security'; this.send(Buffer.from([1, 1])); continue; }
      if (this.phase === 'security') { if (this.pending[0] !== 1) throw new Error('Invalid RDP viewer security selection.'); this.pending = this.pending.subarray(1); this.phase = 'init'; this.send(Buffer.alloc(4)); continue; }
      if (this.phase === 'init') {
        this.pending = this.pending.subarray(1); this.phase = 'ready'; const name = Buffer.from('Termora RDP'); const init = Buffer.alloc(24 + name.length); init.writeUInt16BE(this.width, 0); init.writeUInt16BE(this.height, 2); init[4] = 32; init[5] = 24; init[7] = 1; for (const offset of [8, 10, 12]) init.writeUInt16BE(255, offset); init[14] = 16; init[15] = 8; init.writeUInt32BE(name.length, 20); name.copy(init, 24); this.send(init); continue;
      }
      const type = this.pending[0]; let length;
      if (type === 0) length = 20;
      else if (type === 2) { if (this.pending.length < 4) return; length = 4 + this.pending.readUInt16BE(2) * 4; }
      else if (type === 3) length = 10;
      else if (type === 4) length = 8;
      else if (type === 5) length = 6;
      else if (type === 6) { if (this.pending.length < 8) return; const size = this.pending.readInt32BE(4); if (size < 0 || size > 1024 * 1024 - 8) throw new Error('Unsupported RDP clipboard message.'); length = 8 + size; }
      else throw new Error('Unsupported RDP viewer message.');
      if (this.pending.length < length) return;
      const value = this.pending.subarray(0, length); this.pending = this.pending.subarray(length);
      if (type === 0) {
        if (value[4] !== 32 || !value[7] || [8, 10, 12].some(offset => value.readUInt16BE(offset) !== 255) || ![value[14], value[15], value[16]].every(shift => [0, 8, 16].includes(shift)) || new Set([value[14], value[15], value[16]]).size !== 3) throw new Error('Unsupported RDP pixel format.');
        this.format = { big: Boolean(value[6]), red: value[14], green: value[15], blue: value[16] };
      } else if (type === 2) { this.resizeEncoding = false; for (let offset = 4; offset < length; offset += 4) if (value.readInt32BE(offset) === -223) this.resizeEncoding = true; }
      else if (type === 3) { this.requested = true; if (!value[1]) { this.dirty = true;this.dirtyRect={x:0,y:0,w:this.width,h:this.height}; } this.paint(); }
      else if (type === 4) this.input?.('K', Buffer.concat([value.subarray(1, 2), value.subarray(4, 8)]));
      else if (type === 5) this.input?.('M', value.subarray(1));
      // Clipboard text is accepted only through the explicit Termora Paste RPC.
      // Ignore viewer clipboard messages; never share the OS clipboard automatically.
    }
  }
  paste(text) { if (!this.clipboardAllowed) throw new Error('Clipboard paste is disabled for this RDP session.'); const data=Buffer.from(String(text),'utf8'); if(data.length>1024*1024 || data.includes(0)) throw new Error('Clipboard text is too large or contains a null character.'); this.input?.('T',data); }
  paint() {
    if (this.phase !== 'ready' || !this.requested || !this.dirty || !this.pixels) return;
    const {x,y,w,h}=this.dirtyRect||{x:0,y:0,w:this.width,h:this.height};
    const out = Buffer.alloc(16 + w*h*4); out.writeUInt16BE(1, 2);out.writeUInt16BE(x,4);out.writeUInt16BE(y,6);out.writeUInt16BE(w, 8); out.writeUInt16BE(h, 10);
    const { big, red, green, blue } = this.format;
    for(let row=0;row<h;row++){
      const source=((y+row)*this.width+x)*4,target=16+row*w*4;
      if (!big && red === 16 && green === 8 && blue === 0) this.pixels.copy(out,target,source,source+w*4);
      else for(let column=0;column<w;column++){const offset=source+column*4;const value=((this.pixels[offset+2]<<red)|(this.pixels[offset+1]<<green)|(this.pixels[offset]<<blue))>>>0;if(big)out.writeUInt32BE(value,target+column*4);else out.writeUInt32LE(value,target+column*4);}
    }
    this.requested = false; this.dirty = false; this.dirtyRect=null; this.send(out);
  }
}
module.exports = { EmbeddedRdp, PacketReader, packet, secretPacket, certificateDetails };
