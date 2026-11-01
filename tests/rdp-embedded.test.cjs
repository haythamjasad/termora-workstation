const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { EmbeddedRdp, PacketReader, packet, secretPacket, certificateDetails } = require('../lib/rdp-embedded.cjs');
const helper = path.resolve(__dirname, '../native-macos/Builds/rdp-engine/bin/termora-rdp-bridge');
const native = process.platform === 'darwin' && fs.existsSync(helper);
async function until(check) { for (let n=0;n<200;n++) { if(check()) return;await new Promise(resolve=>setTimeout(resolve,10)); } assert.fail('RDP fixture did not become ready'); }
function ready(adapter,w=2,h=1) { const size=Buffer.alloc(8);size.writeUInt32BE(w);size.writeUInt32BE(h,4);adapter.fromHelper('R',size);adapter.start();adapter.fromViewer(Buffer.from('RFB 003.008\n'));adapter.fromViewer(Buffer.from([1,1])); }

test('embedded RDP packet parser handles fragmentation and rejects oversized messages', () => {
  const messages=[];const reader=new PacketReader((type,data)=>messages.push([type,data.toString()]));
  const bytes=Buffer.concat([packet('A',Buffer.from('test')),packet('Q')]);for(const byte of bytes)reader.push(Buffer.from([byte]));
  assert.deepEqual(messages,[['A','test'],['Q','']]);
  assert.throws(()=>new PacketReader(()=>{}).push(Buffer.from([70,127,255,255,255])),/limit/);
});
test('RDP credentials use a bounded private packet and split DOMAIN\\user correctly', () => {
  const data=secretPacket({username:'LAB\\fixture',password:'fixture-secret'});assert.equal(data[0],83);
  let offset=5;const values=[];for(let n=0;n<6;n++){const size=data.readUInt32BE(offset);offset+=4;values.push(data.toString('utf8',offset,offset+size));offset+=size;}
  assert.deepEqual(values.slice(0,3),['fixture','LAB','fixture-secret']);
  assert.throws(()=>secretPacket({password:'x'.repeat(5000)}),/too long/);
  assert.throws(()=>secretPacket({password:'a\0b'}),/null character/);
});
test('embedded desktop uses the requested pixel layout and bounds-checks frames', () => {
  const sent=[];const adapter=new EmbeddedRdp({send:data=>sent.push(Buffer.from(data))});ready(adapter);
  const format=Buffer.alloc(20);format[4]=32;format[5]=24;format[7]=1;for(const at of[8,10,12])format.writeUInt16BE(255,at);format[14]=0;format[15]=8;format[16]=16;adapter.fromViewer(format);
  const pixels=Buffer.alloc(24);pixels.writeUInt32BE(2,8);pixels.writeUInt32BE(1,12);Buffer.from([30,120,220,0,3,2,1,0]).copy(pixels,16);adapter.fromHelper('F',pixels);
  const request=Buffer.alloc(10);request[0]=3;adapter.fromViewer(request);assert.deepEqual([...sent.at(-1).subarray(16)],[220,120,30,0,1,2,3,0]);
  const bad=Buffer.from(pixels);bad.writeUInt32BE(3,8);assert.throws(()=>adapter.fromHelper('F',bad),/bounds/);adapter.close();
});
test('RDP input and explicit one-way paste work without automatic clipboard sharing', () => {
  const inputs=[];const adapter=new EmbeddedRdp({send:()=>{},input:(type,data)=>inputs.push([type,Buffer.from(data||[]).toString('hex')])});ready(adapter);adapter.clipboardAllowed=true;
  adapter.fromViewer(Buffer.from([4,1,0,0,0,0,0,120]));adapter.fromViewer(Buffer.from([5,1,0,1,0,0]));
  const clip=Buffer.alloc(12);clip[0]=6;clip.writeUInt32BE(4,4);clip.write('test',8);adapter.fromViewer(clip);
  assert.deepEqual(inputs,[['K','0100000078'],['M','0100010000']]);
  adapter.paste('Paste ✓');assert.equal(inputs.at(-1)[0],'T');assert.equal(Buffer.from(inputs.at(-1)[1],'hex').toString(),'Paste ✓');
  adapter.clipboardAllowed=false;assert.throws(()=>adapter.paste('blocked'),/disabled/);assert.throws(()=>adapter.fromHelper('T',Buffer.from('remote clipboard')),/Unexpected/);adapter.close();
});
test('RDP certificate decisions are explicit and malformed identity packets are refused', async () => {
  const fields=['fixture.invalid','fixture','subject','issuer','SHA256:fixture'];const header=Buffer.alloc(2);header.writeUInt16BE(3389);const parts=[header];for(const text of fields){const value=Buffer.from(text),len=Buffer.alloc(4);len.writeUInt32BE(value.length);parts.push(len,value);}const data=Buffer.concat(parts);
  assert.equal(certificateDetails(data).fingerprint,'SHA256:fixture');assert.throws(()=>certificateDetails(data.subarray(0,10)),/Invalid/);
  const inputs=[];const adapter=new EmbeddedRdp({send:()=>{},input:(type,value)=>inputs.push([type,[...(value||[])]]),verifyCertificate:async details=>details.host==='fixture.invalid'&&false});adapter.fromHelper('C',data);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(inputs,[['V',[0]]]);adapter.close();
});
test('real windowless helper renders a framebuffer and accepts input without an external window', {skip:!native,timeout:10000}, async t => {
  const output=[];const adapter=new EmbeddedRdp({send:data=>output.push(Buffer.from(data))});t.after(()=>adapter.close());await adapter.open({},helper,{fixture:true});await until(()=>adapter.width===64);adapter.start();adapter.fromViewer(Buffer.from('RFB 003.008\n'));adapter.fromViewer(Buffer.from([1,1]));const request=Buffer.alloc(10);request[0]=3;adapter.fromViewer(request);assert.equal(output.at(-1).length,16+64*32*4);assert.deepEqual([...output.at(-1).subarray(16,19)],[30,120,220]);adapter.fromViewer(Buffer.from([4,1,0,0,0,0,0,120]));assert.ok(!adapter.child.spawnargs.join(' ').includes('password'));
});
test('windowless helper reports real connection refusal without a password in args or a file', {skip:!native,timeout:10000}, async t => {
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  let error;const adapter=new EmbeddedRdp({send:()=>{},ended:message=>{error=message;}});t.after(()=>adapter.close());await adapter.open({host:'127.0.0.1',port,username:'fixture',password:'fixture-secret'},helper);assert.ok(!adapter.child.spawnargs.join(' ').includes('fixture-secret'));if(adapter.file)assert.ok(!fs.readFileSync(adapter.file).includes(Buffer.from('fixture-secret')));await until(()=>error);assert.match(error,/could not reach|RDP connection failed/);
});

