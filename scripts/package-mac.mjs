// Builds release/Termora-darwin-x64.zip (an Intel macOS Termora.app) on any host.
// The official Electron macOS zip is copied entry by entry without extracting it,
// so Unix permissions and the framework symlinks survive a Windows build machine.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { readFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
await import('./build.mjs');
const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const root = process.cwd();
const electronManifest = require('electron/package.json');
const electronDir = path.dirname(require.resolve('electron/package.json'));
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const ptyVersion = manifest.dependencies['@lydell/node-pty'];
const cache = path.join(root, 'release', '.cache');
await mkdir(cache, { recursive: true });

// 1. Electron for macOS x64, verified against the checksums shipped with the electron package.
const { downloadArtifact } = await import('@electron/get');
const electronZip = await downloadArtifact({ version: electronManifest.version, artifactName: 'electron', platform: 'darwin', arch: 'x64', checksums: require(path.join(electronDir, 'checksums.json')) });

// 2. The macOS x64 build of node-pty (npm verifies the registry integrity hash).
const ptyPackage = `@lydell/node-pty-darwin-x64@${ptyVersion}`;
const ptyTarball = path.join(cache, `lydell-node-pty-darwin-x64-${ptyVersion}.tgz`);
if (!existsSync(ptyTarball)) {
  const npmCLI = process.env.npm_execpath;
  if (!npmCLI) throw new Error('Run with npm run package:mac.');
  const packed = spawnSync(process.execPath, [npmCLI, 'pack', ptyPackage, '--pack-destination', cache], { cwd: cache, encoding: 'utf8', windowsHide: true });
  if (packed.status !== 0) throw new Error(packed.stderr || `npm pack ${ptyPackage} failed`);
}

// --- zip writer (store/deflate, Unix modes, symlinks) ---
const output = path.join(root, 'release', 'Termora-darwin-x64.zip');
await rm(output, { force: true });
const stream = createWriteStream(output);
const central = [];
let offset = 0;
const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
function write(buffer) { offset += buffer.length; return new Promise((resolve, reject) => stream.write(buffer, error => error ? reject(error) : resolve())); }
async function addRaw({ name, method, crc, compressed, size, mode }) {
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc >>> 0, 14);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(nameBytes.length, 26);
  central.push({ nameBytes, method, crc, compressedSize: compressed.length, size, mode, offset });
  await write(local); await write(nameBytes); await write(compressed);
}
async function addData(name, data, mode = 0o100644) {
  const crc = zlib.crc32(data);
  const deflated = data.length > 64 ? zlib.deflateRawSync(data, { level: 6 }) : null;
  const useDeflate = deflated && deflated.length < data.length;
  await addRaw({ name, method: useDeflate ? 8 : 0, crc, compressed: useDeflate ? deflated : data, size: data.length, mode });
}
const addDirectory = name => addRaw({ name: name.endsWith('/') ? name : name + '/', method: 0, crc: 0, compressed: Buffer.alloc(0), size: 0, mode: 0o40755 });
async function finish() {
  if (central.length > 0xffff || offset > 0xffffffff) throw new Error('Archive needs ZIP64, which this writer does not produce.');
  const start = offset;
  for (const entry of central) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | 20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(entry.method, 10); record.writeUInt16LE(dosTime, 12); record.writeUInt16LE(dosDate, 14); record.writeUInt32LE(entry.crc >>> 0, 16);
    record.writeUInt32LE(entry.compressedSize, 20); record.writeUInt32LE(entry.size, 24); record.writeUInt16LE(entry.nameBytes.length, 28);
    record.writeUInt32LE(((entry.mode << 16) | ((entry.mode & 0o170000) === 0o040000 ? 0x10 : 0)) >>> 0, 38); record.writeUInt32LE(entry.offset, 42);
    await write(record); await write(entry.nameBytes);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
  await write(end);
  await new Promise(resolve => stream.end(resolve));
}

