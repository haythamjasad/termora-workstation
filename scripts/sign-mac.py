"""Ad-hoc sign the staged Electron app with the PuTTY project's rcodesign."""
import pathlib
import plistlib
import posixpath
import shutil
import stat
import subprocess
import sys
import zipfile

root=pathlib.Path(__file__).resolve().parents[1]
app=pathlib.Path(sys.argv[1]).resolve()
assert app.is_relative_to((root/'release/mac-sign').resolve())
tool=root/'putty-clone/mac-package/tools/rcodesign/apple-codesign-0.29.0-x86_64-pc-windows-msvc/rcodesign.exe'
assert tool.is_file(),'PuTTY signing tool is missing'
for info in app.rglob('Info.plist'):
    if info.parent.name!='Contents':continue
    data=plistlib.loads(info.read_bytes())
    if 'CFBundleExecutable' not in data and (info.parent/'MacOS').is_dir():
        files=[p for p in (info.parent/'MacOS').iterdir() if p.is_file()]
        if len(files)==1:data['CFBundleExecutable']=files[0].name
    data.pop('ElectronAsarIntegrity',None)
    info.write_bytes(plistlib.dumps(data))
with (app.parent.parent/'signing.log').open('w') as log:
    def sign(target):
        subprocess.run([str(tool),'sign','--timestamp-url','none',str(target)],stdout=log,stderr=log,check=True)
    # Pre-sign native modules before the bundle resource scan requires cdhashes.
    for file in app.rglob('*'):
        if not file.is_file():continue
        with file.open('rb') as stream:magic=stream.read(4)
        if magic in (b'\xcf\xfa\xed\xfe',b'\xce\xfa\xed\xfe',b'\xca\xfe\xba\xbe',b'\xca\xfe\xba\xbf'):sign(file)
    sign(app)
    # Synchronize the temporary aliases after nested signing. The final DMG
    # restores the original Unix symlinks, retaining only canonical signed data.
    with zipfile.ZipFile(root/'release/Termora-darwin-x64.zip') as archive:
        links={e.filename.rstrip('/'):posixpath.normpath(posixpath.join(posixpath.dirname(e.filename),archive.read(e).decode())) for e in archive.infolist() if stat.S_ISLNK(e.external_attr>>16)}
    def resolve(name):
        for _ in range(40):
            parts=name.split('/')
            for index in range(1,len(parts)+1):
                prefix='/'.join(parts[:index])
                if prefix in links:name=posixpath.join(links[prefix],*parts[index:]);break
            else:return name
        raise RuntimeError('Cyclic framework alias')
    for alias in links:
        source=app.parent/resolve(alias);target=app.parent/alias
        if source.is_dir():shutil.copytree(source,target,dirs_exist_ok=True)
        else:shutil.copy2(source,target)
    sign(app)
print('Ad-hoc signed',app)
