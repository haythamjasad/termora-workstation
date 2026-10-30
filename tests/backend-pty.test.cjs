const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalManager } = require('../lib/terminals.cjs');

for (const shell of ['powershell', 'cmd']) {
  test(`real Windows ${shell} terminal accepts an immediate command and closes cleanly`, { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    let output = '', terminal;
    const exits = [], expected = `TERMORA_${shell.toUpperCase()}_PTY_OK`;
    let resolveOutput;
    const received = new Promise(resolve => { resolveOutput = resolve; });
    const manager = new TerminalManager({ verifyHost: async () => false, emit: (channel, event) => {
      if (channel === 'terminal:data') { output += event.data; if (output.includes(expected)) resolveOutput(); }
      if (channel === 'terminal:exit') exits.push(event);
    } });
    t.after(() => manager.closeAll());
    terminal = await manager.open({ type: 'local', shell, cols: 100, rows: 30 });
    const command = shell === 'powershell' ? `Write-Output ('TERMORA_' + '${shell.toUpperCase()}_PTY_OK')\r` : 'echo TERMORA_%ComSpec:~-7,3%_PTY_OK\r';
    // cmd's marker is constructed from a command variable so an input echo
    // cannot satisfy the output assertion by itself.
    manager.write({ id: terminal.id, data: shell === 'cmd' ? 'set "TERMORA_TEST_MARKER=TERMORA_"\recho %TERMORA_TEST_MARKER%CMD_PTY_OK\r' : command });
    const timer = setTimeout(() => resolveOutput(), 12000);
    await received; clearTimeout(timer);
    assert.ok(output.includes(expected), `No command result received. Output: ${output.slice(-3000)}`);
    manager.close(terminal.id);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(exits.filter(event => event.id === terminal.id).length, 1);
    assert.equal(manager.sessions.size, 0);
  });
}
