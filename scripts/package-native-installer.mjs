import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildHfsVolume,buildUdif} from './dmg.mjs';
import {readUdif,readHfs} from './dmg-reader.mjs';
import {verifyMacBundleStructure} from './mac-bundle-structure.mjs';

const root=process.cwd();
const go=path.resolve('putty-clone/mac-package/tools/go/bin/go.exe');
const signer=path.resolve('putty-clone/mac-package/tools/rcodesign/apple-codesign-0.29.0-x86_64-pc-windows-msvc/rcodesign.exe');
const python=process.env.TERMORA_PYTHON||path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const moduleDirectory=path.resolve('native-macos/Installer');
const goEnvironment={...process.env,GOTOOLCHAIN:'local',GOMAXPROCS:'2'};
function run(executable,args,options={}){const result=spawnSync(executable,args,{cwd:root,env:process.env,encoding:'utf8',windowsHide:true,...options});if(result.status!==0)throw new Error(result.stderr||result.stdout||`Command failed: ${executable}`);return (result.stdout||'')+(result.stderr||'');}
const testOutput=run(go,['test','./...'],{cwd:moduleDirectory,env:goEnvironment});console.log(testOutput.trim());
const stage=path.resolve(`release/native-installer-stage/${Date.now()}`);
const app=path.join(stage,'Install Termora Native.app');
const contents=path.join(app,'Contents'),resources=path.join(contents,'Resources');
await fs.mkdir(path.join(contents,'MacOS'),{recursive:true});await fs.mkdir(resources,{recursive:true});
const executable=path.join(contents,'MacOS','Installer');
run(go,['build','-trimpath','-ldflags=-s -w','-o',executable,'.'],{cwd:moduleDirectory,env:{...goEnvironment,GOOS:'darwin',GOARCH:'amd64',CGO_ENABLED:'0'}});
const binary=await fs.readFile(executable);
if(binary.readUInt32LE(0)!==0xfeedfacf||binary.readUInt32LE(4)!==0x01000007)throw new Error('Installer is not an Intel Mach-O executable');
const project=path.join(resources,'Project');await fs.mkdir(project,{recursive:true});
for(const directory of ['Sources','Tests','Tools'])await fs.cp(path.join(root,'native-macos',directory),path.join(project,directory),{recursive:true});
for(const file of ['Package.swift','Build Native Mac.command','LICENSE','README.md','THIRD-PARTY-NOTICES.md'])await fs.copyFile(path.join(root,'native-macos',file),path.join(project,file));
const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Install Termora Native</string>
<key>CFBundleDisplayName</key><string>Install Termora Native</string>
<key>CFBundleIdentifier</key><string>org.termora.native.installer</string>
<key>CFBundleExecutable</key><string>Installer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`;
await fs.writeFile(path.join(contents,'Info.plist'),plist);
const signingLog=run(signer,['sign','--timestamp-url','none',app]);await fs.writeFile(path.join(stage,'signing.log'),signingLog);
console.log(run(python,['scripts/verify-mac-signatures.py',app,'evidence/native-installer-signatures.json']).trim());
const entries=[{path:'Install Termora Native.app',type:'dir',mode:0o755}];
async function collect(directory,prefix){for(const item of await fs.readdir(directory,{withFileTypes:true})){const full=path.join(directory,item.name),name=prefix+'/'+item.name;if(item.isDirectory()){entries.push({path:name,type:'dir',mode:0o755});await collect(full,name);}else if(item.isFile())entries.push({path:name,type:'file',mode:name.endsWith('/MacOS/Installer')||name.endsWith('.command')?0o755:0o644,data:await fs.readFile(full)});}}
await collect(app,'Install Termora Native.app');
entries.push({path:'Build and Install.command',type:'file',mode:0o755,data:await fs.readFile('native-macos/Installer/Build and Install.command')});
const readme=`Termora Native — Intel Mac Installer\n\nRequires macOS 13 or later, Xcode 15 or later (already installed and opened\nonce), and Internet access to download the pinned SwiftTerm dependency.\n\n1. Double-click Build and Install.command in this disk image.\n2. A Terminal build window opens and starts the build. If Finder blocks the\n   launcher, open Terminal and type /bin/bash followed by a space, drag\n   Build and Install.command into Terminal, then press Return.\n3. Wait for the native Swift/AppKit build, tests and signing checks.\n4. On success, Termora Native.app is installed into ~/Applications and opens.\n\nNo commands need to be copied into Terminal. Existing native installations\nare retained with a previous-version name. The Electron app is unchanged.\n\nImportant: This DMG contains a compiled Intel installer and the Swift source\nproject. The actual Swift/AppKit application is compiled ON YOUR MAC using\nXcode; it is not a precompiled native application release.\n\nThe installer is ad-hoc signed, not Apple-notarized. If macOS blocks it, try\nSystem Settings > Privacy & Security > Open Anyway after attempting to open it.\n\nThe first native implementation has local terminals, SSH/SFTP terminal\nconnections, native session management, import/export, serial, and external\nRDP/VNC/browser launchers. Other advanced features are not yet ported.\n\nIf a build fails, the build window displays the error and Finder reveals\nBuilds/build.log inside the cached project. Please send that error log.\n\nInstaller packaging and signing were checked on Windows. The Mac-side native\ncompile and launch remain unverified until this installer runs on your Mac.\n`;
entries.push({path:'Read Me First.txt',type:'file',mode:0o644,data:Buffer.from(readme)});
verifyMacBundleStructure(entries);
const volume=buildHfsVolume(entries,{volumeName:'Termora Native Installer'}),dmg=buildUdif(volume.image,{name:'Termora Native Installer'});
const output=path.resolve('release/Termora-Native-Intel-Installer-r3.dmg');await fs.writeFile(output,dmg);
const decoded=readUdif(await fs.readFile(output));if(!decoded.equals(volume.image))throw new Error('DMG decompression mismatch');
const actual=readHfs(decoded),byPath=new Map(actual.items.map(item=>[item.path,item]));
if(byPath.size!==entries.length)throw new Error('DMG entry count mismatch');
for(const entry of entries){const found=byPath.get(entry.path);if(!found||found.type!==entry.type||(found.mode&0o777)!==entry.mode||(entry.type!=='dir'&&!found.data.equals(entry.data)))throw new Error(`Installer DMG mismatch: ${entry.path}`);}
verifyMacBundleStructure(actual.items);
const report={output,bytes:dmg.length,sha256:crypto.createHash('sha256').update(dmg).digest('hex'),architecture:'x86_64',signing:'ad-hoc',notarized:false,entriesVerified:entries.length,installerTests:testOutput.trim(),nativeApplicationCompiledHere:false,nativeApplicationBuild:'On the Mac using installed Xcode',macOSInstallerRuntimeTested:false,directShellLauncher:true};
await fs.writeFile('evidence/native-installer-verification.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile('release/README-Native-Installer.txt',readme);console.log(JSON.stringify(report,null,2));
