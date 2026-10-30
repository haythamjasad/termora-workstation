"""Independent ad-hoc signature checks, adapted from the PuTTY build verifier."""
import hashlib
import json
import math
import pathlib
import plistlib
import struct
import sys

root = pathlib.Path(__file__).resolve().parents[1]
app = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else root / 'release/mac-sign/signed-ready/Termora.app'
digests = {}
results = []

def slices(data):
    if data[:4] in (b'\xcf\xfa\xed\xfe',b'\xce\xfa\xed\xfe'):
        return [data]
    if data[:4] in (b'\xca\xfe\xba\xbe',b'\xca\xfe\xba\xbf'):
        wide = data[:4] == b'\xca\xfe\xba\xbf'
        return [data[offset:offset+size] for offset,size in [struct.unpack_from('>QQ' if wide else '>II',data,8+n*(32 if wide else 20)+8) for n in range(struct.unpack_from('>I',data,4)[0])]]
    return []

def contexts(file):
    if file.parent.name == 'MacOS':
        base = file.parent.parent
        return base/'Info.plist',base/'_CodeSignature/CodeResources'
    return file.parent/'Resources/Info.plist',file.parent/'_CodeSignature/CodeResources'

for file in app.rglob('*'):
    if not file.is_file():continue
    with file.open('rb') as stream: magic=stream.read(4)
    if magic not in (b'\xcf\xfa\xed\xfe',b'\xce\xfa\xed\xfe',b'\xca\xfe\xba\xbe',b'\xca\xfe\xba\xbf'):continue
    values=[];pages=0
    for data in slices(file.read_bytes()):
        at=32 if data[:4]==b'\xcf\xfa\xed\xfe' else 28
        signature=None
        for _ in range(struct.unpack_from('<I',data,16)[0]):
            command,length=struct.unpack_from('<II',data,at)
            assert length>=8
            if command==0x1d:
                offset,size=struct.unpack_from('<II',data,at+8);signature=data[offset:offset+size]
            at+=length
        assert signature and struct.unpack_from('>I',signature)[0]==0xfade0cc0,file
        blobs={}
        for n in range(struct.unpack_from('>I',signature,8)[0]):
            slot,offset=struct.unpack_from('>II',signature,12+n*8);length=struct.unpack_from('>I',signature,offset+4)[0];blobs[slot]=signature[offset:offset+length]
        for slot,directory in blobs.items():
            if struct.unpack_from('>I',directory)[0]!=0xfade0c02:continue
            flags,hash_offset,_,special,count,limit=struct.unpack_from('>IIIIII',directory,12)
            assert flags&2,'Not ad-hoc signed: '+str(file)
            size,kind,_,exponent=struct.unpack_from('BBBB',directory,36)
            name={1:'sha1',2:'sha256',3:'sha256',4:'sha384'}[kind]
            digest=lambda payload:hashlib.new(name,payload).digest()[:size]
            page_size=(1<<exponent) if exponent else limit
            assert count==math.ceil(limit/page_size)
            for n in range(count):
                assert digest(data[n*page_size:min((n+1)*page_size,limit)])==directory[hash_offset+n*size:hash_offset+(n+1)*size],str(file)+' page '+str(n)
                pages+=1
            for n in range(1,special+1):
                expected=directory[hash_offset-n*size:hash_offset-(n-1)*size]
                if not any(expected):continue
                payload=blobs.get(n)
                info,resources=contexts(file)
                if n==1 and info.exists():payload=info.read_bytes()
                if n==3 and resources.exists():payload=resources.read_bytes()
                if payload is not None:assert digest(payload)==expected,str(file)+' special slot '+str(n)
            values.append(hashlib.new(name,directory).digest()[:20])
    assert pages>0
    digests[file.resolve()]=values
    results.append({'path':file.relative_to(app).as_posix(),'pagesVerified':pages})

def main_binary(bundle):
    if bundle.is_file():return bundle
    if bundle.suffix=='.framework':
        base=bundle/'Versions/Current'
        info=base/'Resources/Info.plist'
    else:
        base=bundle/'Contents/MacOS';info=bundle/'Contents/Info.plist'
    return base/plistlib.loads(info.read_bytes())['CFBundleExecutable']

resources=0;nested=0
for seal in app.rglob('CodeResources'):
    if seal.parent.name!='_CodeSignature':continue
    base=seal.parent.parent
    for relative,record in plistlib.loads(seal.read_bytes()).get('files2',{}).items():
        target=base/relative
        if 'hash2' in record:
            assert hashlib.sha256(target.read_bytes()).digest()==record['hash2'],target
            resources+=1
        if 'cdhash' in record:
            binary=main_binary(target).resolve()
            assert record['cdhash'] in digests[binary],target
            nested+=1
report={'signing':'ad-hoc, same rcodesign tool as the PuTTY package','notarized':False,'macOSRuntimeTested':False,'machOFilesVerified':len(results),'sealedResourceHashesVerified':resources,'nestedCodeHashesVerified':nested,'binaries':results}
report_path = pathlib.Path(sys.argv[2]) if len(sys.argv)>2 else root/'evidence/mac-signed-verification.json'
report_path.write_text(json.dumps(report,indent=2)+'\n')
print('Verified',len(results),'Mach-O signatures,',resources,'resource hashes and',nested,'nested-code hashes')
