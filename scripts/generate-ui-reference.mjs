import fs from 'node:fs';
const source = JSON.parse(fs.readFileSync('evidence/ui-style-reference.json','utf8').replace(/^\uFEFF/,''));
const clean = text => String(text || '').replace(/&/g,'').replace(/\s+/g,' ').trim();
const session = source.records.find(r=>r.resource==='TFORMSESSIONEDIT');
const types = {ssh:'TabSSH',telnet:'TabTelnet',rsh:'TabRlogin',xdmcp:'TabXDMCP',rdp:'TabRDP',vnc:'TabVNC',ftp:'TabFTP',sftp:'sTabSheet1',serial:'TabSerial',file:'TabUrl',local:'TabLocal',browser:'TabBrowser',mosh:'TabMosh',s3:'sTabSheet16',wsl:'sTabSheet18'};
function descendants(record,parent) {
  const names = new Set([parent]);
  for(let count=0;count<10;count++) for(const c of record.components) if(names.has(c.parent)) names.add(c.name);
  return record.components.filter(c=>c.name!==parent&&names.has(c.name));
}
const sessionOptions = Object.fromEntries(Object.entries(types).map(([type,parent])=>[type,descendants(session,parent).filter(c=>c.className==='TsCheckBox'&&c.properties.Caption).map(c=>({label:clean(c.properties.Caption.value),checked:c.properties.Checked?.value===true}))]));
const params=source.records.find(r=>r.resource==='TFORMPARAMS');
const settingsTabs = ['OngletMisc','OngletTerminal','OngletX11','OngletSSH','OngletDisplay','sTabSheet1','sTabSheet2','OngletCustom'].map(parent=>({name:clean(params.components.find(c=>c.name===parent).properties.Caption.value),groups:descendants(params,parent).filter(c=>c.className==='TsGroupBox').map(c=>({name:clean(c.properties.Caption?.value),options:descendants(params,c.name).filter(c=>c.className==='TsCheckBox'&&c.properties.Caption).map(c=>clean(c.properties.Caption.value))})),options:params.components.filter(c=>c.parent===parent&&c.className==='TsCheckBox'&&c.properties.Caption).map(c=>clean(c.properties.Caption.value))}));
fs.writeFileSync('src/ui-reference.json',JSON.stringify({sourceSha256:source.source_sha256,sessionOptions,settingsTabs},null,2)+'\n');
console.log('Generated session and configuration captions from decoded 26.5 resources.');
