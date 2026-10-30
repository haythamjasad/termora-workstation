// Native Mosh client: the State Synchronization Protocol over UDP, encrypted
// with AES-128-OCB. The server sends screen diffs as terminal escape sequences
// that are written straight into the xterm view; the client sends keystrokes
// and window sizes as its own synchronized "user stream".
const dgram = require('node:dgram');
const dns = require('node:dns/promises');
const zlib = require('node:zlib');
const { OCB } = require('./ocb.cjs');

const PROTOCOL_VERSION = 2n;
const MAX_NUM = 0xffffffffffffffffn;
const DIRECTION_TO_CLIENT = 1n << 63n;
const SEQUENCE_MASK = DIRECTION_TO_CLIENT - 1n;
const FRAGMENT_MTU = 1200;
const ACK_DELAY = 50, HEARTBEAT = 3000, MIN_RTO = 50, MAX_RTO = 1000;

// --- minimal protobuf (proto2 varint and length-delimited fields) ---
function varint(value) {
  let v = BigInt(value); if (v < 0n) v &= MAX_NUM;
  const out = [];
  do { let byte = Number(v & 0x7fn); v >>= 7n; if (v) byte |= 0x80; out.push(byte); } while (v);
  return Buffer.from(out);
}
const fieldKey = (field, type) => varint((field << 3) | type);
const pbVarint = (field, value) => Buffer.concat([fieldKey(field, 0), varint(value)]);
const pbBytes = (field, bytes) => { const data = Buffer.from(bytes); return Buffer.concat([fieldKey(field, 2), varint(data.length), data]); };
function readVarint(buffer, index) {
  let result = 0n, shift = 0n;
  for (;;) {
    if (index >= buffer.length) throw new Error('Truncated protobuf varint.');
    const byte = buffer[index++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, index];
    shift += 7n; if (shift > 70n) throw new Error('Protobuf varint is too long.');
  }
}
function decode(buffer) {
  const fields = new Map();
  for (let index = 0; index < buffer.length;) {
    let tag; [tag, index] = readVarint(buffer, index);
    const field = Number(tag >> 3n), type = Number(tag & 7n);
    let value;
    if (type === 0) [value, index] = readVarint(buffer, index);
    else if (type === 2) { let size; [size, index] = readVarint(buffer, index); size = Number(size); if (index + size > buffer.length) throw new Error('Truncated protobuf field.'); value = buffer.subarray(index, index + size); index += size; }
    else if (type === 1) { value = buffer.subarray(index, index + 8); index += 8; }
    else if (type === 5) { value = buffer.subarray(index, index + 4); index += 4; }
    else throw new Error('Unsupported protobuf wire type.');
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push(value);
  }
  return fields;
}
const first = (fields, field, fallback) => fields.get(field)?.[0] ?? fallback;

// TransportBuffers.Instruction
function encodeInstruction({ oldNum, newNum, ackNum, throwawayNum, diff = Buffer.alloc(0) }) {
  return Buffer.concat([pbVarint(1, PROTOCOL_VERSION), pbVarint(2, oldNum), pbVarint(3, newNum), pbVarint(4, ackNum), pbVarint(5, throwawayNum), pbBytes(6, diff)]);
}
function decodeInstruction(buffer) {
  const fields = decode(buffer);
  return { protocolVersion: first(fields, 1, 0n), oldNum: first(fields, 2, 0n), newNum: first(fields, 3, 0n), ackNum: first(fields, 4, 0n), throwawayNum: first(fields, 5, 0n), diff: first(fields, 6, Buffer.alloc(0)) };
}

// ClientBuffers.UserMessage: consecutive keystrokes share one instruction.
function encodeUserDiff(events) {
  const parts = [];
  let keys = [];
  const flush = () => { if (keys.length) { parts.push(pbBytes(1, pbBytes(2, pbBytes(4, Buffer.concat(keys))))); keys = []; } };
  for (const event of events) {
    if (event.type === 'keys') keys.push(event.data);
    else { flush(); parts.push(pbBytes(1, pbBytes(3, Buffer.concat([pbVarint(5, event.cols), pbVarint(6, event.rows)])))); }
  }
  flush();
  return Buffer.concat(parts);
}
function decodeUserDiff(buffer) {
  const events = [];
  for (const instruction of decode(buffer).get(1) || []) {
    const fields = decode(instruction);
    for (const keystroke of fields.get(2) || []) events.push({ type: 'keys', data: Buffer.from(first(decode(keystroke), 4, Buffer.alloc(0))) });
    for (const resize of fields.get(3) || []) { const size = decode(resize); events.push({ type: 'resize', cols: Number(first(size, 5, 80n)), rows: Number(first(size, 6, 24n)) }); }
  }
  return events;
}
// HostBuffers.HostMessage
function encodeHostDiff(items) {
  return Buffer.concat(items.map(item => pbBytes(1, item.type === 'bytes' ? pbBytes(2, pbBytes(4, item.data)) : item.type === 'resize' ? pbBytes(3, Buffer.concat([pbVarint(5, item.cols), pbVarint(6, item.rows)])) : pbBytes(7, pbVarint(8, item.echoAck)))));
}
function decodeHostDiff(buffer) {
  const items = [];
  for (const instruction of decode(buffer).get(1) || []) {
    const fields = decode(instruction);
    for (const bytes of fields.get(2) || []) items.push({ type: 'bytes', data: Buffer.from(first(decode(bytes), 4, Buffer.alloc(0))) });
    for (const resize of fields.get(3) || []) { const size = decode(resize); items.push({ type: 'resize', cols: Number(first(size, 5, 80n)), rows: Number(first(size, 6, 24n)) }); }
    for (const echo of fields.get(7) || []) items.push({ type: 'echoAck', echoAck: first(decode(echo), 8, 0n) });
  }
  return items;
}

