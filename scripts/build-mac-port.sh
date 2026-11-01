#!/bin/bash
set -euo pipefail
npm ci
bash native-macos/Tools/BuildRDPEngine.sh
bash native-macos/Tools/BuildRDPBridge.sh
bash native-macos/Tools/BuildRDPFixture.sh
npm test
npm run package:mac
node scripts/verify-mac.mjs
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/termora-electron-port.XXXXXX")"
ditto -x -k release/Termora-darwin-x64.zip "$STAGE"
APP="$STAGE/Termora.app"
python3 native-macos/Tools/BundleRDPEngine.py "$PWD/native-macos" "$APP"
lipo "$APP/Contents/Helpers/TermoraRDP" -verify_arch x86_64
"$APP/Contents/Helpers/TermoraRDP" /version
"$APP/Contents/Helpers/TermoraRDPBridge" /version
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
TERMORA_VERIFY_EXECUTABLE="$APP/Contents/MacOS/Electron" node scripts/verify-mac-port.mjs
TERMORA_VERIFY_EXECUTABLE="$APP/Contents/MacOS/Electron" node scripts/verify-embedded-rdp.mjs
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
codesign --verify --deep --strict "$MOUNT/Termora.app"
lipo "$MOUNT/Termora.app/Contents/Helpers/TermoraRDP" -verify_arch x86_64
"$MOUNT/Termora.app/Contents/Helpers/TermoraRDP" /version
TERMORA_VERIFY_EXECUTABLE="$MOUNT/Termora.app/Contents/MacOS/Electron" node scripts/verify-mac-port.mjs
TERMORA_VERIFY_EXECUTABLE="$MOUNT/Termora.app/Contents/MacOS/Electron" node scripts/verify-embedded-rdp.mjs
shasum -a 256 release/Termora-Workstation-macOS-Intel.dmg
