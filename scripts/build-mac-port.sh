#!/bin/bash
set -euo pipefail
npm ci
npm test
npm run package:mac
bash 'native-macos/Tools/BuildRDPEngine.sh'
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/termora-electron-port.XXXXXX")"
ditto -x -k release/Termora-darwin-x64.zip "$STAGE"
APP="$STAGE/Termora.app"
python3 native-macos/Tools/BundleRDPEngine.py "$PWD/native-macos" "$APP"
"$APP/Contents/Helpers/TermoraRDP" /version
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
TERMORA_VERIFY_EXECUTABLE="$APP/Contents/MacOS/Electron" node scripts/verify-mac-port.mjs
DMGSTAGE="$STAGE/image"
mkdir -p "$DMGSTAGE"
ditto "$APP" "$DMGSTAGE/Termora.app"
ln -s /Applications "$DMGSTAGE/Applications"
hdiutil create -volname Termora -srcfolder "$DMGSTAGE" -ov -format UDZO release/Termora-Workstation-macOS-Intel.dmg
hdiutil verify release/Termora-Workstation-macOS-Intel.dmg
MOUNT="$STAGE/mounted"
mkdir -p "$MOUNT"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" release/Termora-Workstation-macOS-Intel.dmg
trap 'hdiutil detach "$MOUNT" >/dev/null 2>&1 || true' EXIT
TERMORA_VERIFY_EXECUTABLE="$MOUNT/Termora.app/Contents/MacOS/Electron" node scripts/verify-mac-port.mjs
shasum -a 256 release/Termora-Workstation-macOS-Intel.dmg