// Transport fragments: id (u64), fragment number (u16, high bit = final), zlib data.
function fragment(instruction, id, mtu = FRAGMENT_MTU) {
  const compressed = zlib.deflateSync(instruction), chunks = [];
  for (let offset = 0; offset === 0 || offset < compressed.length; offset += mtu) chunks.push(compressed.subarray(offset, offset + mtu));
  return chunks.map((chunk, index) => { const head = Buffer.alloc(10); head.writeBigUInt64BE(BigInt(id)); head.writeUInt16BE(index | (index === chunks.length - 1 ? 0x8000 : 0), 8); return Buffer.concat([head, chunk]); });
}
class Assembler {
  constructor() { this.id = -1n; this.parts = []; this.total = -1; }
  add(payload) {
    if (payload.length < 10) throw new Error('Mosh fragment is too short.');
    const id = payload.readBigUInt64BE(0), word = payload.readUInt16BE(8), index = word & 0x7fff, final = Boolean(word & 0x8000);
    if (id !== this.id) { if (id < this.id) return null; this.id = id; this.parts = []; this.total = -1; }
    this.parts[index] = payload.subarray(10);
    if (final) this.total = index + 1;
    if (this.total < 0 || this.parts.length < this.total) return null;
    for (let i = 0; i < this.total; i++) if (!this.parts[i]) return null;
    const assembled = Buffer.concat(this.parts.slice(0, this.total));
    this.parts = []; this.total = -1; this.id += 1n;
    return zlib.inflateSync(assembled, { maxOutputLength: 16 * 1024 * 1024 });
  }
}

// Datagram: 8-byte nonce tail (direction bit + sequence) then OCB ciphertext of
// [timestamp u16][timestamp reply u16][fragment].
class Connection {
  constructor(key, toClient) { this.ocb = new OCB(key); this.toClient = toClient; this.seq = 0n; this.savedTimestamp = -1; this.savedAt = 0; this.srtt = 1000; this.rttvar = 500; this.gotRtt = false; this.lastHeard = 0; }
  static now16() { return Date.now() & 0xffff; }
  seal(payload) {
    const tail = Buffer.alloc(8); tail.writeBigUInt64BE((this.toClient ? DIRECTION_TO_CLIENT : 0n) | (this.seq++ & SEQUENCE_MASK));
    let reply = 0xffff;
    if (this.savedTimestamp >= 0 && Date.now() - this.savedAt < 1000) { reply = (this.savedTimestamp + Date.now() - this.savedAt) & 0xffff; this.savedTimestamp = -1; }
    const head = Buffer.alloc(4); head.writeUInt16BE(Connection.now16(), 0); head.writeUInt16BE(reply, 2);
    return Buffer.concat([tail, this.ocb.encrypt(Buffer.concat([Buffer.alloc(4), tail]), Buffer.concat([head, payload]))]);
  }
  open(datagram) {
    if (datagram.length < 8 + 16 + 4) throw new Error('Datagram is too short.');
    const tail = datagram.subarray(0, 8), value = tail.readBigUInt64BE(0);
    if (Boolean(value & DIRECTION_TO_CLIENT) === this.toClient) throw new Error('Datagram travels in the wrong direction.');
    const plain = this.ocb.decrypt(Buffer.concat([Buffer.alloc(4), tail]), datagram.subarray(8));
    const timestamp = plain.readUInt16BE(0), reply = plain.readUInt16BE(2);
    this.savedTimestamp = timestamp; this.savedAt = Date.now(); this.lastHeard = Date.now();
    if (reply !== 0xffff) {
      const rtt = (Connection.now16() - reply) & 0xffff;
      if (rtt < 5000) {
        if (!this.gotRtt) { this.srtt = rtt; this.rttvar = rtt / 2; this.gotRtt = true; }
        else { this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - rtt); this.srtt = 0.875 * this.srtt + 0.125 * rtt; }
      }
    }
    return { seq: value & SEQUENCE_MASK, payload: plain.subarray(4) };
  }
  rto() { return Math.min(MAX_RTO, Math.max(MIN_RTO, Math.ceil(this.srtt + 4 * this.rttvar))); }
}

