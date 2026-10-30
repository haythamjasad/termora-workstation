'use strict';

// iperf3-compatible TCP server (normal and reverse mode). The control and data
// connections share one port; data streams identify themselves by the cookie.
const net = require('node:net');
const crypto = require('node:crypto');

const COOKIE_SIZE = 37;
const STATE = { TEST_START: 1, TEST_RUNNING: 2, TEST_END: 4, PARAM_EXCHANGE: 9, CREATE_STREAMS: 10, EXCHANGE_RESULTS: 13, DISPLAY_RESULTS: 14, IPERF_DONE: 16, ACCESS_DENIED: -1, SERVER_ERROR: -2 };
const MAX_SECONDS = 3600;

class Reader {
  constructor(socket) {
    this.socket = socket; this.chunks = []; this.length = 0; this.waiter = null; this.closed = false;
    this.onData = data => { this.chunks.push(data); this.length += data.length; this.pump(); };
    this.onClose = () => { this.closed = true; this.pump(); };
    socket.on('data', this.onData); socket.on('close', this.onClose);
  }
  read(size) { return new Promise((resolve, reject) => { this.waiter = { size, resolve, reject }; this.pump(); }); }
  pump() {
    const waiter = this.waiter;
    if (!waiter) return;
    if (this.length >= waiter.size) {
      const all = Buffer.concat(this.chunks);
      this.chunks = [all.subarray(waiter.size)]; this.length -= waiter.size; this.waiter = null;
      waiter.resolve(all.subarray(0, waiter.size));
    } else if (this.closed) { this.waiter = null; waiter.reject(new Error('Connection closed')); }
  }
  // Hands the socket back, returning any bytes already buffered.
  detach() { this.socket.off('data', this.onData); this.socket.off('close', this.onClose); return Buffer.concat(this.chunks); }
}

const state = value => Buffer.from([value & 0xff]);
function jsonMessage(value) { const body = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(4); head.writeUInt32BE(body.length); return Buffer.concat([head, body]); }
async function readJson(reader) {
  const size = (await reader.read(4)).readUInt32BE(0);
  if (size > 65536) throw new Error('Control message too large');
  return JSON.parse((await reader.read(size)).toString('utf8'));
}
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out')), ms); })]).finally(() => clearTimeout(timer));
}

function createIperfServer(service, { onResult } = {}) {
  let active = null;
  const track = socket => { service.sockets.add(socket); socket.on('close', () => service.sockets.delete(socket)); socket.on('error', () => socket.destroy()); };

  async function runTest(control, reader, cookie) {
    const test = { cookie, control, streams: [], accepting: false, done: false, waiting: null };
    active = test;
    try {
      control.write(state(STATE.PARAM_EXCHANGE));
      const params = await withTimeout(readJson(reader), 10000);
      if (params.udp || params.sctp || params.bidirectional || params.authtoken) {
        // Only plain TCP tests are implemented; tell the client the server failed.
        control.write(Buffer.concat([state(STATE.SERVER_ERROR), Buffer.alloc(8)])); return;
      }
      const parallel = Math.max(1, Math.min(128, Number(params.parallel) || 1));
      const length = Math.max(1, Math.min(1024 * 1024, Number(params.len) || 128 * 1024));
      const reverse = Boolean(params.reverse);
      const connected = new Promise(resolve => { test.waiting = resolve; });
      test.expected = parallel; test.accepting = true;
      control.write(state(STATE.CREATE_STREAMS));
      await withTimeout(connected, 10000);
      test.accepting = false;
      const started = process.hrtime.bigint();
      control.write(state(STATE.TEST_START));
      control.write(state(STATE.TEST_RUNNING));
      if (reverse) {
        const block = crypto.randomBytes(length);
        for (const stream of test.streams) {
          const pump = () => { while (!test.done && !stream.socket.destroyed) { stream.bytes += block.length; if (!stream.socket.write(block)) { stream.socket.once('drain', pump); return; } } };
          pump();
        }
      }
      const limit = Math.min(MAX_SECONDS, (Number(params.time) || 10) + (Number(params.omit) || 0) + 30) * 1000;
      let end;
      do { end = (await withTimeout(reader.read(1), limit)).readInt8(0); } while (end !== STATE.TEST_END && end >= 0);
      if (end !== STATE.TEST_END) return;
      test.done = true;
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      control.write(state(STATE.EXCHANGE_RESULTS));
      const clientResults = await withTimeout(readJson(reader), 10000);
      control.write(jsonMessage({
        cpu_util_total: 0, cpu_util_user: 0, cpu_util_system: 0, sender_has_retransmits: reverse ? 0 : -1,
        streams: test.streams.map(stream => ({ id: stream.id, bytes: stream.bytes, retransmits: reverse ? 0 : -1, jitter: 0, errors: 0, omitted_errors: 0, packets: 0, omitted_packets: 0, start_time: 0, end_time: seconds })),
      }));
      control.write(state(STATE.DISPLAY_RESULTS));
      await withTimeout(reader.read(1), 10000).catch(() => {});
      const bytes = test.streams.reduce((sum, stream) => sum + stream.bytes, 0);
      onResult?.({ peer: control.remoteAddress, reverse, streams: test.streams.length, bytes, seconds, bitsPerSecond: seconds ? bytes * 8 / seconds : 0, clientBytes: (clientResults.streams || []).reduce((sum, stream) => sum + (Number(stream.bytes) || 0), 0) });
    } catch { /* client vanished or misbehaved */ }
    finally {
      test.done = true;
      for (const stream of test.streams) stream.socket.destroy();
      control.end();
      if (active === test) active = null;
    }
  }

  const server = net.createServer(socket => {
    track(socket);
    socket.setNoDelay(true);
    const reader = new Reader(socket);
    withTimeout(reader.read(COOKIE_SIZE), 10000).then(raw => {
      const cookie = raw.toString('latin1');
      if (active && active.accepting && cookie === active.cookie && active.streams.length < active.expected) {
        // A data stream for the running test. iperf3 numbers streams 1, 3, 4, ...
        const test = active, leftover = reader.detach();
        const stream = { id: test.streams.length ? test.streams.length + 2 : 1, socket, bytes: leftover.length };
        test.streams.push(stream);
        socket.on('data', data => { if (!test.done) stream.bytes += data.length; });
        socket.on('error', () => {});
        if (test.streams.length >= test.expected) test.waiting();
        return;
      }
      if (active) { socket.end(state(STATE.ACCESS_DENIED)); return; }
      runTest(socket, reader, cookie);
    }, () => socket.destroy());
  });
  server.maxConnections = 160;
  return server;
}

module.exports = { createIperfServer, STATE, COOKIE_SIZE };
