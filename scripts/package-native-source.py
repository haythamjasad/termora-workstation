"""Package the Swift/AppKit project without private data or build artifacts."""
import hashlib
import json
import pathlib
import zipfile

root=pathlib.Path(__file__).resolve().parents[1]
source=root/'native-macos'
output=root/'release/Termora-Native-Swift-AppKit-Intel-Source.zip'
allowed=[]
for file in sorted(source.rglob('*')):
    if not file.is_file() or any(part in ('.build','.swiftpm','Builds') for part in file.relative_to(source).parts):continue
    allowed.append(file)
with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
    for file in allowed:
        name='TermoraNative/'+file.relative_to(source).as_posix()
        item=zipfile.ZipInfo(name)
        item.create_system=3
        item.external_attr=(0o100755 if file.suffix=='.command' else 0o100644)<<16
        item.compress_type=zipfile.ZIP_DEFLATED
        archive.writestr(item,file.read_bytes())
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    names=archive.namelist()
    assert 'TermoraNative/Package.swift' in names and 'TermoraNative/Build Native Mac.command' in names
    assert not any('/node_modules/' in name or name.endswith('.exe') or name.endswith('.node') for name in names)
report={'archive':str(output),'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'files':len(allowed),'nativeFramework':'AppKit','terminalLibrary':'SwiftTerm 1.10.1','compiled':False,'macOSRuntimeTested':False,'status':'Source package for compilation and native tests on the user Intel Mac with Xcode'}
(root/'evidence/native-source-package.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