test('real TLS/NLA RDP login decodes pixels and carries keyboard/mouse to a loopback server', {skip:!native||!fs.existsSync(require('./fixtures/rdp-server.cjs').executable),timeout:15000}, async t => {
  const {createRdpFixture,until:wait}=require('./fixtures/rdp-server.cjs');const server=await createRdpFixture();t.after(()=>server.close());let failure;
  const adapter=new EmbeddedRdp({send:()=>{},ended:message=>{failure=message;},verifyCertificate:server.certificate});t.after(()=>adapter.close());
  await adapter.open({...server,rdpSize:'1024x768',rdpClipboard:false,rdpAudio:'none'},helper);
  await wait(()=>failure||adapter.pixels?.[2]===220);assert.equal(failure,undefined);assert.deepEqual([...adapter.pixels.subarray(0,4)],[30,120,220,0]);
  adapter.input('K',Buffer.from([1,0,0,0,120]));adapter.input('M',Buffer.from([0,0,1,0,1]));await wait(()=>server.output().includes('KEY')&&server.output().includes('MOUSE'));
});

test('incremental RDP updates send only the changed rectangle', () => {
  const sent=[];const adapter=new EmbeddedRdp({send:data=>sent.push(Buffer.from(data))});ready(adapter,4,2);const request=Buffer.alloc(10);request[0]=3;adapter.fromViewer(request);
  const rect=Buffer.alloc(20);rect.writeUInt32BE(2,0);rect.writeUInt32BE(1,4);rect.writeUInt32BE(1,8);rect.writeUInt32BE(1,12);Buffer.from([1,2,3,0]).copy(rect,16);adapter.fromHelper('F',rect);request[1]=1;adapter.fromViewer(request);
  assert.equal(sent.at(-1).length,20);assert.equal(sent.at(-1).readUInt16BE(4),2);assert.equal(sent.at(-1).readUInt16BE(6),1);assert.deepEqual([...sent.at(-1).subarray(16)],[1,2,3,0]);adapter.close();
});
test('incorrect NLA credentials fail without opening a separate authentication window', {skip:!native||!fs.existsSync(require('./fixtures/rdp-server.cjs').executable),timeout:15000}, async t => {
  const {createRdpFixture,until:wait}=require('./fixtures/rdp-server.cjs');const server=await createRdpFixture();t.after(()=>server.close());let error;
  const adapter=new EmbeddedRdp({send:()=>{},ended:message=>{error=message;},verifyCertificate:server.certificate});t.after(()=>adapter.close());await adapter.open({...server,password:'incorrect-fixture-only',rdpClipboard:false,rdpAudio:'none'},helper);await wait(()=>Boolean(error));assert.match(error,/sign-in failed|RDP connection failed/);assert.equal(adapter.width,0);
});
test('declining the RDP certificate prevents authentication and desktop access', {skip:!native||!fs.existsSync(require('./fixtures/rdp-server.cjs').executable),timeout:15000}, async t => {
  const {createRdpFixture,until:wait}=require('./fixtures/rdp-server.cjs');const server=await createRdpFixture();t.after(()=>server.close());let error,asked=false;
  const adapter=new EmbeddedRdp({send:()=>{},ended:message=>{error=message;},verifyCertificate:async()=>{asked=true;return false;}});t.after(()=>adapter.close());await adapter.open({...server,rdpClipboard:false,rdpAudio:'none'},helper);await wait(()=>Boolean(error));assert.equal(asked,true);assert.equal(adapter.width,0);assert.equal(server.output().includes('FRAME'),false);
});
