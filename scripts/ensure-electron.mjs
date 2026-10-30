import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
export async function ensureElectron() {
  const manifest = require.resolve('electron/package.json');
  const dir = path.dirname(manifest);
  const platformPath = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  if (existsSync(path.join(dir, 'dist', platformPath))) {
    await writeFile(path.join(dir, 'path.txt'), platformPath);
    return;
  }
  const { downloadArtifact } = await import('@electron/get');
  const { default: extract } = await import('extract-zip');
  const zip = await downloadArtifact({ version: require(manifest).version, artifactName: 'electron',
    platform: process.platform, arch: process.arch, checksums: require(path.join(dir, 'checksums.json')) });
  // Portable JS extraction also works on hosts without the native extractor's MSVC runtime.
  await extract(zip, { dir: path.join(dir, 'dist') });
  await writeFile(path.join(dir, 'path.txt'), platformPath);
}
