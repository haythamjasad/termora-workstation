import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { ensureElectron } from './ensure-electron.mjs';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termora-mac-port-'));
const packaged = Boolean(process.env.TERMORA_VERIFY_EXECUTABLE);
let executablePath = process.env.TERMORA_VERIFY_EXECUTABLE;
if (!packaged) {
  await import('./build.mjs');
  await ensureElectron();
  executablePath = (await import('electron')).default;
}
fs.mkdirSync('release', { recursive: true });
delete process.env.ELECTRON_RUN_AS_NODE;
const application = await _electron.launch({ executablePath, args: packaged ? [] : ['.'], cwd: process.cwd(), env: { ...process.env, TERMORA_DATA_DIR: directory, TERMORA_TEST_MODE: 'visible' }, timeout: 60000 });
const errors = [];
async function ready(page) {
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => { errors.push(error.message); console.error('Renderer error:', error.message); });
  await page.waitForLoadState('domcontentloaded');
  try {
    await page.waitForFunction(() => Boolean(window.bridge && document.querySelector('#app-version')?.textContent.includes('0.1.0')), null, { polling: 100 });
  } catch (error) {
    console.error('Window readiness failed:', page.url(), errors);
    throw error;
  }
}
async function menu(group, label) {
  await application.evaluate(({ Menu }, { group, label }) => {
    const item = Menu.getApplicationMenu().items.find(item => item.label === group)?.submenu.items.find(item => item.label === label);
    if (!item) throw new Error(`Missing native menu: ${group} / ${label}`);
    item.click();
  }, { group, label });
}
async function focus(page) {
  const handle = await application.browserWindow(page);
  await handle.evaluate(window => { window.show(); window.focus(); });
  await page.waitForFunction(() => document.hasFocus());
  await handle.dispose();
}
try {
  const page = await application.firstWindow();
  await ready(page);
  const bootstrap = await page.evaluate(() => window.bridge.bootstrap());
  assert.equal(bootstrap.platform, 'darwin');
  assert.equal(await page.evaluate(() => window.bridge.platform), 'darwin');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('mac-style')), true);
  if (packaged) assert.equal(bootstrap.capabilities.rdp, true, 'Bundled RDP engine must be available');
  assert.equal(await page.evaluate(() => document.body.classList.contains('mac-style')), true);
  assert.equal(await page.locator('.menubar').isVisible(), false);
  assert.equal(await page.locator('#new-session').getAttribute('title'), 'Start a new session (⌘N)');
  await focus(page);
  await menu('File', 'New Connection…');
  await page.locator('dialog[open]').waitFor();
  await page.locator('[data-protocol="ssh"]').click();
  assert.equal(await page.locator('.ssh-basic-settings').isVisible(), true);
  await page.locator('[data-session-tab="advanced"]').click();
  assert.equal(await page.locator('#conn-password').isVisible(), true);
  await page.screenshot({ path: `release/Termora-macOS-${packaged ? 'package' : 'source'}-session.png` });
  await page.locator('#session-cancel').click();
  console.log('PASS native menu opens SSH basic and advanced settings');

  for (const theme of ['light', 'dark']) {
    await menu('Termora', 'Settings…');
    await page.locator('dialog[open]').waitFor();
    await page.locator('[data-config-tab="Display"]').click();
    await page.locator('#settings-theme').selectOption(theme);
    await page.locator('#settings-form').evaluate(form => form.requestSubmit());
    await page.waitForFunction(light => document.body.classList.contains('theme-light') === light, theme === 'light');
    assert.equal((await page.evaluate(() => window.bridge.bootstrap())).settings.theme, theme);
    await page.screenshot({ path: `release/Termora-macOS-${packaged ? 'package' : 'source'}-${theme}.png` });
  }
  console.log('PASS native Settings menu and persisted light/dark appearance');

  await page.evaluate(() => { window.__macPortOutput = ''; window.bridge.onTerminalData(event => window.__macPortOutput += event.data); });
  await menu('File', 'New Local Terminal');
  await page.locator('.terminal-pane').waitFor();
  const terminalId = await page.locator('.terminal-pane').getAttribute('data-terminal-id');
  await page.evaluate(id => window.bridge.writeTerminal({ id, data: "printf '%s%s\\n' 'TERMORA_MAC_' 'PTY_OK'\n" }), terminalId);
  await page.waitForFunction(() => window.__macPortOutput.includes('TERMORA_MAC_PTY_OK'));
  console.log('PASS native New Local Terminal menu and real shell input/output');

  await menu('File', 'New Local Terminal');
  await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 2);
  await menu('View', 'Split Terminals');
  assert.equal(await page.locator('.terminal-pane').count(), 2);
  await menu('View', 'Split Terminals');
  await menu('View', 'Split Terminals');
  console.log('PASS multiple local tabs and split panes');

  const detachedPromise = application.waitForEvent('window');
  await menu('Terminal', 'Detach Tab');
  const detached = await detachedPromise;
  await ready(detached);
  await detached.locator('.terminal-pane').waitFor();
  await focus(detached);
  await menu('Terminal', 'Rename Tab…');
  await detached.locator('#prompt-value').fill('Detached QA');
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Main window must not receive detached-window commands');
  await detached.locator('#prompt-form').evaluate(form => form.requestSubmit());
  await detached.waitForFunction(() => document.querySelector('.pane-title')?.textContent === 'Detached QA');
  await menu('Terminal', 'Find in Terminal…');
  await detached.locator('dialog[open]').waitFor();
  await detached.locator('#dialog-cancel').click();
  await focus(page);
  await menu('Terminal', 'Rename Tab…');
  await page.locator('#prompt-value').fill('Main QA');
  assert.equal(await detached.locator('dialog[open]').count(), 0);
  await page.locator('#prompt-form').evaluate(form => form.requestSubmit());
  await page.getByRole('tab', { name: /Main QA/ }).waitFor();
  console.log('PASS native rename/find actions follow focused detached and main terminals');

  // Browser windows have no application bridge. Their menus must not mutate
  // the workspace in the background, even for a local static test page.
  const browserPromise = application.waitForEvent('window');
  await application.evaluate(({ BrowserWindow }) => {
    const browser = new BrowserWindow({ show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    browser.loadURL('data:text/html,<title>Browser menu isolation</title>');
  });
  const browser = await browserPromise;
  await focus(browser);
  await menu('Terminal', 'Rename Tab…');
  // A following main-process round trip ensures the menu callback completed.
  await application.evaluate(() => true);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await detached.locator('dialog[open]').count(), 0);
  await browser.close();
  await focus(detached);
  await menu('File', 'Close Tab');
  await detached.waitForFunction(() => document.querySelectorAll('.terminal-pane').length === 0);
  assert.equal(await page.locator('.terminal-pane').count(), 1);
  assert.deepEqual(errors, []);
  console.log(`PASS ${packaged ? 'packaged' : 'source'} Mac verification; browser menu isolation, focused Close Tab, no renderer errors`);
} finally {
  await application.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
