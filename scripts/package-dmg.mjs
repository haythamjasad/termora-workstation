// Builds release/Termora-darwin-x64.dmg from the macOS zip produced by package-mac.mjs,
// then reads the image back and compares every file, mode and symlink with the source.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildHfsVolume, buildUdif } from './dmg.mjs';
import { readUdif, readHfs } from './dmg-reader.mjs';
await import('./package-mac.mjs');
const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const root = process.cwd();
const zipPath = path.join(root, 'release', 'Termora-darwin-x64.zip'), dmgPath = path.join(root, 'release', 'Termora-darwin-x64.dmg');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));

const entries = [];
const zip = await new Promise((resolve, reject) => yauzl.open(zipPath, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
await new Promise((resolve, reject) => {
  zip.on('error', reject); zip.on('end', resolve);
  zip.on('entry', entry => {
    const mode = entry.externalFileAttributes >>> 16, name = entry.fileName;
    if (!name.startsWith('Termora.app/') && !['LICENSE', 'THIRD-PARTY-NOTICES.md'].includes(name)) { zip.readEntry(); return; }
    if (name.endsWith('/')) { entries.push({ path: name, type: 'dir', mode: mode & 0o7777 }); zip.readEntry(); return; }
    zip.openReadStream(entry, (error, stream) => {
      if (error) { reject(error); return; }
      const chunks = []; stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => { entries.push({ path: name, type: (mode & 0o170000) === 0o120000 ? 'symlink' : 'file', mode: mode & 0o7777, data: Buffer.concat(chunks) }); zip.readEntry(); });
    });
  });
  zip.readEntry();
});
entries.push({ path: 'Applications', type: 'symlink', mode: 0o755, data: Buffer.from('/Applications') });
entries.push({ path: 'Read Me First.txt', type: 'file', mode: 0o644, data: Buffer.from(`Termora ${manifest.version} for macOS (Intel), unsigned test build

Install
  1. Drag Termora onto the Applications folder in this window.
  2. This development bundle needs local signing. Open Terminal and run:
       codesign --force --deep --sign - /Applications/Termora.app
     Then open Termora from Applications.
  3. Open System Settings > Privacy & Security, scroll down and click "Open Anyway"
     next to the Termora message, then confirm. This is needed once.
  4. Allow Termora to find devices on your local network if you connect to LAN servers.

Requires macOS 13 or later on Intel (x86_64).
Built on Windows; launch on macOS has not been tested.

Settings: ~/Library/Application Support/Termora
Local tabs use your login shell. PowerShell/CMD, WSL and desktop shortcuts are Windows-only.
`) });

const volume = buildHfsVolume(entries, { volumeName: 'Termora' });
const dmg = buildUdif(volume.image, { name: 'Termora' });
await writeFile(dmgPath, dmg);

// Verification: decode the DMG we just wrote and compare with the source entries.
const image = readUdif(await readFile(dmgPath));
if (!image.equals(volume.image)) throw new Error('Decoded image differs from the written volume.');
const read = readHfs(image);
const source = new Map(entries.map(entry => [entry.path.replace(/\/+$/, ''), entry]));
const found = new Map(read.items.map(item => [item.path, item]));
let checked = 0;
for (const [name, entry] of source) {
  const item = found.get(name);
  if (!item) throw new Error(`Missing from DMG: ${name}`);
  if (item.type !== entry.type) throw new Error(`Type differs for ${name}`);
  if (entry.type !== 'dir' && !item.data.equals(entry.data)) throw new Error(`Content differs for ${name}`);
  if ((item.mode & 0o777) !== ((entry.mode & 0o777) || (entry.type === 'dir' ? 0o755 : 0o644))) throw new Error(`Mode differs for ${name}: ${(item.mode & 0o777).toString(8)}`);
  if (entry.type === 'symlink' && item.creator !== 'rhap') throw new Error(`Symlink type missing for ${name}`);
  checked++;
}
if (found.size !== source.size) throw new Error(`DMG has ${found.size} items, source has ${source.size}.`);
console.log(`macOS disk image: ${dmgPath} (${(dmg.length / 1024 / 1024).toFixed(1)} MiB; ${read.signature} volume "${read.volumeName}", ${read.fileCount} files, ${read.folderCount} folders; ${checked} items verified)`);
