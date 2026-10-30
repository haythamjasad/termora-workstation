import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),yauzl=require('yauzl');
fs.mkdirSync('evidence', { recursive: true });
const archive=path.resolve('release/Termora-darwin-x64.zip');
const zip=await new Promise((resolve,reject)=>yauzl.open(archive,{lazyEntries:true},(error,value)=>error?reject(error):resolve(value)));
const names=new Set(),links=[],binaries={};let entries=0,bytes=0,minimumOS;
function hasIntel(data){
  if(data.length<8)return false;
  if(data.readUInt32LE(0)===0xfeedfacf)return data.readUInt32LE(4)===0x01000007;
  const magic=data.readUInt32BE(0),stride=magic===0xcafebabe?20:magic===0xcafebabf?32:0;
  if(!stride)return false;
  for(let n=0;n<data.readUInt32BE(4);n++)if(data.readUInt32BE(8+n*stride)===0x01000007)return true;
  return false;
}
await new Promise((resolve,reject)=>{
  zip.on('error',reject);zip.on('end',resolve);
  zip.on('entry',entry=>{
    if(names.has(entry.fileName)){reject(new Error(`Duplicate entry: ${entry.fileName}`));return;}
    names.add(entry.fileName);entries++;
    if(entry.fileName.endsWith('/')){zip.readEntry();return;}
    zip.openReadStream(entry,(error,stream)=>{
      if(error){reject(error);return;}
      const chunks=[];stream.on('data',chunk=>chunks.push(chunk));stream.on('error',reject);
      stream.on('end',()=>{try{
        const data=Buffer.concat(chunks),mode=entry.externalFileAttributes>>>16;bytes+=data.length;
        if((zlib.crc32(data)>>>0)!==entry.crc32)throw new Error(`CRC mismatch: ${entry.fileName}`);
        if((mode&0o170000)===0o120000){const target=path.posix.normalize(path.posix.join(path.posix.dirname(entry.fileName),data.toString()));if(!target.startsWith('Termora.app/'))throw new Error('Symlink escapes bundle');links.push({name:entry.fileName,target});}
        const name=entry.fileName;
        if(name==='README-macOS.txt')fs.writeFileSync('release/README-macOS.txt',data);
        if(name.endsWith('.command')&&!(mode&0o111))throw new Error('Mac preparation helper is not executable');
        if(name.endsWith('/Contents/MacOS/Electron')||name.endsWith('/Electron Framework.framework/Versions/A/Electron Framework')||(/node-pty-darwin-x64\//.test(name)&&(/\.node$|spawn-helper$/.test(name)))||name.endsWith('/darwin-x64+arm64/@serialport+bindings-cpp.node')){
          if(!hasIntel(data))throw new Error(`Missing Intel Mach-O architecture: ${name}`);
          if(!name.endsWith('.node')&&!(mode&0o111))throw new Error(`Missing executable mode: ${name}`);
          binaries[name]='x86_64';
        }
        if(name==='Termora.app/Contents/Info.plist')minimumOS=/<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)/.exec(data.toString())?.[1];
        zip.readEntry();
      }catch(error){reject(error);}});
    });
  });zip.readEntry();
});
const linkTargets=new Map(links.map(link=>[link.name,link.target]));
function resolveLink(target){
  for(let depth=0;depth<40;depth++){
    const pieces=target.split('/');let changed=false;
    for(let index=1;index<=pieces.length;index++){const prefix=pieces.slice(0,index).join('/');if(linkTargets.has(prefix)){target=path.posix.join(linkTargets.get(prefix),...pieces.slice(index));changed=true;break;}}
    if(!changed)return target;
  }
  throw new Error('Cyclic framework link');
}
for(const link of links){const target=resolveLink(link.target);if(!names.has(target)&&!names.has(target+'/'))throw new Error(`Dangling symlink: ${link.name}`);}
if(!names.has('Termora.app/Contents/Resources/app/electron/main.cjs')||!names.has('Make Termora DMG.command'))throw new Error('App code or Mac preparation helper missing');
if(Object.keys(binaries).length<4||!minimumOS)throw new Error('Incomplete native architecture or minimum-OS verification');
const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(archive))hash.update(chunk);
const result={checkedAt:new Date().toISOString(),archive,sha256:hash.digest('hex'),minimumOS,entries,uncompressedBytes:bytes,symlinks:links.length,binaries,runtimeTested:false,notes:`Archive CRC, native Intel architecture, executable permissions and framework links verified on ${process.platform}; this archive check does not test runtime launch or signing.`};
fs.writeFileSync('evidence/mac-package-verification.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
