const { TerminalManager } = require('../lib/terminals.cjs');
const manager = new TerminalManager({ emit: (channel, data) => console.log(channel, JSON.stringify(data)), verifyHost: async () => true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  for (const shell of ['powershell', 'cmd']) {
    const terminal = await manager.open({ type: 'local', shell, cols: 100, rows: 30 });
    console.log('OPEN', terminal, 'PTY PID', manager.session(terminal.id).pty.pid);
    manager.write({ id: terminal.id, data: shell === 'powershell' ? "Write-Output ('TERMORA_' + 'IMMEDIATE_OK')\r" : 'echo TERMORA_IMMEDIATE_OK\r' });
    await delay(5000);
    manager.write({ id: terminal.id, data: shell === 'powershell' ? "Write-Output ('TERMORA_' + 'DELAYED_OK')\r" : 'echo TERMORA_DELAYED_OK\r' });
    await delay(5000);
    manager.close(terminal.id);
  }
})().catch(error => { console.error(error); process.exitCode = 1; manager.closeAll(); });
