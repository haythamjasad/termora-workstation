"""Copy the RDP client and its dylib closure into an independent app bundle."""
import pathlib, re, shutil, subprocess, sys

root, app = map(pathlib.Path, sys.argv[1:])
source = root / 'Builds/rdp-engine/bin/sdl3-freerdp'
helper = app / 'Contents/Helpers/TermoraRDP'
libraries = app / 'Contents/Frameworks/FreeRDP'
helper.parent.mkdir(parents=True, exist_ok=True)
libraries.mkdir(parents=True, exist_ok=True)
copied = {}

def output(*args):
    return subprocess.check_output(args, text=True)

def bundle(original, target):
    original = original.resolve()
    if target in copied:
        if copied[target] != original:
            raise RuntimeError(f'Conflicting library names: {original}, {copied[target]}')
        return
    copied[target] = original
    shutil.copy2(original, target)
    target.chmod(0o755)
    rpaths = re.findall(r'path (.+) \(offset', output('otool', '-l', str(original)))
    for line in output('otool', '-L', str(original)).splitlines()[1:]:
        dependency = line.strip().split(' (', 1)[0]
        if dependency.startswith(('/System/', '/usr/lib/')):
            continue
        if dependency == str(original) or dependency.endswith('/' + original.name) and target != helper:
            continue
        candidates = [pathlib.Path(dependency)]
        if dependency.startswith('@loader_path/'):
            candidates = [original.parent / dependency.removeprefix('@loader_path/')]
        if dependency.startswith('@rpath/'):
            suffix = dependency.removeprefix('@rpath/')
            candidates = [pathlib.Path(p.replace('@loader_path', str(original.parent))) / suffix for p in rpaths]
            candidates += [root / 'Builds/rdp-engine/lib' / suffix, pathlib.Path('/usr/local/lib') / suffix, pathlib.Path('/opt/local/lib') / suffix]
        resolved = next((p for p in candidates if p.is_file()), None)
        if resolved is None:
            raise RuntimeError(f'Unresolved dependency {dependency} in {original}')
        destination = libraries / resolved.name
        bundle(resolved, destination)
        replacement = ('@loader_path/../Frameworks/FreeRDP/' if target == helper else '@loader_path/') + destination.name
        subprocess.run(['install_name_tool', '-change', dependency, replacement, str(target)], check=True)
    if target != helper:
        subprocess.run(['install_name_tool', '-id', '@rpath/' + target.name, str(target)], check=True)

bundle(source, helper)
for binary in copied:
    subprocess.run(['codesign', '--force', '--sign', '-', '--timestamp=none', str(binary)], check=True)
    linked = output('otool', '-L', str(binary))
    if '/usr/local/' in linked or '/opt/homebrew/' in linked or '/opt/local/' in linked or str(root) in linked:
        raise RuntimeError(f'External build-machine dependency in {binary}: {linked}')
resources = app / 'Contents/Resources/RDP-Licenses'
resources.mkdir(parents=True, exist_ok=True)
shutil.copytree(root / 'Tools/RDP-Licenses', resources / 'Upstream', dirs_exist_ok=True)
for formula in (['openssl@3', 'sdl3', 'sdl3_ttf', 'freetype', 'harfbuzz', 'brotli', 'libpng', 'graphite2', 'glib', 'pcre2', 'gettext'] if shutil.which('brew') else []):
    result = subprocess.run(['brew', '--prefix', formula], capture_output=True, text=True)
    if result.returncode == 0:
        prefix = pathlib.Path(result.stdout.strip())
        for name in ['LICENSE', 'LICENSE.txt', 'COPYING', 'COPYING.txt', 'NOTICE']:
            if (prefix / name).is_file():
                shutil.copy2(prefix / name, resources / (formula + '-' + name))
# MacPorts puts dependency license notices in share/doc (and share/licenses
# for ports that use it). Preserve their directory structure in the app.
for directory in ['doc', 'licenses']:
    base = pathlib.Path('/opt/local/share') / directory
    for package in ['openssl3', 'SDL3', 'SDL3_ttf', 'freetype', 'harfbuzz', 'brotli', 'libpng', 'graphite2', 'glib2', 'pcre2', 'gettext', 'zlib']:
        source_dir = base / package
        if source_dir.is_dir():
            for source_file in source_dir.rglob('*'):
                if source_file.is_file() and re.match(r'(?i)^(licen[cs]e|copying|copyright|notice|ftl\.txt|gplv2\.txt)', source_file.name):
                    destination = resources / 'MacPorts' / package / source_file.relative_to(source_dir)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_file, destination)
shutil.copy2(root / 'Builds/FreeRDP-3.32.2/LICENSE', resources / 'FreeRDP-LICENSE')
print(f'Bundled RDP engine and {len(copied)-1} libraries')
