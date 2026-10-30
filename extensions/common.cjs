'use strict';

// Login checks and shell launching shared by the SSH, Telnet and FTP servers.
const crypto = require('node:crypto');
const path = require('node:path');

const MAX_FAILURES = 5;
const LOCKOUT_MS = 60000;

function createLogin({ username, password } = {}) {
  if (typeof username !== 'string' || !/^[\w.@-]{1,64}$/.test(username)) throw new Error('Choose a username of letters, digits, dot, dash, underscore or @');
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw new Error('Choose a password of at least 8 characters');
  const salt = crypto.randomBytes(16);
  const digest = value => crypto.createHmac('sha256', salt).update(String(value)).digest();
  const expectedUser = digest(username), expectedPassword = digest(password);
  const failures = new Map(); // remote address -> { count, until }
  return {
    username,
    blocked(address) { return (failures.get(address)?.until || 0) > Date.now(); },
    // Constant-time comparison; repeated failures from one address lock it out for a minute.
    check(user, pass, address = '') {
      if (this.blocked(address)) return false;
      const userOk = crypto.timingSafeEqual(digest(user), expectedUser), passOk = crypto.timingSafeEqual(digest(pass), expectedPassword);
      if (userOk && passOk) { failures.delete(address); return true; }
      const record = { count: (failures.get(address)?.count || 0) + 1, until: 0 };
      if (record.count >= MAX_FAILURES) { record.count = 0; record.until = Date.now() + LOCKOUT_MS; }
      if (failures.size > 4096) failures.clear();
      failures.set(address, record);
      return false;
    },
  };
}

function shellEnvironment() {
  const env = { ...process.env, TERM: 'xterm-256color' };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (['psmodulepath', 'psmoduleanalysiscachepath'].includes(key.toLowerCase())) delete env[key];
  return env;
}

function shellCommand(kind) {
  if (process.platform !== 'win32') { const file = process.env.SHELL || '/bin/sh'; return { file, args: ['-l'], exec: command => [file, ['-c', command]] }; }
  if (kind === 'cmd') { const file = process.env.ComSpec || 'cmd.exe'; return { file, args: [], exec: command => [file, ['/d', '/s', '/c', command]] }; }
  const file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return { file, args: ['-NoLogo'], exec: command => [file, ['-NoLogo', '-NoProfile', '-Command', command]] };
}

function spawnShell(kind, { cols = 80, rows = 24, cwd } = {}) {
  const pty = require('@lydell/node-pty');
  const { file, args } = shellCommand(kind);
  return pty.spawn(file, args, { name: 'xterm-256color', cols: Math.max(10, Math.min(500, cols | 0 || 80)), rows: Math.max(2, Math.min(300, rows | 0 || 24)), cwd, env: shellEnvironment(), useConpty: true });
}

const plainAddress = address => String(address || '').replace(/^::ffff:/, '');

module.exports = { createLogin, shellCommand, shellEnvironment, spawnShell, plainAddress };
