"""Stage the Intel bundle for the same Windows rcodesign used by PuTTY.

Windows cannot create relative Unix symlinks without extra privileges here.
Materialize framework aliases as ordinary files/directories before signing;
the full versioned paths remain present and every resulting file is sealed.
"""
import json
import pathlib
import posixpath
import stat
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
stage = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else root / 'release' / 'mac-sign' / 'input'
if not stage.is_relative_to((root/'release/mac-sign').resolve()):
    raise RuntimeError('Signing stage must be inside release/mac-sign')
if stage.exists():
    raise RuntimeError('Signing stage already exists; use a fresh stage directory.')
stage.mkdir(parents=True)
with zipfile.ZipFile(root / 'release/Termora-darwin-x64.zip') as archive:
    members = {item.filename.rstrip('/'): item for item in archive.infolist() if item.filename.startswith('Termora.app/')}
    links = {name: posixpath.normpath(posixpath.join(posixpath.dirname(name), archive.read(item).decode())) for name, item in members.items() if stat.S_ISLNK(item.external_attr >> 16)}
    modes = {}
    def resolve(name):
        for _ in range(40):
            parts = name.split('/')
            for length in range(1,len(parts)+1):
                prefix = '/'.join(parts[:length])
                if prefix in links:
                    name = posixpath.join(links[prefix],*parts[length:])
                    break
            else:
                return name
        raise RuntimeError('Cyclic bundle alias')
    def write(name, item):
        target = stage / name
        if not target.resolve().is_relative_to(stage.resolve()):
            raise RuntimeError('Bundle member escapes stage')
        mode = item.external_attr >> 16
        if item.is_dir():
            target.mkdir(parents=True,exist_ok=True)
            return
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(archive.read(item))
        modes[name] = mode & 0o777
    for name,item in members.items():
        if name not in links:
            write(name,item)
    for alias in links:
        original = resolve(alias)
        if original in members and not members[original].is_dir():
            write(alias,members[original])
        else:
            for name,item in members.items():
                if name.startswith(original+'/') and name not in links:
                    write(alias+name[len(original):],item)
    (stage.parent/'file-modes.json').write_text(json.dumps(modes,indent=2))
print('Staged Intel app with',len(modes),'files; materialized',len(links),'framework aliases')
