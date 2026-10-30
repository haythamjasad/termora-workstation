// AES-128-OCB3 (RFC 7253) with a 128-bit tag and 96-bit nonce, as used by Mosh.
// Electron's BoringSSL has no OCB mode, so it is built here on AES-ECB.
const crypto = require('node:crypto');

const ZERO = Buffer.alloc(16);
const xor = (a, b) => { const out = Buffer.alloc(16); for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i]; return out; };
function double(block) {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 15; i++) out[i] = ((block[i] << 1) | (block[i + 1] >> 7)) & 0xff;
  out[15] = ((block[15] << 1) & 0xff) ^ (block[0] & 0x80 ? 0x87 : 0);
  return out;
}
const ntz = n => { let count = 0; while (!(n & 1)) { n >>>= 1; count++; } return count; };

class OCB {
  constructor(key) {
    if (key.length !== 16) throw new Error('OCB needs a 16-byte AES-128 key.');
    this.key = Buffer.from(key);
    this.lStar = this.encipher(ZERO);
    this.lDollar = double(this.lStar);
    this.l = [double(this.lDollar)];
  }
  ecb(decrypt, data) {
    const cipher = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)('aes-128-ecb', this.key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }
  encipher(block) { return this.ecb(false, block); }
  L(i) { while (this.l.length <= i) this.l.push(double(this.l[this.l.length - 1])); return this.l[i]; }
  initialOffset(nonce) {
    if (nonce.length !== 12) throw new Error('OCB nonce must be 12 bytes.');
    const full = Buffer.concat([Buffer.from([0, 0, 0, 1]), nonce]);
    const bottom = full[15] & 0x3f;
    const top = Buffer.from(full); top[15] &= 0xc0;
    const kTop = this.encipher(top);
    const stretch = Buffer.concat([kTop, Buffer.alloc(8)]);
    for (let i = 0; i < 8; i++) stretch[16 + i] = kTop[i] ^ kTop[i + 1];
    const offset = Buffer.alloc(16), byteShift = bottom >> 3, bitShift = bottom & 7;
    for (let i = 0; i < 16; i++) offset[i] = ((stretch[i + byteShift] << bitShift) | (bitShift ? stretch[i + byteShift + 1] >> (8 - bitShift) : 0)) & 0xff;
    return offset;
  }
  hash(aad) {
    let sum = Buffer.alloc(16), offset = Buffer.alloc(16);
    const full = Math.floor(aad.length / 16);
    for (let i = 1; i <= full; i++) { offset = xor(offset, this.L(ntz(i))); sum = xor(sum, this.encipher(xor(aad.subarray((i - 1) * 16, i * 16), offset))); }
    if (aad.length % 16) {
      offset = xor(offset, this.lStar);
      const padded = Buffer.alloc(16); aad.copy(padded, 0, full * 16); padded[aad.length - full * 16] = 0x80;
      sum = xor(sum, this.encipher(xor(padded, offset)));
    }
    return sum;
  }
  // Shared core: full blocks are processed in one ECB call.
  crypt(decrypt, nonce, input, aad) {
    const full = Math.floor(input.length / 16), offsets = [];
    let offset = this.initialOffset(nonce);
    for (let i = 1; i <= full; i++) { offset = xor(offset, this.L(ntz(i))); offsets.push(offset); }
    const masked = Buffer.alloc(full * 16);
    for (let i = 0; i < full; i++) for (let j = 0; j < 16; j++) masked[i * 16 + j] = input[i * 16 + j] ^ offsets[i][j];
    const processed = full ? this.ecb(decrypt, masked) : Buffer.alloc(0);
    const output = Buffer.alloc(input.length);
    let checksum = Buffer.alloc(16);
    for (let i = 0; i < full; i++) {
      for (let j = 0; j < 16; j++) output[i * 16 + j] = processed[i * 16 + j] ^ offsets[i][j];
      checksum = xor(checksum, (decrypt ? output : input).subarray(i * 16, i * 16 + 16));
    }
    const rest = input.length - full * 16;
    if (rest) {
      offset = xor(offset, this.lStar);
      const pad = this.encipher(offset);
      for (let j = 0; j < rest; j++) output[full * 16 + j] = input[full * 16 + j] ^ pad[j];
      const padded = Buffer.alloc(16); (decrypt ? output : input).copy(padded, 0, full * 16); padded[rest] = 0x80;
      checksum = xor(checksum, padded);
    }
    const tag = xor(this.encipher(xor(xor(checksum, offset), this.lDollar)), this.hash(aad));
    return { output, tag };
  }
  encrypt(nonce, plaintext, aad = Buffer.alloc(0)) { const { output, tag } = this.crypt(false, nonce, plaintext, aad); return Buffer.concat([output, tag]); }
  decrypt(nonce, data, aad = Buffer.alloc(0)) {
    if (data.length < 16) throw new Error('Ciphertext is too short.');
    const { output, tag } = this.crypt(true, nonce, data.subarray(0, data.length - 16), aad);
    if (!crypto.timingSafeEqual(tag, data.subarray(data.length - 16))) throw new Error('Packet failed authentication.');
    return output;
  }
}

module.exports = { OCB };
