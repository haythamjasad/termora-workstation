// Single-file SCP (rcp protocol) transfers over an existing ssh2 client. This is
// the classic `scp -t` / `scp -f` exchange, independent of the SFTP subsystem.
const fs = require('node:fs');
const path = require('node:path');

const MAX_HEADER = 4096;
function quote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function exec(client, command) { return new Promise((resolve, reject) => client.exec(command, (error, channel) => error ? reject(error) : resolve(channel))); }

// Buffers channel data so the protocol can read acknowledgements, header lines
// and exact payload byte counts regardless of how packets are split.
class ChannelReader {
  constructor(channel) {
    this.channel = channel; this.buffer = Buffer.alloc(0); this.waiters = []; this.ended = false; this.stderr = '';
    channel.on('data', data => { this.buffer = Buffer.concat([this.buffer, data]); this.flush(); });
    channel.stderr?.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-2000); });
    channel.on('close', () => { this.ended = true; this.flush(); });
  }
  flush() { while (this.waiters.length && this.waiters[0]()) this.waiters.shift(); }
  wait(test) { return new Promise((resolve, reject) => { this.waiters.push(() => { let result; try { result = test(); } catch (error) { reject(error); return true; } if (result !== undefined) { resolve(result); return true; } if (this.ended) { reject(new Error(this.stderr.trim() || 'SCP connection closed unexpectedly.')); return true; } return false; }); this.flush(); }); }
  take(length) { const chunk = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length); return chunk; }
  async ack() {
    const code = (await this.wait(() => this.buffer.length ? this.take(1)[0] : undefined));
    if (code === 0) return;
    const text = await this.line();
    throw new Error(`SCP: ${text || 'remote error'}`);
  }
  line() {
    return this.wait(() => {
      const end = this.buffer.indexOf(10);
      if (end < 0) { if (this.buffer.length > MAX_HEADER) throw new Error('SCP header is too long.'); return undefined; }
      return this.take(end + 1).subarray(0, end).toString('utf8');
    });
  }
  bytes(length, onChunk) {
    let remaining = length;
    return this.wait(() => {
      while (remaining > 0 && this.buffer.length) { const chunk = this.take(Math.min(remaining, this.buffer.length)); remaining -= chunk.length; onChunk(chunk); }
      return remaining === 0 ? true : undefined;
    });
  }
}

function writeAll(channel, data) { return new Promise(resolve => { if (channel.write(data)) resolve(); else channel.once('drain', resolve); }); }

async function scpUpload(client, localPath, remotePath, { mode = 0o644 } = {}) {
  const stat = await fs.promises.stat(localPath);
  if (!stat.isFile()) throw new Error('SCP uploads a single file.');
  const channel = await exec(client, `scp -t -- ${quote(remotePath)}`);
  const reader = new ChannelReader(channel);
  try {
    await reader.ack();
    const name = path.posix.basename(remotePath.replace(/\\/g, '/')) || path.basename(localPath);
    if (/[\n/]/.test(name)) throw new Error('Invalid SCP file name.');
    channel.write(`C${(mode & 0o7777).toString(8).padStart(4, '0')} ${stat.size} ${name}\n`);
    await reader.ack();
    for await (const chunk of fs.createReadStream(localPath)) await writeAll(channel, chunk);
    channel.write(Buffer.from([0]));
    await reader.ack();
  } finally { channel.end(); }
  return { ok: true, path: remotePath, bytes: stat.size };
}

async function scpDownload(client, remotePath, localPath) {
  const channel = await exec(client, `scp -f -- ${quote(remotePath)}`);
  const reader = new ChannelReader(channel);
  const output = fs.createWriteStream(localPath, { flags: 'wx' });
  let size = 0, completed = false;
  try {
    channel.write(Buffer.from([0]));
    let header = await reader.wait(() => reader.buffer.length ? reader.take(1)[0] : undefined);
    if (header === 1 || header === 2) throw new Error(`SCP: ${await reader.line()}`);
    let line = String.fromCharCode(header) + await reader.line();
    if (line.startsWith('T')) { channel.write(Buffer.from([0])); header = await reader.wait(() => reader.buffer.length ? reader.take(1)[0] : undefined); line = String.fromCharCode(header) + await reader.line(); }
    const match = /^C([0-7]{4}) (\d+) (.+)$/.exec(line);
    if (!match) throw new Error(line.startsWith('D') ? 'SCP downloads a single file, not a directory.' : 'Unexpected SCP response.');
    size = Number(match[2]);
    channel.write(Buffer.from([0]));
    await reader.bytes(size, chunk => output.write(chunk));
    await reader.ack();
    channel.write(Buffer.from([0]));
    completed = true;
  } finally {
    channel.end();
    await new Promise(resolve => output.end(resolve));
    if (!completed) await fs.promises.unlink(localPath).catch(() => {});
  }
  return { ok: true, path: localPath, bytes: size };
}

module.exports = { scpUpload, scpDownload, quote };
