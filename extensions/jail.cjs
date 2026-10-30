'use strict';

// Path confinement shared by every file-serving service. Requested paths are
// virtual ("/a/b"), always resolved inside the chosen root directory.
const fsp = require('node:fs').promises;
const path = require('node:path');

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i;

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function denied(message = 'Path is outside the selected root') {
  return Object.assign(new Error(message), { code: 'EACCES' });
}

function segments(requested) {
  if (typeof requested !== 'string' || requested.length > 8192 || /[\x00-\x1f]/.test(requested)) throw denied('Invalid path');
  // Windows drive/ADS/UNC paths must never be interpreted relative to another root.
  const parts = requested.replace(/\\/g, '/').split('/');
  if (parts.some(part => part === '..' || part.includes(':'))) throw denied();
  return parts.filter(part => part && part !== '.');
}

// An existing file or directory inside root, after following symbolic links.
async function safePath(root, requested) {
  const candidate = path.resolve(root, ...segments(requested));
  if (!contained(root, candidate)) throw denied();
  const canonical = await fsp.realpath(candidate);
  if (!contained(root, canonical)) throw denied('A symbolic link leaves the selected root');
  return canonical;
}

// A path that may not exist yet (upload, mkdir, rename target). Its parent
// must exist inside root and the new name must be a plain Windows-safe name.
async function safeTarget(root, requested) {
  const parts = segments(requested);
  const name = parts.pop();
  if (!name) throw denied('Choose a file name');
  if (RESERVED.test(name) || /[<>"|?*]/.test(name) || /[. ]$/.test(name) || name.length > 255) throw denied('Invalid file name');
  const parent = await safePath(root, parts.join('/'));
  const candidate = path.join(parent, name);
  try {
    const canonical = await fsp.realpath(candidate);
    if (!contained(root, canonical)) throw denied('A symbolic link leaves the selected root');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return candidate;
}

// Normalizes a client path against a virtual working directory.
function virtual(cwd, requested) {
  const value = String(requested ?? '').replace(/\\/g, '/');
  return path.posix.resolve(cwd || '/', value || '.');
}

module.exports = { contained, denied, safePath, safeTarget, virtual };
