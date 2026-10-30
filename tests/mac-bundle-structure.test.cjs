const test=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const load=()=>import(pathToFileURL(path.join(__dirname,'../scripts/mac-bundle-structure.mjs')).href);
function framework(){
  const root='App.app/Contents/Frameworks/Example.framework';
  return [{path:'App.app',type:'dir'},{path:'App.app/Contents',type:'dir'},{path:root,type:'dir'},
    {path:root+'/Versions',type:'dir'},{path:root+'/Versions/A',type:'dir'},
    {path:root+'/Versions/Current',type:'symlink',data:Buffer.from('A')},
    {path:root+'/Resources',type:'symlink',data:Buffer.from('Versions/Current/Resources')},
    {path:root+'/Example',type:'symlink',data:Buffer.from('Versions/Current/Example')},
    {path:root+'/Versions/A/Example',type:'file',data:Buffer.from('executable')},
    {path:root+'/Versions/A/Resources',type:'dir'},
    {path:root+'/Versions/A/Resources/Info.plist',type:'file',data:Buffer.from('plist')},
    {path:root+'/Versions/A/_CodeSignature/CodeResources',type:'file',data:Buffer.from('seal')}];
}
test('canonical versioned framework structure accepts relative aliases and a version-local seal',async()=>{
  const {verifyMacBundleStructure:verify}=await load();assert.equal(verify(framework()).versionedFrameworksVerified,1);
});
test('rejects the shipped unsealed-root signing-directory defect and misplaced files',async()=>{
  const {verifyMacBundleStructure:verify}=await load();
  for(const [name,type]of [['_CodeSignature','dir'],['Info.plist','file'],['README.txt','file']]){
    const entries=framework();entries.push({path:'App.app/Contents/Frameworks/Example.framework/'+name,type,data:Buffer.from('unexpected')});
    assert.throws(()=>verify(entries),/Unsealed framework root content/);
  }
});
test('rejects broken, escaping or materialized framework aliases',async()=>{
  const {verifyMacBundleStructure:verify}=await load();
  for(const target of ['Versions/Current/Missing','../../../Other']){
    const entries=framework();entries.find(item=>item.path.endsWith('.framework/Example')).data=Buffer.from(target);
    assert.throws(()=>verify(entries));
  }
  const entries=framework();entries.find(item=>item.path.endsWith('.framework/Resources')).type='dir';
  assert.throws(()=>verify(entries),/Unsealed framework root content/);
});
