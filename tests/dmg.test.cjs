'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = file => import(pathToFileURL(path.join(__dirname, '..', 'scripts', file)).href);

test('DMG writer round-trips files, modes, symlinks and a multi-level catalog', async () => {
  const { buildHfsVolume, buildUdif } = await load('dmg.mjs');
  const { readUdif, readHfs } = await load('dmg-reader.mjs');
  const entries = [
    { path: 'App.app/', type: 'dir', mode: 0o755 },
    { path: 'App.app/Contents/MacOS/App', type: 'file', mode: 0o755, data: crypto.randomBytes(10000) },
    { path: 'App.app/Contents/Frameworks/X.framework/Versions/Current', type: 'symlink', mode: 0o755, data: Buffer.from('A') },
    { path: 'App.app/Contents/Resources/empty.txt', type: 'file', mode: 0o644, data: Buffer.alloc(0) },
    { path: 'Applications', type: 'symlink', mode: 0o755, data: Buffer.from('/Applications') },
  ];
  // Enough names to need several leaf nodes and an index level.
  for (let i = 0; i < 400; i++) entries.push({ path: `App.app/Contents/Resources/many/file-with-a-longer-name-${String(i).padStart(4, '0')}.txt`, type: 'file', mode: 0o644, data: Buffer.from(`content ${i}`) });
  const volume = buildHfsVolume(entries, { volumeName: 'Test' });
  const image = readUdif(buildUdif(volume.image, { name: 'Test' }));
  assert.ok(image.equals(volume.image));
  const read = readHfs(image);
  assert.equal(read.signature, 'HX'); assert.equal(read.compare, 0xbc); assert.equal(read.volumeName, 'Test');
  const byPath = new Map(read.items.map(item => [item.path, item]));
  for (const entry of entries) {
    const item = byPath.get(entry.path.replace(/\/$/, ''));
    assert.ok(item, entry.path); assert.equal(item.type, entry.type);
    if (entry.type !== 'dir') assert.ok(item.data.equals(entry.data), entry.path);
    assert.equal(item.mode & 0o777, entry.mode);
  }
  assert.equal(byPath.get('Applications').creator, 'rhap');
  assert.ok(byPath.has('App.app/Contents/Frameworks/X.framework/Versions'), 'intermediate folders are created');
  assert.equal(read.fileCount, 404);
});
