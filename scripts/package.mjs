import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ensureElectron } from './ensure-electron.mjs';
await import('./build.mjs');
await ensureElectron();
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This portable build targets Windows x64.');
const require = createRequire(import.meta.url);
const root = process.cwd();
const out = path.join(root, 'release', 'Termora-win32-x64');
const appDir = path.join(out, 'resources', 'app');
const electronDir = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
await mkdir(out, { recursive: true });
const runtimeVersion = require(path.join(path.dirname(require.resolve('electron/package.json')), 'package.json')).version;
const previousVersion = existsSync(path.join(out, 'version')) ? (await readFile(path.join(out, 'version'), 'utf8')).trim().replace(/^v/, '') : '';
if (previousVersion !== runtimeVersion || !existsSync(path.join(out, 'Termora.exe'))) {
  await cp(electronDir, out, { recursive: true, filter: source => path.basename(source) !== 'electron.exe' });
  await cp(path.join(electronDir, 'electron.exe'), path.join(out, 'Termora.exe'));
}
await mkdir(appDir, { recursive: true });
for (const dir of ['dist', 'electron', 'lib', 'extensions']) {
  if (existsSync(dir)) await cp(dir, path.join(appDir, dir), { recursive: true });
}
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
delete manifest.devDependencies;
delete manifest.scripts;
await writeFile(path.join(appDir, 'package.json'), JSON.stringify(manifest, null, 2));
const npmCLI = process.env.npm_execpath;
if (!npmCLI) throw new Error('Run packaging with npm run package to resolve production dependencies.');
const listed = spawnSync(process.execPath, [npmCLI, 'ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (listed.status !== 0) throw new Error(listed.stderr || 'Cannot resolve production dependencies.');
const copied = [];
async function digest(file) {
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function changed(source,destination) {
  const sourceStat=await stat(source);
  if(sourceStat.isDirectory()||!existsSync(destination))return true;
  const destinationStat=await stat(destination);
  if(sourceStat.size!==destinationStat.size)return true;
  const [sourceHash,destinationHash]=await Promise.all([digest(source),digest(destination)]);
  // Reuse identical native bindings; Windows may have them loaded in an open app.
  return sourceHash!==destinationHash;
}
for (const directory of listed.stdout.trim().split(/\r?\n/).slice(1)) {
  const relative = path.relative(root, directory);
  if (!relative.startsWith('node_modules' + path.sep) || relative.includes('..')) throw new Error('Dependency outside project root.');
  if (copied.some(parent => directory.startsWith(parent + path.sep))) continue;
  await cp(directory, path.join(appDir, relative), { recursive: true, filter: changed });
  copied.push(directory);
}
await mkdir(path.join(out, 'data'), { recursive: true });
for (const file of ['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  if (existsSync(file)) await cp(file, path.join(out, file));
}
if (existsSync('docs')) await cp('docs', path.join(out, 'docs'), { recursive: true });
await writeFile(path.join(out, 'PORTABLE.txt'), 'Run Termora.exe. Settings stay in the adjacent data folder.\r\nIndependent implementation; see source docs/features.md for verified coverage and remaining work.\r\n');
console.log(`Portable application: ${out}`);