// 3. Electron.app -> Termora.app, with Termora's name, identifier and network usage text.
function patchInfoPlist(text) {
  const set = (key, value) => { const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`); text = pattern.test(text) ? text.replace(pattern, `$1${value}$2`) : text.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n\t<string>${value}</string>\n</dict>\n</plist>\n`); };
  set('CFBundleDisplayName', 'Termora'); set('CFBundleName', 'Termora'); set('CFBundleIdentifier', 'org.termora.workstation');
  set('CFBundleShortVersionString', manifest.version); set('CFBundleVersion', manifest.version);
  set('NSLocalNetworkUsageDescription', 'Termora connects to SSH, VNC, FTP and other servers on your local network.');
  return text;
}
const readEntry = (zip, entry, raw) => new Promise((resolve, reject) => zip.openReadStream(entry, raw ? { decompress: false } : {}, (error, readStream) => {
  if (error) { reject(error); return; }
  const chunks = []; readStream.on('data', chunk => chunks.push(chunk)); readStream.on('end', () => resolve(Buffer.concat(chunks))); readStream.on('error', reject);
}));
const zip = await new Promise((resolve, reject) => yauzl.open(electronZip, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
let copied = 0;
await new Promise((resolve, reject) => {
  zip.on('error', reject); zip.on('end', resolve);
  zip.on('entry', async entry => {
    try {
      const name = entry.fileName;
      if (name.startsWith('Electron.app/') && name !== 'Electron.app/Contents/Resources/default_app.asar') {
        const target = 'Termora.app/' + name.slice('Electron.app/'.length);
        const mode = (entry.externalFileAttributes >>> 16) || (name.endsWith('/') ? 0o40755 : 0o100644);
        if (name.endsWith('/')) await addDirectory(target);
        else if (name === 'Electron.app/Contents/Info.plist') await addData(target, Buffer.from(patchInfoPlist((await readEntry(zip, entry, false)).toString('utf8'))), mode);
        else { const compressed = entry.compressionMethod === 8; await addRaw({ name: target, method: entry.compressionMethod, crc: entry.crc32, compressed: await readEntry(zip, entry, compressed), size: entry.uncompressedSize, mode }); }
        copied++;
      }
      zip.readEntry();
    } catch (error) { reject(error); }
  });
  zip.readEntry();
});
if (!copied) throw new Error('The Electron macOS archive did not contain Electron.app.');

// 4. Termora's code and production dependencies under Contents/Resources/app.
const appPrefix = 'Termora.app/Contents/Resources/app/';
async function addTree(source, prefix) {
  for (const item of await readdir(source, { withFileTypes: true })) {
    const full = path.join(source, item.name), name = prefix + item.name;
    if (item.isDirectory()) { await addDirectory(name); await addTree(full, name + '/'); }
    else if (item.isFile()) await addData(name, await readFile(full));
  }
}
await addDirectory(appPrefix);
for (const directory of ['dist', 'electron', 'lib', 'extensions']) { await addDirectory(appPrefix + directory); await addTree(path.join(root, directory), `${appPrefix}${directory}/`); }
const appManifest = { ...manifest }; delete appManifest.devDependencies; delete appManifest.scripts;
await addData(appPrefix + 'package.json', Buffer.from(JSON.stringify(appManifest, null, 2)));
const listed = spawnSync(process.execPath, [process.env.npm_execpath, 'ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (listed.status !== 0) throw new Error(listed.stderr || 'Cannot resolve production dependencies.');
const packages = [], folders = new Set();
for (const directory of listed.stdout.trim().split(/\r?\n/).slice(1)) {
  const relative = path.relative(root, directory);
  if (!relative.startsWith('node_modules' + path.sep) || relative.includes('..')) throw new Error('Dependency outside project root.');
  // Nested packages are copied with their parent package's tree.
  if (/node-pty-win32-/.test(relative) || packages.some(parent => relative.startsWith(parent + path.sep))) continue;
  const parts = relative.split(path.sep);
  for (let i = 1; i < parts.length; i++) { const dir = parts.slice(0, i).join('/'); if (!folders.has(dir)) { folders.add(dir); await addDirectory(appPrefix + dir); } }
  packages.push(relative); await addDirectory(appPrefix + parts.join('/')); await addTree(directory, `${appPrefix}${parts.join('/')}/`);
}
if (!folders.has('node_modules/@lydell')) { folders.add('node_modules/@lydell'); await addDirectory(appPrefix + 'node_modules/@lydell'); }
// node-pty's macOS package straight from the npm tarball, keeping its file modes (spawn-helper must stay executable).
const tar = zlib.gunzipSync(await readFile(ptyTarball));
const ptyPrefix = `${appPrefix}node_modules/@lydell/node-pty-darwin-x64/`;
await addDirectory(ptyPrefix);
const madeDirs = new Set();
for (let position = 0; position + 512 <= tar.length;) {
  const header = tar.subarray(position, position + 512);
  if (header.every(byte => byte === 0)) break;
  const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  const name = (field(345, 155) ? field(345, 155) + '/' : '') + field(0, 100), size = parseInt(field(124, 12).trim() || '0', 8), type = field(156, 1) || '0';
  const mode = parseInt(field(100, 8).trim() || '644', 8) & 0o777;
  const data = tar.subarray(position + 512, position + 512 + size);
  position += 512 + Math.ceil(size / 512) * 512;
  if (type !== '0' || !name.startsWith('package/') || name.includes('..')) continue;
  const relative = name.slice('package/'.length), dirs = relative.split('/').slice(0, -1);
  for (let i = 1; i <= dirs.length; i++) { const dir = dirs.slice(0, i).join('/'); if (!madeDirs.has(dir)) { madeDirs.add(dir); await addDirectory(ptyPrefix + dir); } }
  await addData(ptyPrefix + relative, Buffer.from(data), 0o100000 | (mode & 0o111 ? 0o755 : 0o644));
}

// 5. Mac-side helper: ad-hoc sign the development bundle and build a DMG.
const helper = `#!/bin/bash
# Prepares Termora.app on this Mac and wraps it in Termora-darwin-x64.dmg.
set -euo pipefail
cd "$(dirname "$0")"
APP="$PWD/Termora.app"
echo "Signing locally (ad-hoc) so macOS accepts the modified Electron bundle..."
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP" && echo "Signature OK."
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Termora" -srcfolder "$STAGE" -ov -format UDZO "$PWD/Termora-darwin-x64.dmg"
rm -rf "$STAGE"
echo "Created $PWD/Termora-darwin-x64.dmg"
open "$PWD/Termora-darwin-x64.dmg"
`;
await addData('Make Termora DMG.command', Buffer.from(helper), 0o100755);
await addData('README-macOS.txt', Buffer.from(`Termora ${manifest.version} for macOS (Intel x64), unsigned test build
=====================================================================

Requirements: macOS 13 or later on an Intel Mac (x86_64).
This package was built on Windows; it has not been launch-tested on a Mac.

1. Unzip Termora-darwin-x64.zip (double-click it in Finder).
2. Open Terminal in the unzipped folder and run:

     bash "Make Termora DMG.command"

   This signs the app locally (ad-hoc) and
   creates Termora-darwin-x64.dmg. Drag Termora into Applications from the DMG.

   To skip the DMG and just run the app:
     codesign --force --deep --sign - Termora.app && open Termora.app

3. This build is not notarized. If macOS blocks opening it, use System Settings >
   Privacy & Security > Open Anyway after attempting to open Termora.

4. The first time, macOS may ask to allow Termora to find devices on the local
   network; allow it to reach servers on your LAN.

Settings are stored in ~/Library/Application Support/Termora.

Not available on macOS: PowerShell/CMD (local tabs use your login shell, zsh),
WSL, desktop shortcuts (.lnk), and the VcXsrv X server (XQuartz is used if installed).
RDP opens in Microsoft's "Windows App" if installed; external VNC uses Screen Sharing.
`.replace(/\n/g, '\n')));
for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) await addData(file, await readFile(file));
await finish();
const { size } = await stat(output);
console.log(`macOS package: ${output} (${(size / 1024 / 1024).toFixed(1)} MiB, ${central.length} entries)`);
