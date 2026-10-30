'use strict';
// Test Mosh server: speaks the SSP transport from the server side, echoes the
// user's keystrokes as screen diffs, records resizes and supports simulated loss.
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { Connection, Assembler, fragment, encodeInstruction, decodeInstruction, decodeUserDiff, encodeHostDiff, MAX_NUM } = require('../../lib/mosh.cjs');

function createMoshServer({ welcome = 'Welcome to the test Mosh server\r\n$ ' } = {}) {
  const key = crypto.randomBytes(16);
  const record = { keys: '', sizes: [], shutdown: false, received: 0, dropFromClient: 0, dropToClient: 0, staleDiffs: 0 };
  const socket = dgram.createSocket('udp4');
  const connection = new Connection(key, true), assembler = new Assembler();
  let remote = null, fragmentId = 0n;
  const clientStates = new Map([[0n, []]]); let clientNum = 0n;
  // Host states: each has a number and the output it added.
  const hostStates = [{ num: 0n, data: '' }];
  let hostAcked = 0n, hostNum = 0n;
  const addOutput = text => { hostNum += 1n; hostStates.push({ num: hostNum, data: text }); };
  const send = (newNum = hostNum) => {
    if (!remote) return;
    if (record.dropToClient > 0) { record.dropToClient--; return; }
    const pending = hostStates.filter(state => state.num > hostAcked).map(state => state.data).join('');
    const instruction = encodeInstruction({ oldNum: hostAcked, newNum, ackNum: clientNum, throwawayNum: hostAcked, diff: pending ? encodeHostDiff([{ type: 'bytes', data: Buffer.from(pending) }]) : Buffer.alloc(0) });
    for (const piece of fragment(instruction, fragmentId++, 64)) socket.send(connection.seal(piece), remote.port, remote.address);
  };
  socket.on('message', (message, from) => {
    let instruction;
    try { const { payload } = connection.open(message); const assembled = assembler.add(payload); if (!assembled) return; instruction = decodeInstruction(assembled); }
    catch { return; }
    if (record.dropFromClient > 0) { record.dropFromClient--; return; }
    record.received++;
    const first = !remote; remote = from;
    if (hostStates.some(state => state.num === instruction.ackNum)) { hostAcked = instruction.ackNum; while (hostStates.length > 1 && hostStates[0].num < hostAcked) hostStates.shift(); }
    if (instruction.newNum === MAX_NUM) { record.shutdown = true; clientNum = MAX_NUM; send(hostNum); return; }
    if (instruction.newNum > clientNum) {
      const base = clientStates.get(instruction.oldNum);
      if (base) {
        const events = base.concat(decodeUserDiff(instruction.diff)), previous = clientStates.get(clientNum);
        for (const event of events.slice(previous.length)) {
          if (event.type === 'keys') { record.keys += event.data.toString(); addOutput(event.data.toString()); }
          else record.sizes.push([event.cols, event.rows]);
        }
        clientStates.set(instruction.newNum, events); clientNum = instruction.newNum;
      } else record.staleDiffs++;
    }
    if (first) addOutput(welcome);
    send();
  });
  return {
    socket, record, key: key.toString('base64').replace(/=+$/, ''),
    listen: () => new Promise(resolve => socket.bind(0, '127.0.0.1', () => resolve(socket.address().port))),
    // The remote shell exited: tell the client the session is over.
    endSession: () => send(MAX_NUM),
    output: text => { addOutput(text); send(); },
    close: () => { try { socket.close(); } catch {} },
  };
}

module.exports = { createMoshServer };
