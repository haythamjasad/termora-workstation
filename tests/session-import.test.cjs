const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSessionImport, MAX_IMPORT_BYTES } = require('../lib/session-import.cjs');
const fixture = fs.readFileSync(path.join(__dirname,'fixtures/encrypted-config.mobaconf'));

// Fixed fixture generated with Python cryptography AES/CFB8, independently of
// the Node implementation. Contains synthetic credentials, no user data.
test('encrypted configuration requires a password and imports only session identity', () => {
  assert.deepEqual(parseSessionImport(fixture), {needsPassword:true,format:'mobaconf-encrypted'});
  assert.throws(()=>parseSessionImport(fixture,{password:'wrong'}),/Could not unlock/);
  assert.throws(()=>parseSessionImport(fixture,{password:''}),/Enter the password/);
  const result = parseSessionImport(fixture,{password:'fixture-password'});
  assert.equal(result.sessions.length,1);
  assert.equal(result.sessions[0].name,'Fixture');
  assert.equal(result.sessions[0].host,'example.invalid');
  assert.equal(result.sessions[0].port,2222);
  assert.equal(result.sessions[0].username,'alice');
  assert.equal(result.sessions[0].folder,'Lab');
  assert.doesNotMatch(JSON.stringify(result),/VAULT_SECRET|fixture-password/);
});
test('plain and UTF-16 configuration backups import bookmark folders', () => {
  const source='[ImportExportSpecials]\r\n[Bookmarks_1]\r\nSubRep=Servers\r\nExample=#109#0%example.invalid%22%alice#rest\r\n';
  for(const bytes of [Buffer.from(source),Buffer.concat([Buffer.from([255,254]),Buffer.from(source,'utf16le')])]) {
    const parsed=parseSessionImport(bytes);
    assert.equal(parsed.sessions[0].folder,'Servers');
  }
});
test('JSON imports retain identity and discard credentials', () => {
  const parsed=parseSessionImport(Buffer.from(JSON.stringify({sessions:[{type:'ssh',host:'example.invalid',password:'PRIVATE'}]})));
  assert.equal(parsed.sessions[0].host,'example.invalid');
  assert.doesNotMatch(JSON.stringify(parsed),/PRIVATE/);
  assert.equal(parseSessionImport(Buffer.from('[]')).sessions.length,0);
});
test('damaged, empty and unrelated files fail clearly', () => {
  for(const input of [Buffer.alloc(0),Buffer.alloc(MAX_IMPORT_BYTES+1),Buffer.from('_@short'),Buffer.from('[Other]\nvalue=1'),Buffer.from('[Bookmarks]\nImgNum=41')]) assert.throws(()=>parseSessionImport(input));
  assert.throws(()=>parseSessionImport(Buffer.from('_@0123456789ABCDEFGH====')),/malformed/);
});
