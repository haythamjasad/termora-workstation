// Apple versioned frameworks permit only Versions/ and symlinks at the root.
// Hash verification alone does not detect errSecCSUnsealedFrameworkRoot.
export function verifyMacBundleStructure(entries) {
  const items=new Map(entries.map(item=>[item.path.replace(/\/+$/,''),item]));
  const frameworks=[...items.values()].filter(item=>item.type==='dir'&&item.path.endsWith('.framework'));
  const required=name=>{const item=items.get(name);if(!item)throw new Error(`Missing bundle item: ${name}`);return item;};
  function resolve(name){
    for(let depth=0;depth<40;depth++){
      const parts=name.split('/');let changed=false;
      for(let i=1;i<=parts.length;i++){
        const prefix=parts.slice(0,i).join('/'),item=items.get(prefix);
        if(item?.type==='symlink'){
          const target=item.data.toString('utf8');
          if(target.startsWith('/'))throw new Error(`Absolute framework symlink: ${prefix}`);
          const joined=[...parts.slice(0,i-1),...target.split('/'),...parts.slice(i)],normalized=[];
          for(const part of joined){if(part==='..')normalized.pop();else if(part&&part!=='.')normalized.push(part);}
          name=normalized.join('/');changed=true;break;
        }
      }
      if(!changed)return required(name);
    }
    throw new Error(`Cyclic framework link: ${name}`);
  }
  for(const framework of frameworks){
    const root=framework.path;
    for(const item of items.values()){
      if(!item.path.startsWith(root+'/'))continue;
      const relative=item.path.slice(root.length+1);
      if(relative.includes('/'))continue;
      if(relative==='Versions'&&item.type==='dir')continue;
      if(item.type!=='symlink'||!item.data.toString().startsWith('Versions/Current/'))throw new Error(`Unsealed framework root content: ${item.path}`);
      const resolved=resolve(item.path);
      if(!resolved.path.startsWith(root+'/Versions/'))throw new Error(`Framework alias leaves its versions: ${item.path}`);
    }
    const current=required(root+'/Versions/Current');
    if(current.type!=='symlink'||current.data.toString()!=='A')throw new Error(`Invalid Current link: ${root}`);
    const resources=required(root+'/Resources');
    if(resources.type!=='symlink'||resources.data.toString()!=='Versions/Current/Resources')throw new Error(`Invalid Resources alias: ${root}`);
    for(const file of ['Resources/Info.plist','_CodeSignature/CodeResources'])if(required(root+'/Versions/A/'+file).type!=='file')throw new Error(`Invalid canonical framework metadata: ${root}/${file}`);
  }
  for(const item of items.values()){
    if(item.type!=='dir'||!item.path.endsWith('.app'))continue;
    for(const child of items.values())if(child.path.startsWith(item.path+'/')&&!child.path.slice(item.path.length+1).includes('/')&&!(child.type==='dir'&&child.path.endsWith('/Contents')))throw new Error(`Unsealed app root content: ${child.path}`);
  }
  return {versionedFrameworksVerified:frameworks.length,frameworkRootLayout:'Versions directory and relative symlinks only'};
}
