const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const executable = path.resolve(__dirname, '../../native-macos/Builds/rdp-fixture');
async function until(check, failure = () => '') { for(let n=0;n<1000;n++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('RDP fixture timed out. '+failure()); }
async function createRdpFixture({ nla = true } = {}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'termora-rdp-tls-'));
  const key=path.join(directory,'key.pem'),cert=path.join(directory,'cert.pem'),sam=path.join(directory,'sam');
  const generated=spawnSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=Termora RDP Fixture','-keyout',key,'-out',cert,'-days','1'],{encoding:'utf8'});
  if(generated.status!==0){fs.rmSync(directory,{recursive:true,force:true});throw new Error('Could not generate the local RDP fixture certificate.');}
  const password=crypto.randomBytes(18).toString('base64url');
  if(nla){let digest=spawnSync('/usr/bin/openssl',['dgst','-md4'],{input:Buffer.from(password,'utf16le'),encoding:'utf8'});if(digest.status!==0)digest=spawnSync('/opt/local/libexec/openssl3/bin/openssl',['dgst','-md4','-provider','legacy'],{input:Buffer.from(password,'utf16le'),encoding:'utf8'});const hash=digest.stdout?.match(/[0-9a-f]{32}/i)?.[0];if(!hash)throw new Error('Could not hash the generated RDP fixture password.');fs.writeFileSync(sam,`fixture:LAB::${hash}:\n`,{mode:0o600});}
  const fingerprint=new crypto.X509Certificate(fs.readFileSync(cert)).fingerprint256.replaceAll(':','').toLowerCase();
  const child=spawn(executable,[cert,key,...nla?[sam]:[]],{stdio:['ignore','pipe','pipe']});let output='',diagnostics='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{diagnostics+=data;});
  const close=()=>{child.kill();fs.rmSync(directory,{recursive:true,force:true});};
  try{await until(()=>/PORT (\d+)/.test(output),()=>diagnostics.slice(-1000));}catch(error){close();throw error;}
  return { host:'127.0.0.1',port:Number(output.match(/PORT (\d+)/)[1]),username:'fixture',domain:'LAB',password,fingerprint,certificate:details=>details.host==='127.0.0.1'&&details.fingerprint.replace(/^SHA256:/i,'').replaceAll(':','').toLowerCase()===fingerprint,output:()=>output,close };
}
module.exports={createRdpFixture,until,executable};
