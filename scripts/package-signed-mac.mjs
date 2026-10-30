// Same distribution approach as the adjacent PuTTY project: pre-signed app,
// self-contained Intel binaries, a DMG and an Applications shortcut.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {buildHfsVolume,buildUdif} from './dmg.mjs';
import {readUdif,readHfs} from './dmg-reader.mjs';
import {verifyMacBundleStructure} from './mac-bundle-structure.mjs';
const require=createRequire(import.meta.url),yauzl=require('yauzl'),root=process.cwd();
const python=process.env.TERMORA_PYTHON||path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
function run(script,args=[]){const result=spawnSync(python,[script,...args],{cwd:root,encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error(result.stderr||result.stdout||`${script} failed`);console.log(result.stdout.trim());}
let app=process.env.TERMORA_SIGNED_APP;
if(!app){
  await import('./package-mac.mjs');
  const input=path.resolve(`release/mac-sign/${Date.now()}/input`);
  run('scripts/stage-mac-sign.py',[input]);app=path.join(input,'Termora.app');
  run('scripts/sign-mac.py',[app]);
}
app=path.resolve(app);
run('scripts/verify-mac-signatures.py',[app]);
const modes=JSON.parse(await fs.readFile(path.join(path.dirname(path.dirname(app)),'file-modes.json'),'utf8'));
const zip=await new Promise((resolve,reject)=>yauzl.open('release/Termora-darwin-x64.zip',{lazyEntries:true},(error,value)=>error?reject(error):resolve(value)));
const links=new Map();
await new Promise((resolve,reject)=>{zip.on('error',reject);zip.on('end',resolve);zip.on('entry',entry=>{if(((entry.externalFileAttributes>>>16)&0o170000)!==0o120000){zip.readEntry();return;}zip.openReadStream(entry,(error,stream)=>{if(error){reject(error);return;}const chunks=[];stream.on('error',reject);stream.on('data',chunk=>chunks.push(chunk));stream.on('end',()=>{links.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();});});});zip.readEntry();});
// The Windows signing stage materializes aliases and can retain a signing
// directory at the framework root. Ship only the canonical version seal.
const excluded=name=>/\.framework\/_CodeSignature(?:\/|$)/.test(name)||[...links.keys()].some(alias=>name===alias||name.startsWith(alias+'/'));
const entries=[{path:'Termora.app',type:'dir',mode:0o755}];
async function addTree(directory,prefix){for(const item of await fs.readdir(directory,{withFileTypes:true})){const name=prefix+'/'+item.name;if(excluded(name))continue;const source=path.join(directory,item.name);if(item.isDirectory()){entries.push({path:name,type:'dir',mode:0o755});await addTree(source,name);}else if(item.isFile()){const data=await fs.readFile(source);entries.push({path:name,type:'file',mode:modes[name]||0o644,data});}}}
await addTree(app,'Termora.app');
for(const [name,data]of links)entries.push({path:name,type:'symlink',mode:0o755,data});
entries.push({path:'Applications',type:'symlink',mode:0o755,data:Buffer.from('/Applications')});
const instructions=`Termora for Intel Mac (x86_64), macOS 13 or later\n\n1. Drag Termora.app onto Applications.\n2. Open Termora from Applications.\n\nThe app is already ad-hoc signed, using the same signing tool as the PuTTY\npackage in this workspace. No Terminal signing command, Homebrew or Node.js\ninstallation is required.\n\nThis is not Apple-notarized or Developer ID signed. If macOS blocks the first\nlaunch, use System Settings > Privacy & Security > Open Anyway after trying\nto open Termora.\n\nSettings: ~/Library/Application Support/Termora\nLocal tabs use the Mac login shell. WSL and Windows .lnk shortcuts are unavailable.\n\nBuilt and verified on Windows. macOS launch and Gatekeeper acceptance have\nnot been tested on a Mac.\n`;
entries.push({path:'Read Me First.txt',type:'file',mode:0o644,data:Buffer.from(instructions)});
for(const file of ['LICENSE','THIRD-PARTY-NOTICES.md'])entries.push({path:file,type:'file',mode:0o644,data:await fs.readFile(file)});
verifyMacBundleStructure(entries);
const volume=buildHfsVolume(entries,{volumeName:'Termora'}),dmg=buildUdif(volume.image,{name:'Termora'});
const manifest=JSON.parse(await fs.readFile('package.json','utf8'));
const output=path.resolve(`release/Termora-${manifest.version}-macOS-Intel-r2.dmg`);
await fs.writeFile(output,dmg);
const decoded=readUdif(await fs.readFile(output));if(!decoded.equals(volume.image))throw new Error('DMG decompression differs from signed source volume');
const found=readHfs(decoded),byName=new Map(found.items.map(item=>[item.path,item]));
if(byName.size!==entries.length)throw new Error('DMG item count differs');
for(const item of entries){const actual=byName.get(item.path);if(!actual||actual.type!==item.type||(actual.mode&0o777)!==item.mode||(item.type!=='dir'&&!actual.data.equals(item.data)))throw new Error(`DMG verification failed: ${item.path}`);}
const structure=verifyMacBundleStructure(found.items);
const report={output,revision:2,bytes:dmg.length,sha256:crypto.createHash('sha256').update(dmg).digest('hex'),signing:'ad-hoc',notarized:false,itemsVerified:entries.length,frameworkSymlinksRestored:links.size,...structure,macOSRuntimeTested:false};
await fs.writeFile('evidence/mac-signed-dmg-verification-r2.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile('release/README-macOS-signed.txt',instructions);
console.log(JSON.stringify(report,null,2));