class MoshClient {
  constructor({ host, port, key, cols = 80, rows = 24, onData = () => {}, onExit = () => {} }) {
    const secret = Buffer.from(String(key).replace(/=+$/, '') + '==', 'base64');
    if (secret.length !== 16) throw new Error('The Mosh session key is invalid.');
    Object.assign(this, { host, port, onData, onExit });
    this.connection = new Connection(secret, false);
    this.assembler = new Assembler();
    this.events = [{ type: 'resize', cols, rows }];
    this.sent = [{ num: 0n, count: 0 }];   // our states; sent[0] is acknowledged by the server
    this.remoteNum = 0n;                     // newest server state applied to the screen
    this.fragmentId = 0n; this.lastSend = 0; this.ackPending = true; this.closed = false; this.shutdown = null;
  }
  async start() {
    const { address, family } = await dns.lookup(this.host);
    this.address = address;
    this.socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    this.socket.on('message', (message, remote) => { if (remote.address === address && remote.port === this.port) this.receive(message); });
    this.socket.on('error', () => {});
    await new Promise((resolve, reject) => { this.socket.once('error', reject); this.socket.bind(0, () => { this.socket.off('error', reject); resolve(); }); });
    this.timer = setInterval(() => this.tick(), 20); this.timer.unref?.();
    this.flush();
  }
  current() {
    const last = this.sent[this.sent.length - 1];
    if (this.events.length > last.count) this.sent.push({ num: last.num + 1n, count: this.events.length });
    return this.sent[this.sent.length - 1];
  }
  write(text) { if (this.closed || this.shutdown) return; this.events.push({ type: 'keys', data: Buffer.from(text, 'utf8') }); this.scheduleSoon(); }
  resize(cols, rows) { if (this.closed || this.shutdown) return; this.events.push({ type: 'resize', cols, rows }); this.scheduleSoon(); }
  scheduleSoon() { if (!this.soon) this.soon = setTimeout(() => { this.soon = null; this.flush(); }, 3); }
  // Sends everything the server has not acknowledged yet, diffed from its acknowledged state.
  flush() {
    if (this.closed || !this.socket) return;
    const base = this.sent[0], target = this.current();
    const instruction = encodeInstruction({ oldNum: base.num, newNum: this.shutdown ? MAX_NUM : target.num, ackNum: this.remoteNum, throwawayNum: base.num, diff: encodeUserDiff(this.events.slice(base.count, target.count)) });
    for (const piece of fragment(instruction, this.fragmentId++)) this.socket.send(this.connection.seal(piece), this.port, this.address);
    this.lastSend = Date.now(); this.ackPending = false;
  }
  tick() {
    const now = Date.now(), unacked = this.sent.length > 1 || this.shutdown;
    if (this.ackPending && now - this.lastSend >= ACK_DELAY) this.flush();
    else if (unacked && now - this.lastSend >= this.connection.rto()) this.flush();
    else if (now - this.lastSend >= HEARTBEAT) this.flush();
    if (this.shutdown && now - this.shutdown > 2000) this.finish(0);
  }
  receive(datagram) {
    let instruction;
    try {
      const { payload } = this.connection.open(datagram);
      const assembled = this.assembler.add(payload);
      if (!assembled) return;
      instruction = decodeInstruction(assembled);
    } catch { return; } // forged, corrupt or stale datagrams are dropped
    if (instruction.protocolVersion !== PROTOCOL_VERSION) { this.finish(1, 'The Mosh server uses an incompatible protocol version.'); return; }
    if (this.shutdown && instruction.ackNum === MAX_NUM) { this.finish(0); return; }
    const index = this.sent.findIndex(state => state.num === instruction.ackNum);
    if (index > 0) this.sent.splice(0, index);
    if (instruction.newNum === MAX_NUM) { this.remoteNum = MAX_NUM; this.flush(); this.finish(0); return; } // server session ended
    if (instruction.newNum <= this.remoteNum) { this.ackPending = true; return; }
    if (instruction.oldNum !== this.remoteNum) return; // diff from a state we never showed; the server will resend
    for (const item of decodeHostDiff(instruction.diff)) if (item.type === 'bytes' && item.data.length) this.onData(item.data.toString('utf8'));
    this.remoteNum = instruction.newNum; this.ackPending = true;
  }
  // Asks the server to end the session so no orphaned mosh-server remains.
  close() { if (this.closed || this.shutdown) return; this.shutdown = Date.now(); this.flush(); }
  finish(code, error) {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); clearTimeout(this.soon);
    try { this.socket?.close(); } catch {}
    this.onExit(code, error);
  }
}

const MOSH_CONNECT = /MOSH CONNECT (\d{1,5}) ([A-Za-z0-9/+]{22})/;

module.exports = { MoshClient, Connection, Assembler, fragment, encodeInstruction, decodeInstruction, encodeUserDiff, decodeUserDiff, encodeHostDiff, decodeHostDiff, decode, varint, MAX_NUM, MOSH_CONNECT };
