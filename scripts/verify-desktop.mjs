import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';
import { ensureElectron } from './ensure-electron.mjs';
await import('./build.mjs');
await ensureElectron();
const { default: electron } = await import('electron');
const root = process.cwd();
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'termora-desktop-'));
const screenshots = path.join(root, 'evidence', 'screenshots');
fs.mkdirSync(screenshots, { recursive: true });
const executablePath = process.env.TERMORA_VERIFY_EXECUTABLE || electron;
const packaged = Boolean(process.env.TERMORA_VERIFY_EXECUTABLE);
const env = { ...process.env, TERMORA_DATA_DIR: data, TERMORA_SHORTCUT_DIR: path.join(data, 'shortcuts'), TERMORA_TEST_MODE: process.env.TERMORA_VERIFY_VISIBLE === '0' ? 'hidden' : 'visible' };
fs.mkdirSync(env.TERMORA_SHORTCUT_DIR);
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
const checks = [];
let app;
let activePage;
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
async function launch() {
  app = await _electron.launch({ executablePath, args: packaged ? [] : ['.'], cwd: root, env, timeout: 30000 });
  const page = await app.firstWindow();
  activePage = page;
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#app-version')?.textContent.includes('0.1.0'));
  return page;
}
try {
  let page = await launch();
  const boot = await page.evaluate(() => window.bridge.bootstrap());
  assert.equal(boot.appName, 'Termora');
  assert.equal(boot.sessions.length, 0);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return p.contextIsolation && p.sandbox && !p.nodeIntegration;
  }), true);
  record('Desktop starts with an isolated renderer and empty real workspace');
  await page.screenshot({ path: path.join(screenshots, packaged ? 'portable-home.png' : 'home.png') });
  await page.click('.menu-button[data-menu="terminal"]');
  assert.deepEqual(await page.locator('.classic-menu button').allTextContents(), ['Open new tab','Close current tab','Set tab title','Detach','Save terminal text','Print terminal text','Find in terminal','Find next','Duplicate current tab','Write commands on all terminals','Quit']);
  assert.equal(await page.locator('.classic-menu [role="separator"]').count(),3);
  await page.screenshot({ path: path.join(screenshots, packaged ? 'portable-terminal-menu.png' : 'classic-terminal-menu.png') });
  await page.keyboard.press('Escape');
  await page.click('#new-session');
  assert.equal(await page.locator('.session-choose-message').textContent(), 'Choose a session type...');
  assert.equal(await page.locator('.protocol-option.selected').count(), 0);
  assert.equal(await page.locator('#connect-session').isDisabled(), true);
  await page.screenshot({path:path.join(screenshots,packaged?'portable-session-chooser.png':'session-chooser.png')});
  await page.click('#session-cancel');
  record('New session opens the reference chooser without a preselected protocol');

  const classicMetrics = await page.evaluate(() => ({
    toolbarHeight: getComputedStyle(document.querySelector('.toolbar')).height,
    sidebarWidth: getComputedStyle(document.querySelector('.sidebar-shell')).width,
    menuLabels: [...document.querySelectorAll('.menubar .menu-button')].map(n=>n.textContent),
  }));
  assert.equal(classicMetrics.toolbarHeight, '50px'); // measured runtime height, not the 56px compiled default
  assert.equal(classicMetrics.sidebarWidth, '240px');
  assert.deepEqual(classicMetrics.menuLabels, ['Terminal','Sessions','View','X server','Tools','Games','Settings','Macros','Help']);
  await page.click('.theme-choice[data-theme="light"]');
  await page.waitForFunction(() => document.body.classList.contains('theme-light'));
  await page.screenshot({ path: path.join(screenshots, packaged ? 'portable-light.png' : 'classic-light.png') });
  await page.click('.theme-choice[data-theme="dark"]');
  await page.waitForFunction(() => !document.body.classList.contains('theme-light'));
  await page.fill('#quick-connect', 'qa@127.0.0.1:22022');
  await page.locator('#quick-connect-form').evaluate(form => form.requestSubmit());
  assert.equal(await page.inputValue('#conn-host'), '127.0.0.1');
  assert.equal(await page.inputValue('#conn-username'), 'qa');
  assert.equal(await page.inputValue('#conn-port'), '22022');
  await page.screenshot({ path: path.join(screenshots, packaged ? 'portable-session-settings.png' : 'classic-session-settings.png') });
  assert.equal(await page.locator('.ssh-basic-settings').isVisible(), true);
  assert.equal(await page.locator('#conn-password').isVisible(), false);
  await page.click('[data-session-tab="advanced"]');
  assert.equal(await page.locator('#conn-password').isVisible(), true);
  await page.click('#dialog-close');
  await page.fill('#quick-connect', '');
  record('Classic menus, measured layout, quick-connect and Light/Dark previews work');

  await page.click('#new-session');
  await page.click('[data-protocol="ftp"]');
  await page.fill('#conn-host', 'example.invalid');
  await page.fill('#conn-username', 'fixture');
  await page.click('[data-session-tab="advanced"]');
  await page.check('#conn-secure');
  await page.click('[data-session-tab="bookmark"]');
  await page.fill('#connection-name', 'QA FTPS');
  await page.click('#save-session-only');
  await page.waitForFunction(() => document.querySelector('#session-count')?.textContent === '1');
  assert.equal((await page.evaluate(() => window.bridge.bootstrap())).sessions[0].type, 'ftps');
  await page.getByRole('button', { name: 'Edit QA FTPS', exact: true }).first().click();
  assert.equal(await page.isChecked('#conn-secure'), true);
  await page.click('#delete-session');
  await page.click('#confirm-action');
  await page.waitForFunction(() => document.querySelector('#session-count')?.textContent === '0');
  record('FTP TLS option preserves and restores saved FTPS sessions');

  await page.click('#new-session');
  await page.click('[data-protocol="ssh"]');
  await page.fill('#conn-host', 'example.invalid');
  await page.check('#specify-username');
  await page.fill('#conn-username', 'fixture');
  await page.click('[data-session-tab="bookmark"]');
  await page.fill('#connection-name', 'QA saved connection');
  await page.fill('#connection-group', 'QA lab');
  await page.click('#save-session-only');
  await page.waitForFunction(() => document.querySelector('#session-count')?.textContent === '1');
  assert.equal((await page.evaluate(() => window.bridge.bootstrap())).sessions[0].host, 'example.invalid');
  record('Session creation and grouping persist through the real UI');

  // Saved password: encrypted with DPAPI through safeStorage, never stored or returned in plain text.
  if ((await page.evaluate(() => window.bridge.bootstrap())).vault.available) {
    await page.locator('#sessions-list .session-row', { hasText: 'QA saved connection' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit session' }).click();
    await page.click('[data-session-tab="advanced"]');
    await page.fill('#conn-password', 'TERMORA-VAULT-SECRET');
    await page.check('#conn-savePassword');
    await page.click('[data-session-tab="network"]');
    await page.fill('#conn-gatewayHost', 'jump.invalid');
    await page.click('[data-session-tab="bookmark"]');
    await page.click('#save-session-only');
    await page.waitForFunction(() => !document.querySelector('#app-dialog[open]'));
    const stateFile = fs.readFileSync(path.join(data, 'state.json'), 'utf8');
    const saved = JSON.parse(stateFile);
    const sessionId = saved.sessions.find(session => session.name === 'QA saved connection').id;
    assert.ok(saved.vault[sessionId]?.password, 'vault entry written');
    assert.equal(stateFile.includes('TERMORA-VAULT-SECRET'), false, 'no plaintext password at rest');
    assert.equal(saved.sessions.find(session => session.id === sessionId).gatewayHost, 'jump.invalid');
    const boot = JSON.stringify(await page.evaluate(() => window.bridge.bootstrap()));
    assert.equal(boot.includes('TERMORA-VAULT-SECRET'), false, 'renderer never receives the saved password');
    record('Saved passwords are DPAPI-encrypted at rest and gateway settings persist');
  } else record('Saved passwords skipped: Windows credential encryption unavailable in this environment');

  await page.evaluate(() => {
    window.__termoraOutput = {};
    window.bridge.onTerminalData(({ id, data }) => { window.__termoraOutput[id] = (window.__termoraOutput[id] || '') + data; });
  });
  await page.click('#card-powershell');
  await page.waitForSelector('.terminal-pane[data-terminal-id]');
  const powershellId = await page.locator('.terminal-pane').getAttribute('data-terminal-id');
  await page.evaluate(id => window.bridge.writeTerminal({ id, data: "Write-Output ('TERMORA_' + 'POWERSHELL_OK')\r" }), powershellId);
  await page.waitForFunction(id => window.__termoraOutput[id]?.includes('TERMORA_POWERSHELL_OK'), powershellId);
  record('Real Windows PowerShell ConPTY round-trip');
  await page.click('#terminal-find');
  await page.fill('#find-text','TERMORA_POWERSHELL_OK');
  await page.locator('#find-form').evaluate(form=>form.requestSubmit());
  assert.equal(await page.locator('.dialog-error').textContent(),'');
  await page.fill('#find-text','__TERMORA_ABSENT_TEXT__');
  await page.locator('#find-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.querySelector('.dialog-error')?.textContent==='Text not found.');
  await page.click('#dialog-cancel');
  record('Native Find dialog searches real terminal output and reports missing text');

  await page.click('#new-session');
  await page.click('[data-protocol="local"]');
  await page.selectOption('#conn-shell', 'cmd');
  await page.click('[data-session-tab="bookmark"]');
  await page.fill('#connection-name', 'QA Command Prompt');
  await page.uncheck('#connection-save');
  await page.click('#connect-session');
  await page.waitForFunction(() => document.querySelector('#status-session-count')?.textContent === '2 open sessions');
  const cmdId = await page.locator('.terminal-pane').getAttribute('data-terminal-id');
  assert.notEqual(cmdId, powershellId);
  await page.evaluate(id => window.bridge.writeTerminal({ id, data: 'echo TERMORA_CMD_%COMSPEC%\r' }), cmdId);
  await page.waitForFunction(id => /TERMORA_CMD_.*cmd\.exe/i.test(window.__termoraOutput[id] || ''), cmdId);
  await page.click('#terminal-split');
  assert.equal(await page.locator('#terminal-container .terminal-pane').count(), 2);
  await page.waitForFunction(() => [...document.querySelectorAll('.terminal-pane .xterm-screen')].every(n => n.getBoundingClientRect().width > 100));
  await page.screenshot({ path: path.join(screenshots, packaged ? 'portable-terminals.png' : 'terminals.png') });
  record('Independent CMD/PowerShell tabs render in split panes');

  await page.click('#terminal-broadcast');
  await page.click('#confirm-action');
  assert.equal(await page.locator('#broadcast-banner').isVisible(), true);
  await page.click('#broadcast-stop');
  assert.equal(await page.locator('#broadcast-banner').isVisible(), false);
  record('Broadcast requires opt-in and can be disabled');

  await page.click('#open-macros');
  await page.click('#add-macro');
  await page.fill('#macro-name', 'QA marker');
  await page.fill('#macro-command', 'echo TERMORA_MACRO_OK');
  await page.locator('#macro-form').evaluate(form => form.requestSubmit());
  await page.getByRole('button', { name: 'Run QA marker', exact: true }).click();
  await page.waitForFunction(id => window.__termoraOutput[id]?.includes('TERMORA_MACRO_OK'), cmdId);
  assert.equal(await page.locator('#app-dialog[open]').count(), 0); // Run closes the dialog and plays in the terminal
  record('Saved macro reaches the active real terminal');

  // Record keystrokes with timing, then replay the recorded macro.
  await page.click('[data-menu="macros"]');
  await page.getByRole('menuitem', { name: 'Record new macro' }).click();
  assert.match(await page.locator('#macro-banner-text').textContent(), /Recording macro/);
  // The caret keeps the typed line from matching; only cmd's echo output does.
  await page.keyboard.type('echo TERMORA_REC^ORDED');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForFunction(id => (window.__termoraOutput[id]?.match(/TERMORA_RECORDED/g) || []).length >= 1, cmdId);
  await page.click('#macro-banner-action');
  await page.fill('#prompt-value', 'QA recorded');
  await page.locator('#prompt-form').evaluate(form => form.requestSubmit());
  const recorded = (await page.evaluate(() => window.bridge.bootstrap())).macros.find(macro => macro.name === 'QA recorded');
  assert.ok(recorded.steps.length >= 2 && recorded.steps.some(step => step.delay >= 100), 'recorded macro keeps keystroke timing');
  await page.click('[data-menu="macros"]');
  await page.locator('.classic-menu button.has-submenu', { hasText: 'Saved macros' }).hover();
  await page.getByRole('menuitem', { name: 'QA recorded' }).click();
  await page.waitForFunction(id => (window.__termoraOutput[id]?.match(/TERMORA_RECORDED/g) || []).length >= 2, cmdId);
  await page.waitForFunction(() => !document.querySelector('#macro-banner'));
  record('Macro recording keeps keystroke timing and replays into the terminal');

  // Detach the active tab into its own window, use it there, then reattach.
  const tabsBefore = await page.locator('.terminal-tab').count();
  const childPromise = app.waitForEvent('window');
  await page.click('[data-menu="terminal"]');
  await page.getByRole('menuitem', { name: 'Detach', exact: true }).click();
  const child = await childPromise;
  await child.waitForSelector('#reattach-tab');
  assert.equal(await page.locator('.terminal-tab').count(), tabsBefore - 1);
  await child.evaluate(() => { window.__detachedOutput = ''; window.bridge.onTerminalData(({ data }) => { window.__detachedOutput += data; }); });
  const mainBefore = await page.evaluate(id => (window.__termoraOutput[id] || '').length, cmdId);
  await child.locator('.terminal-host').click();
  await child.keyboard.type('echo TERMORA_DETACHED_OK');
  await child.keyboard.press('Enter');
  await child.waitForFunction(() => window.__detachedOutput.includes('TERMORA_DETACHED_OK'));
  assert.equal(await page.evaluate(id => (window.__termoraOutput[id] || '').length, cmdId), mainBefore, 'detached output is routed only to the detached window');
  await child.click('#reattach-tab');
  await page.waitForFunction(count => document.querySelectorAll('.terminal-tab').length === count, tabsBefore);
  await page.keyboard.type('echo TERMORA_REATTACHED_OK');
  await page.keyboard.press('Enter');
  await page.waitForFunction(id => window.__termoraOutput[id]?.includes('TERMORA_REATTACHED_OK'), cmdId);
  record('Detached tab keeps its live session in a separate window and reattaches');

  const fixture = path.join(data, 'editor-fixture.txt');
  fs.writeFileSync(fixture, 'before edit');
  await page.click('#toggle-files');
  await page.fill('#file-path', data);
  await page.locator('#file-path-form').evaluate(form => form.requestSubmit());
  await page.locator('.file-entry', { hasText: 'editor-fixture.txt' }).dblclick();
  await page.fill('#file-editor', 'after edit — Unicode ✓');
  await page.click('#save-file');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(n => n.textContent.includes('File saved')));
  assert.equal(fs.readFileSync(fixture, 'utf8'), 'after edit — Unicode ✓');
  await page.click('#dialog-cancel');
  record('File browser opens and saves a real UTF-8 file');

  const shared = path.join(data, 'shared');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'hello.txt'), 'TERMORA_HTTP_OK');
  await page.click('#open-servers');
  await page.click('#add-server');
  await page.fill('#server-root', shared);
  await page.fill('#server-port', '0');
  await page.click('#start-server');
  await page.waitForFunction(async () => (await window.bridge.listServers()).length === 1);
  const [httpServer] = await page.evaluate(() => window.bridge.listServers());
  assert.equal(await (await fetch(`http://127.0.0.1:${httpServer.port}/hello.txt`)).text(), 'TERMORA_HTTP_OK');
  await page.click('#dialog-cancel');
  await page.click('#open-tools');
  await page.click('[data-tool="ports"]');
  await page.fill('#tool-host', '127.0.0.1');
  await page.fill('#tool-port', String(httpServer.port));
  await page.click('#run-tool');
  await page.waitForFunction(() => document.querySelector('#tool-output')?.textContent.includes('is open'));
  await page.click('#dialog-cancel');
  await page.click('#open-servers');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.waitForFunction(async () => (await window.bridge.listServers()).length === 0);
  await page.click('#dialog-cancel');
  record('Desktop server controls serve actual files and TCP diagnostics verify the listener');

  await page.click('#open-settings');
  await page.click('[data-config-tab="Display"]');
  await page.selectOption('#settings-theme', 'light');
  await page.click('[data-config-tab="Terminal"]');
  await page.fill('#settings-size', '16');
  await page.locator('#settings-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => document.body.classList.contains('theme-light'));
  assert.equal((await page.evaluate(() => window.bridge.bootstrap())).settings.fontSize, 16);
  record('Theme and font settings apply and persist');

  const exported = path.join(data, 'exported-sessions.json');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exported);
  assert.equal(await page.locator('#toolbar-export').isVisible(), true);
  assert.equal(await page.locator('#toolbar-import').isVisible(), true);
  await page.click('#toolbar-export');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(n => n.textContent.includes('Sessions exported')));
  const exportedSessions = JSON.parse(fs.readFileSync(exported, 'utf8'));
  assert.equal(exportedSessions.sessions[0].host, 'example.invalid');
  assert.doesNotMatch(fs.readFileSync(exported, 'utf8'), /"password"|"passphrase"/);
  record('Session export preserves identity and excludes authentication secrets');

  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, exported);
  await page.click('#toolbar-import');
  await page.waitForFunction(() => document.querySelector('#session-count')?.textContent === '2');
  const imported = await page.evaluate(() => window.bridge.bootstrap());
  assert.equal(imported.sessions.length, 2);
  assert.notEqual(imported.sessions[0].id, imported.sessions[1].id);
  assert.equal(imported.sessions[1].host, 'example.invalid');
  record('Visible toolbar Import/Export perform a real JSON round-trip');

  const encrypted = path.join(root,'tests','fixtures','encrypted-config.mobaconf');
  await app.evaluate(({dialog},filePath)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filePath]});},encrypted);
  await page.click('#toolbar-import');
  await page.waitForSelector('#import-password');
  await page.fill('#import-password','wrong');
  await page.click('#import-unlock');
  await page.waitForFunction(()=>document.querySelector('.dialog-error')?.textContent.includes('Could not unlock'));
  assert.equal((await page.evaluate(()=>window.bridge.bootstrap())).sessions.length,2);
  await page.fill('#import-password','fixture-password');
  await page.click('#import-unlock');
  await page.waitForFunction(()=>document.querySelector('#session-count')?.textContent==='3');
  const unlocked=await page.evaluate(()=>window.bridge.bootstrap());
  assert.equal(unlocked.sessions[2].folder,'Lab');
  assert.doesNotMatch(JSON.stringify(unlocked),/VAULT_SECRET|fixture-password/);
  await page.click('#dialog-cancel');
  await page.click('#toolbar-import');
  await page.waitForSelector('#import-password');
  await page.click('#dialog-cancel');
  assert.equal((await page.evaluate(()=>window.bridge.bootstrap())).sessions.length,3);
  record('Encrypted mobaconf retries, imports session identity and cancels without changes');

  await page.evaluate(async ids => { for (const id of ids) await window.bridge.closeTerminal(id); }, [powershellId, cmdId]);
  await app.close(); app = null;
  page = await launch();
  const restarted = await page.evaluate(() => window.bridge.bootstrap());
  assert.equal(restarted.sessions[0].name, 'QA saved connection');
  assert.equal(restarted.macros[0].name, 'QA marker');
  assert.equal(restarted.settings.theme, 'light');
  record('Desktop restart restores sessions, macros and settings');

  // Phase 2: built-in servers, port scanner, cron, Browser/File sessions and shortcuts.
  await page.evaluate(() => { window.__termoraOutput = {}; window.bridge.onTerminalData(({ id, data }) => { window.__termoraOutput[id] = (window.__termoraOutput[id] || '') + data; }); });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  const served = path.join(data, 'served'); fs.mkdirSync(served); fs.writeFileSync(path.join(served, 'hello.txt'), 'TERMORA_SFTP_OK');
  await page.click('#open-servers');
  await page.click('[data-service="ssh"]'); await page.click('#configure-service');
  await page.fill('#server-root', served); await page.fill('#server-port', '0');
  await page.fill('#server-username', 'qa'); await page.fill('#server-password', 'desktop-pass-1');
  await page.selectOption('#server-shell', 'cmd');
  await page.click('#start-server');
  await page.waitForFunction(async () => (await window.bridge.listServers()).some(server => server.type === 'ssh'));
  const sshServer = (await page.evaluate(() => window.bridge.listServers())).find(server => server.type === 'ssh');
  assert.match(await page.locator('#servers-list').textContent(), /SSH · 127\.0\.0\.1:\d+.*host key SHA256:/);
  await page.click('#dialog-cancel');
  await page.click('#new-session'); await page.click('[data-protocol="ssh"]');
  await page.fill('#conn-host', '127.0.0.1'); await page.fill('#conn-port', String(sshServer.port));
  await page.check('#specify-username'); await page.fill('#conn-username', 'qa');
  await page.click('[data-session-tab="advanced"]'); await page.fill('#conn-password', 'desktop-pass-1');
  await page.click('[data-session-tab="bookmark"]'); await page.uncheck('#connection-save');
  await page.click('#connect-session');
  await page.waitForFunction(() => [...document.querySelectorAll('.file-entry .file-name')].some(node => node.textContent === 'hello.txt'));
  await page.waitForFunction(() => Object.values(window.__termoraOutput).some(text => text.includes('served>')));
  const sshId = await page.evaluate(() => Object.keys(window.__termoraOutput).find(key => window.__termoraOutput[key].includes('served>')));
  await page.evaluate(id => window.bridge.writeTerminal({ id, data: 'echo TERMORA_SSH_SERVER^_OK\r' }), sshId);
  await page.waitForFunction(id => window.__termoraOutput[id]?.includes('TERMORA_SSH_SERVER_OK'), sshId);
  record('Built-in SSH server gives a shell and an SFTP file browser to Termora\'s own client');

  await page.click('#open-tools'); await page.click('[data-tool="scan"]');
  await page.fill('#tool-host', '127.0.0.1'); await page.fill('#tool-ports', `${sshServer.port},1`);
  await page.click('#run-tool');
  await page.waitForFunction(port => document.querySelector('#tool-output')?.textContent.includes(`${port}`) && document.querySelector('#tool-output').textContent.includes('open'), sshServer.port);
  assert.match(await page.locator('#tool-output').textContent(), /Scanned 2 TCP ports/);
  await page.click('#dialog-cancel');
  record('Port scanner finds the built-in server');

  await page.click('#open-servers'); await page.click('[data-service="cron"]'); await page.click('#configure-service');
  await page.click('#add-cron');
  await page.fill('#cron-name', 'QA job'); await page.fill('#cron-schedule', '*/5 * * * *'); await page.fill('#cron-command', 'echo TERMORA_CRON_OK'); await page.selectOption('#cron-shell', 'cmd');
  await page.locator('#cron-form').evaluate(form => form.requestSubmit());
  await page.getByRole('button', { name: 'Run QA job now' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(node => node.textContent.includes('QA job finished with exit code 0')));
  await page.waitForFunction(() => document.querySelector('#cron-list')?.textContent.includes('TERMORA_CRON_OK'));
  await page.click('#toggle-cron');
  await page.waitForFunction(async () => (await window.bridge.listServers()).some(server => server.type === 'cron'));
  assert.equal((await page.evaluate(() => window.bridge.listCronJobs())).jobs[0].schedule, '*/5 * * * *');
  await page.click('#dialog-cancel');
  record('Cron jobs save, run on demand and the scheduler starts');

  const web = await page.evaluate(root => window.bridge.startServer({ type: 'http', root, port: 0 }), served);
  await page.click('#new-session'); await page.click('[data-protocol="browser"]');
  await page.fill('#conn-path', `http://127.0.0.1:${web.port}/hello.txt`);
  await page.click('[data-session-tab="bookmark"]'); await page.fill('#connection-name', 'QA browser');
  await page.click('#connect-session');
  await page.waitForFunction(() => document.querySelector('#app-dialog')?.open !== true);
  const browserWindow = await app.waitForEvent('window', { predicate: candidate => candidate.url().startsWith('http://127.0.0.1') });
  await browserWindow.waitForLoadState();
  assert.match(await browserWindow.textContent('body'), /TERMORA_SFTP_OK/);
  assert.equal(await browserWindow.evaluate(() => typeof window.bridge), 'undefined');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('http://127.0.0.1')).webContents.getLastWebPreferences().sandbox), true);
  await browserWindow.close();
  record('Browser sessions open in a sandboxed window without the application bridge');

  await page.click('#new-session'); await page.click('[data-protocol="file"]');
  await page.fill('#conn-path', served);
  await page.click('[data-session-tab="bookmark"]'); await page.uncheck('#connection-save');
  await page.click('#connect-session');
  await page.waitForFunction(() => document.querySelector('#file-heading-label')?.textContent === 'Local files' && [...document.querySelectorAll('.file-entry .file-name')].some(node => node.textContent === 'hello.txt'));
  assert.equal(await page.inputValue('#file-path'), served);
  record('File sessions open a folder in the file browser');

  // Phase 3: embedded noVNC viewer against a password-protected RFB server.
  const { createVncServer } = createRequire(import.meta.url)('../tests/fixtures/vnc-server.cjs');
  const vnc = createVncServer({ password: 'vnc-pass', width: 320, height: 200, color: [0, 160, 80], name: 'QA desktop' });
  await new Promise(resolve => vnc.server.listen(0, '127.0.0.1', resolve));
  await page.click('#rail-sessions');
  await page.click('#new-session'); await page.click('[data-protocol="vnc"]');
  await page.fill('#conn-host', '127.0.0.1'); await page.fill('#conn-port', String(vnc.server.address().port));
  await page.click('[data-session-tab="advanced"]'); await page.fill('#conn-password', 'vnc-pass');
  await page.click('[data-session-tab="bookmark"]'); await page.uncheck('#connection-save');
  await page.click('#connect-session');
  await page.waitForFunction(() => document.querySelector('.vnc-status')?.textContent.includes('QA desktop'));
  const pixel = await page.evaluate(() => { const canvas = document.querySelector('.vnc-view canvas'); const data = canvas.getContext('2d').getImageData(10, 10, 1, 1).data; return [data[0], data[1], data[2]]; });
  assert.deepEqual(pixel, [0, 160, 80]);
  assert.equal(vnc.record.authenticated, 1);
  const rendererText = await page.evaluate(() => document.documentElement.outerHTML);
  assert.doesNotMatch(rendererText, /vnc-pass/);
  await page.click('.vnc-view canvas', { position: { x: 20, y: 20 } });
  await page.keyboard.press('a');
  await new Promise(resolve => { const started = Date.now(); const tick = () => vnc.record.keys.some(key => key.keysym === 0x61) || Date.now() - started > 5000 ? resolve() : setTimeout(tick, 50); tick(); });
  assert.ok(vnc.record.keys.some(key => key.keysym === 0x61 && key.down), 'key press reached the VNC server');
  assert.ok(vnc.record.pointers.length > 0, 'pointer events reached the VNC server');
  vnc.record.sendClipboard('TERMORA_VNC_CLIP');
  await page.waitForFunction(async () => (await window.bridge.readClipboard()) === 'TERMORA_VNC_CLIP');
  await page.screenshot({ path: path.join(screenshots, packaged ? 'portable-vnc.png' : 'vnc.png') });
  for (const client of vnc.record.clients) client.destroy();
  await page.waitForFunction(() => /Disconnected|Connection lost/.test(document.querySelector('.vnc-status')?.textContent || ''));
  vnc.server.close();
  record('Embedded VNC viewer authenticates in the main process, draws the desktop and sends input and clipboard');

  // Built-in Mosh client: SSH bootstrap to a fixture mosh-server, then UDP.
  const require = createRequire(import.meta.url);
  const { createMoshServer } = require('../tests/fixtures/mosh-server.cjs');
  const { Server: SshServer, utils: sshUtils } = require('ssh2');
  const moshServer = createMoshServer({ welcome: 'TERMORA_MOSH_READY\r\n$ ' }); const moshPort = await moshServer.listen();
  const moshSsh = new SshServer({ hostKeys: [sshUtils.generateKeyPairSync('ed25519').private] }, client => {
    client.on('error', () => {});
    client.on('authentication', context => context.method === 'password' && context.password === 'mosh-pass' ? context.accept() : context.reject(['password']));
    client.on('session', accept => { const session = accept(); session.on('pty', ok => ok?.()); session.on('exec', ok => { const stream = ok(); stream.write(`MOSH CONNECT ${moshPort} ${moshServer.key}\r\n`); stream.exit(0); stream.end(); }); });
  });
  await new Promise(resolve => moshSsh.listen(0, '127.0.0.1', resolve));
  await page.click('#new-session'); await page.click('[data-protocol="mosh"]');
  await page.fill('#conn-host', '127.0.0.1'); await page.fill('#conn-port', String(moshSsh.address().port)); await page.fill('#conn-username', 'qa');
  await page.click('[data-session-tab="advanced"]'); await page.fill('#conn-password', 'mosh-pass');
  await page.click('[data-session-tab="bookmark"]'); await page.uncheck('#connection-save');
  await page.click('#connect-session');
  await page.waitForFunction(() => Object.values(window.__termoraOutput).some(text => text.includes('TERMORA_MOSH_READY')));
  await page.keyboard.type('mosh-typed');
  await new Promise(resolve => { const started = Date.now(); const tick = () => moshServer.record.keys.includes('mosh-typed') || Date.now() - started > 5000 ? resolve() : setTimeout(tick, 50); tick(); });
  assert.equal(moshServer.record.keys, 'mosh-typed');
  await page.waitForFunction(() => Object.values(window.__termoraOutput).some(text => text.includes('$ mosh-typed')));
  assert.ok(moshServer.record.sizes.length >= 1 && moshServer.record.sizes[0][0] > 20, 'the terminal size reached mosh-server');
  moshServer.endSession();
  await page.waitForFunction(() => [...document.querySelectorAll('.terminal-pane')].some(pane => /ended|exited|closed/i.test(pane.textContent)) || document.querySelector('#status-text')?.textContent);
  moshServer.close(); moshSsh.close();
  record('Built-in Mosh client starts mosh-server over SSH, then types and draws over UDP');

  const saved = (await page.evaluate(() => window.bridge.bootstrap())).sessions.find(session => session.name === 'QA browser');
  assert.ok(saved, 'browser session was saved');
  await page.click('#rail-sessions');
  await page.locator('#sessions-list .session-row', { hasText: 'QA browser' }).click({ button: 'right' });
  await page.locator('.context-menu button', { hasText: 'Edit' }).click();
  await page.click('[data-session-tab="bookmark"]'); await page.click('#create-shortcut');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(node => node.textContent.includes('Shortcut created')));
  const shortcutFile = path.join(env.TERMORA_SHORTCUT_DIR, 'QA browser.lnk');
  assert.ok(fs.existsSync(shortcutFile));
  const link = await app.evaluate(({ shell }, file) => shell.readShortcutLink(file), shortcutFile);
  assert.match(link.args, new RegExp(`--session=${saved.id}$`));
  await page.click('#session-cancel');
  await page.evaluate(id => window.bridge.closeTerminal(id), sshId);
  await app.close(); app = null;
  // Starting Termora the way the shortcut does opens that saved session.
  const shortcutApp = await _electron.launch({ executablePath, args: [...(packaged ? [] : ['.']), `--session=${saved.id}`], cwd: root, env, timeout: 30000 });
  app = shortcutApp;
  activePage = await shortcutApp.firstWindow(); activePage.on('pageerror', error => errors.push(error.message));
  // The test web server stopped with the previous process, so check the window, not the page.
  const titles = () => shortcutApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(item => item.getTitle()));
  const started = Date.now();
  while (!(await titles()).some(title => title.includes('QA browser'))) { if (Date.now() - started > 20000) throw new Error(`Shortcut session did not open: ${JSON.stringify(await titles())}`); await new Promise(resolve => setTimeout(resolve, 200)); }
  page = activePage;
  record('A desktop shortcut starts Termora and opens its saved session');
  assert.deepEqual(errors, []);
  record('No renderer JavaScript errors');
  fs.writeFileSync(path.join(root, 'evidence', packaged ? 'portable-verification.json' : 'desktop-verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), executablePath, checks, errors }, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => {});
    console.error('UI state:', await activePage.evaluate(() => ({ status: document.querySelector('#status-text')?.textContent, toasts: [...document.querySelectorAll('.toast')].map(n => n.textContent), output: Object.fromEntries(Object.entries(window.__termoraOutput || {}).map(([id,text])=>[id,text.slice(-800)])) })).catch(() => ({})));
  }
  throw error;
} finally {
  if (app) await app.close();
  const resolved = path.resolve(data);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'termora-desktop-')) fs.rmSync(resolved, { recursive: true, force: true });
}
