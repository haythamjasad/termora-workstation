'use strict';

// Self-signed ECDSA P-256 certificate for the local FTPS server, built with
// node:crypto and a small DER encoder so no extra dependency is needed.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function length(n) {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  while (n) { bytes.unshift(n & 255); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag, ...parts) {
  const body = Buffer.concat(parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)));
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}
const sequence = (...parts) => der(0x30, ...parts);
function oid(value) {
  const [first, second, ...rest] = value.split('.').map(Number);
  const out = [40 * first + second];
  for (const number of rest) {
    const encoded = [number & 127];
    for (let x = number >> 7; x; x >>= 7) encoded.unshift((x & 127) | 128);
    out.push(...encoded);
  }
  return der(0x06, Buffer.from(out));
}
function integer(buffer) { return der(0x02, buffer[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buffer]) : buffer); }
function utcTime(date) { return der(0x17, date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'); }
function pem(label, buffer) { return `-----BEGIN ${label}-----\n${buffer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`; }

function createCertificate({ commonName = 'Termora local server', hostnames = ['localhost'], addresses = ['127.0.0.1'], days = 3650 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const algorithm = sequence(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = sequence(der(0x31, sequence(oid('2.5.4.3'), der(0x0c, commonName))));
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const now = Date.now();
  const alternative = sequence(
    ...hostnames.map(host => der(0x82, host)),
    ...addresses.map(address => der(0x87, Buffer.from(address.split('.').map(Number)))),
  );
  const extensions = der(0xa3, sequence(sequence(oid('2.5.29.17'), der(0x04, alternative))));
  const tbs = sequence(der(0xa0, integer(Buffer.from([2]))), integer(serial), algorithm, name,
    sequence(utcTime(new Date(now - 86400000)), utcTime(new Date(now + days * 86400000))), name,
    publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return { cert: pem('CERTIFICATE', certificate), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// Reuses the certificate saved in the data directory so clients can pin it.
function loadOrCreateCertificate(directory) {
  const certFile = directory && path.join(directory, 'ftps-cert.pem'), keyFile = directory && path.join(directory, 'ftps-key.pem');
  if (directory) {
    try { return { cert: fs.readFileSync(certFile, 'utf8'), key: fs.readFileSync(keyFile, 'utf8') }; } catch {}
  }
  const created = createCertificate({ hostnames: ['localhost', os.hostname().toLowerCase()].filter((host, index, all) => /^[a-z0-9.-]+$/.test(host) && all.indexOf(host) === index) });
  if (directory) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(keyFile, created.key, { mode: 0o600 });
    fs.writeFileSync(certFile, created.cert, { mode: 0o644 });
  }
  return created;
}

module.exports = { createCertificate, loadOrCreateCertificate };
