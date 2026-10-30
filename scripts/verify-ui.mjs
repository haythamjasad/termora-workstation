import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { ensureElectron } from './ensure-electron.mjs';
await import('./build.mjs');
await ensureElectron();
const {default:electron}=await import('electron');
const root=process.cwd(),data=fs.mkdtempSync(path.join(os.tmpdir(),'termora-ui-'));
const destination=path.join(root,'evidence','screenshots','ui-audit');
fs.mkdirSync(destination,{recursive:true});
const env={...process.env,TERMORA_DATA_DIR:data,TERMORA_TEST_MODE:'visible'};
delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.TERMORA_VERIFY_EXECUTABLE||electron;
const screenshots=[],checks=[],errors=[];
const types=['ssh','telnet','rsh','xdmcp','rdp','vnc','ftp','sftp','serial','file','local','browser','mosh','s3','wsl'];
const previews=new Set();
const configTabs=['General','Terminal','X11','SSH','Display','Toolbar','Misc','Security'];
let app,page;
async function capture(name,dialog=true){
  const file=name+'.png';
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  if(dialog)await page.locator('#app-dialog').screenshot({path:path.join(destination,file)});
  else await page.screenshot({path:path.join(destination,file)});
  screenshots.push(file);
}
async function checkGeometry(){
  const geometry=await page.evaluate(()=>{
    const dialog=document.querySelector('#app-dialog').getBoundingClientRect(),footer=document.querySelector('.dialog-footer').getBoundingClientRect();
    const tabs=document.querySelector('.session-setting-tabs')?.getBoundingClientRect();
    const content=document.querySelector('.session-settings-content')?.getBoundingClientRect();
    return {fits:dialog.left>=0&&dialog.right<=innerWidth&&dialog.top>=0&&dialog.bottom<=innerHeight,footerInside:footer.bottom<=dialog.bottom&&footer.top>=dialog.top,contentFits:!content||content.bottom<=footer.top+1,tabsFit:!tabs||tabs.right<=dialog.right};
  });
  assert.equal(geometry.fits,true);assert.equal(geometry.footerInside,true);assert.equal(geometry.contentFits,true);assert.equal(geometry.tabsFit,true);
}
try{
  app=await _electron.launch({executablePath,args:process.env.TERMORA_VERIFY_EXECUTABLE?[]:['.'],cwd:root,env});
  page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>document.querySelector('#app-version')?.textContent.includes('0.1.0'));
  for(const theme of ['dark','light']){
    await page.click(`.theme-choice[data-theme="${theme}"]`);
    await capture(`${theme}-home`,false);
    for(const menu of ['terminal','sessions','view','xserver','tools','games','settings','macros','help']){
      await page.click(`[data-menu="${menu}"]`);await capture(`${theme}-menu-${menu}`,false);await page.keyboard.press('Escape');
    }
    await page.click('[data-menu="tools"]');await page.locator('.classic-menu > button',{hasText:'Network'}).hover();
    assert.equal(await page.locator('.classic-menu .classic-menu').isVisible(),true);await capture(`${theme}-menu-network`,false);await page.keyboard.press('Escape');
    await page.click('#new-session');await capture(`${theme}-session-chooser`);await page.click('#dialog-close');
    for(const type of types){
      await page.click('#new-session');await page.click(`[data-protocol="${type}"]`);
      assert.equal(await page.locator('.session-setting-tab').count(),4);
      assert.equal(await page.locator('.dialog-error').textContent(),'');
      await checkGeometry();await capture(`${theme}-${type}-overview`);
      for(const tab of ['advanced','terminal','network','bookmark']){
        await page.click(`[data-session-tab="${tab}"]`);
        assert.equal(await page.locator(`[data-settings-pane="${tab}"]`).isVisible(),true);
        await checkGeometry();await capture(`${theme}-${type}-${tab}`);
      }
      if(previews.has(type)){assert.equal(await page.locator('#connect-session').isDisabled(),true);assert.equal(await page.locator('#save-session-only').isDisabled(),true);}
      await page.click('#dialog-close');checks.push(`${theme}: ${type} overview and four tabs`);
      console.log(`PASS ${theme} ${type} overview and all settings tabs`);
    }
    await page.click('#open-settings');
    for(const tab of configTabs){await page.click(`[data-config-tab="${tab}"]`);assert.equal(await page.locator(`[data-config-pane="${tab}"]`).isVisible(),true);await checkGeometry();await capture(`${theme}-configuration-${tab}`);}
    await page.click('#dialog-close');checks.push(`${theme}: eight configuration tabs`);
    for(const [button,name] of [['#open-tools','tools'],['#open-macros','macros'],['#open-tunnels','tunnels'],['#open-servers','servers']]){await page.click(button);await capture(`${theme}-${name}`);if(name==='servers'){for(const type of ['tftp','ftp','http','ssh','telnet','nfs','vnc','cron','iperf','echo']){await page.click(`[data-service="${type}"]`);await capture(`${theme}-server-${type}`);if(['ftp','ssh','cron'].includes(type)){await page.click('#configure-service');await capture(`${theme}-server-${type}-editor`);await page.click(type==='cron'?'#cron-back':'#server-back');}}}await page.click('#dialog-close');}
  }
  // Exercise persisted display choices without touching a real user's data.
  await page.click('#open-settings');await page.click('[data-config-tab="Display"]');
  await page.selectOption('#settings-sidebar-side','right');await page.check('[data-view-setting="tabNumbers"]');await page.uncheck('[data-view-setting="roundedTabs"]');
  await page.click('[data-config-tab="Toolbar"]');await page.selectOption('#settings-toolbar-style','small');
  await page.locator('#settings-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.body.classList.contains('sidebar-right')&&document.body.classList.contains('toolbar-small'));
  const saved=await page.evaluate(()=>window.bridge.bootstrap());
  assert.equal(saved.settings.ui.sidebarSide,'right');assert.equal(saved.settings.ui.tabNumbers,true);assert.equal(saved.settings.ui.roundedTabs,false);assert.equal(saved.sessions.length,0);
  checks.push('Display preferences persist through the real configuration tabs');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(root,'evidence','ui-audit.json'),JSON.stringify({checkedAt:new Date().toISOString(),executablePath,screenshots:screenshots.length,checks,errors,limits:'Visual coverage and geometry checks; pixel identity against unseen original screens is not established.'},null,2));
  fs.writeFileSync(path.join(destination,'index.html'),'<!doctype html><html><meta charset="utf-8"><title>Termora display review</title><style>body{background:#181818;color:#eee;font:14px Tahoma;margin:30px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:24px}img{max-width:100%;border:1px solid #777}h2{font-size:14px}</style><h1>Termora display review</h1><p>Both themes, all session types and tabs, configuration categories and menus. Visual reconstruction; exact original runtime comparison remains incomplete.</p><main>'+screenshots.map(file=>`<article><h2>${file.slice(0,-4)}</h2><a href="${file}"><img loading="lazy" src="${file}"></a></article>`).join('')+'</main></html>');
  console.log(`PASS ${screenshots.length} screenshots; ${checks.length} coverage checks; no renderer errors`);
}catch(error){if(page&&!page.isClosed())await page.screenshot({path:path.join(destination,'failure.png')}).catch(()=>{});throw error;}
finally{if(app)await app.close();const resolved=path.resolve(data);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'termora-ui-'))fs.rmSync(resolved,{recursive:true,force:true});}
