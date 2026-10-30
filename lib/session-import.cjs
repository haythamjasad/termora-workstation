const crypto = require('node:crypto');
const { importMobaIni, sanitizeSessions } = require('./state.cjs');
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
function readText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}
function encodedEnvelope(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8').replace(/^\uFEFF/, '').trim() : String(bytes).replace(/^\uFEFF/, '').trim();
  if (!text.startsWith('_@')) return null;
  const nonce = text.slice(2, 20), payload = text.slice(20).replace(/\s/g, '');
  if (nonce.length !== 18 || !/^[A-Za-z0-9+/]{18}$/.test(nonce) || !payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error('The encrypted MobaXterm backup is incomplete or malformed.');
  const ciphertext = Buffer.from(payload, 'base64');
  if (ciphertext.toString('base64') !== payload) throw new Error('The encrypted MobaXterm backup has invalid Base64 data.');
  return { iv: Buffer.from(nonce.slice(0, 16), 'ascii'), ciphertext };
}
function passwordBytes(password) {
  const utf8 = Buffer.from(password, 'utf8');
  const cp1252 = new Map(), decoder = new TextDecoder('windows-1252');
  for (let n=0;n<256;n++) cp1252.set(decoder.decode(Uint8Array.of(n)), n);
  if ([...password].every(char => cp1252.has(char))) {
    const ansi = Buffer.from([...password].map(char => cp1252.get(char)));
    if (!ansi.equals(utf8)) return [ansi, utf8];
    ansi.fill(0);
  }
  return [utf8];
}
function decryptCFB8(ciphertext, key, iv) {
  // Electron's BoringSSL omits the named CFB8 cipher. Build the standard
  // feedback mode over its AES ECB primitive, one encrypted IV per byte.
  const aes = crypto.createCipheriv('aes-256-ecb', key, null);
  aes.setAutoPadding(false);
  const feedback = Buffer.from(iv), output = Buffer.alloc(ciphertext.length);
  try {
    for (let index=0;index<ciphertext.length;index++) {
      const block = aes.update(feedback);
      output[index] = ciphertext[index] ^ block[0];
      block.fill(0);
      feedback.copyWithin(0,1);
      feedback[15] = ciphertext[index];
    }
    aes.final();
    return output;
  } catch (error) { output.fill(0); throw error; }
  finally { feedback.fill(0); }
}
function unlockMobaConfig(envelope, password) {
  if (typeof password !== 'string' || !password || password.length > 4096) throw new Error('Enter the password used for this MobaXterm export.');
  const encodings = passwordBytes(password);
  try {
    for (const bytes of encodings) {
      const digest = crypto.createHash('sha512').update(bytes).digest();
      let plain;
      try {
        plain = decryptCFB8(envelope.ciphertext, digest.subarray(0,32), envelope.iv);
        const text = readText(plain);
        // CFB is unauthenticated: admit only structured full-config text with
        // the marker checked by the original importer, never arbitrary output.
        if (!plain.includes(0) && /^\[ImportExportSpecials\]\s*$/mi.test(text) && !/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return text;
      } finally { digest.fill(0); plain?.fill(0); }
    }
  } finally { for (const bytes of encodings) bytes.fill(0); }
  throw new Error('Could not unlock this backup. Check its export/master password. An unsupported encrypted variant or damaged file can also cause this error.');
}
function parseSessionImport(bytes, { password } = {}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.length || bytes.length > MAX_IMPORT_BYTES) throw new Error('Choose a non-empty session file up to 10 MiB.');
  const envelope = encodedEnvelope(bytes);
  if (envelope && password === undefined) return { needsPassword: true, format: 'mobaconf-encrypted' };
  const source = envelope ? unlockMobaConfig(envelope,password) : readText(bytes).replace(/^\uFEFF/,'');
  if (/^\s*(?:\{|\[\s*(?:\{|\]))/.test(source)) {
    let value;
    try { value = JSON.parse(source); } catch { throw new Error('The session JSON file is not valid.'); }
    return { sessions: sanitizeSessions(Array.isArray(value) ? value : value.sessions), warnings: [], format: 'termora-json' };
  }
  if (!/^\[Bookmarks(?:_\d+)?\]\s*$/mi.test(source)) throw new Error('No MobaXterm bookmark sections were found. Export sessions or include sessions in the configuration backup.');
  const parsed = importMobaIni(source);
  if (!parsed.sessions.length) throw new Error('No supported sessions were found in this MobaXterm file. No existing sessions were changed.');
  return { ...parsed, format: envelope ? 'mobaconf-encrypted' : 'moba-ini', warnings: ['Imported supported session definitions only. Saved passwords, application settings, macros and tunnels were not imported.', ...parsed.warnings] };
}
module.exports = { MAX_IMPORT_BYTES, parseSessionImport, encodedEnvelope, unlockMobaConfig, readText };
