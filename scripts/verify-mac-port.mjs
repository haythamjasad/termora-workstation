import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {_electron} from 'playwright';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termora-mac-port-'));
const executablePath = process.env.TERMORA_VERIFY_EXECUTABLE;
if (!executablePath) throw new Error('Provide the packaged Mac executable');
delete process.env.ELECTRON_RUN_AS_NODE;
const application = await _electron.launch({executablePath, env:{...process.env,TERMORA_DATA_DIR:directory,TERMORA_TEST_MODE:'visible'},timeout:60000});
try {
  const page = await application.firstWindow();
  await page.waitForFunction(()=>Boolean(window.bridge && document.querySelector('#app-version')?.textContent.includes('0.1.0')));
  const bootstrap = await page.evaluate(()=>window.bridge.bootstrap());
  assert.equal(bootstrap.platform,'darwin');
  assert.equal(bootstrap.capabilities.rdp,true,'Bundled RDP engine must be available');
  assert.equal(await page.locator('.menu-button').count() > 5,true);
  await page.evaluate(()=>{window.__macPortOutput='';window.bridge.onTerminalData(event=>window.__macPortOutput+=event.data);});
  const terminal = await page.evaluate(()=>window.bridge.openTerminal({type:'local',name:'Mac test',shell:'default',cols:100,rows:30}));
  await page.evaluate(id=>window.bridge.writeTerminal({id,data:"printf '%s%s\\n' 'TERMORA_MAC_' 'PTY_OK'\n"}),terminal.id);
  await page.waitForFunction(()=>window.__macPortOutput.includes('TERMORA_MAC_PTY_OK'),null,{timeout:20000});
  await page.evaluate(id=>window.bridge.closeTerminal(id),terminal.id);
  await page.screenshot({path:'release/Termora-macOS-home.png'});
  console.log('PASS packaged Windows-codebase Mac UI, bridge, bundled RDP detection, real local PTY');
} finally {await application.close();}
