#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
cd "$ROOT"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Build this Swift/AppKit application on your Mac with Xcode installed."
  exit 1
fi
mkdir -p "$ROOT/Builds"
LOG="$ROOT/Builds/build.log"
exec > >(tee "$LOG") 2>&1
echo "Termora Native — Swift/AppKit Intel build"
# A standalone Command Line Tools Swift compiler does not provide XCTest.
# Select full Xcode for this process only; leave the system selection alone.
SELECTED_DEVELOPER="${DEVELOPER_DIR:-$(/usr/bin/xcode-select --print-path 2>/dev/null || true)}"
XCODE_DEVELOPER=""
for candidate in "$SELECTED_DEVELOPER" /Applications/Xcode.app/Contents/Developer /Applications/Xcode*.app/Contents/Developer "$HOME"/Applications/Xcode*.app/Contents/Developer; do
  candidate="${candidate%/}"
  if [[ "$candidate" == *.app ]]; then candidate="$candidate/Contents/Developer"; fi
  if [[ -d "$candidate/Platforms/MacOSX.platform/Developer/Library/Frameworks/XCTest.framework" ]] &&
     DEVELOPER_DIR="$candidate" /usr/bin/xcrun --find swift >/dev/null 2>&1; then
    XCODE_DEVELOPER="$candidate"
    break
  fi
done
if [[ -z "$XCODE_DEVELOPER" ]]; then
  echo "Full Xcode with XCTest was not found. The standalone Command Line Tools are insufficient."
  echo "Install/open Xcode 15 or later, complete its first-launch setup, then run this installer again."
  echo "For Xcode in another folder, choose it in Xcode > Settings > Locations > Command Line Tools."
  exit 1
fi
export DEVELOPER_DIR="$XCODE_DEVELOPER"
SDKROOT="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)"
export SDKROOT
echo "Using Xcode: $DEVELOPER_DIR"
/usr/bin/xcrun xcodebuild -version
xcrun swift --version
echo "Checking XCTest before downloading dependencies..."
printf 'import XCTest\n' > "$ROOT/Builds/XCTestProbe.swift"
/usr/bin/xcrun swiftc -typecheck -target x86_64-apple-macosx13.0 \
  -sdk "$SDKROOT" \
  -F "$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/Library/Frameworks" \
  "$ROOT/Builds/XCTestProbe.swift"
echo "Resolving the pinned SwiftTerm dependency..."
xcrun swift package resolve
echo "Running native core tests..."
xcrun swift test --arch x86_64
echo "Building Intel executable..."
xcrun swift build --configuration release --arch x86_64 --product TermoraNative
BIN="$(xcrun swift build --configuration release --arch x86_64 --show-bin-path)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/termora-native-build.XXXXXX")"
cleanup() {
  case "$WORK" in "${TMPDIR:-/tmp}"/termora-native-build.*) rm -rf "$WORK" ;; esac
}
trap cleanup EXIT
APP="$WORK/Termora Native.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/TermoraNative" "$APP/Contents/MacOS/TermoraNative"
chmod 755 "$APP/Contents/MacOS/TermoraNative"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Termora Native</string>
<key>CFBundleDisplayName</key><string>Termora Native</string>
<key>CFBundleIdentifier</key><string>org.termora.native</string>
<key>CFBundleExecutable</key><string>TermoraNative</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>CFBundleIconFile</key><string>Termora</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSLocalNetworkUsageDescription</key><string>Connect to SSH, SFTP and desktop servers on your local network.</string>
</dict></plist>
PLIST
plutil -lint "$APP/Contents/Info.plist"
xcrun swift "$ROOT/Tools/MakeIcon.swift" "$WORK/Termora.iconset"
iconutil -c icns "$WORK/Termora.iconset" -o "$APP/Contents/Resources/Termora.icns"
cp "$ROOT/LICENSE" "$APP/Contents/Resources/LICENSE.txt"
cp "$ROOT/THIRD-PARTY-NOTICES.md" "$APP/Contents/Resources/THIRD-PARTY-NOTICES.md"
lipo -verify_arch x86_64 "$APP/Contents/MacOS/TermoraNative"
codesign --force --sign "${TERMORA_SIGNING_IDENTITY:--}" --timestamp=none "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
mkdir -p "$WORK/test-data"
echo "Checking the native window and a real local PTY round-trip..."
TERMORA_NATIVE_SMOKE_DATA="$WORK/test-data" "$APP/Contents/MacOS/TermoraNative" --smoke-test
RESULT="$ROOT/Builds/Termora Native.app"
if [[ -e "$RESULT" ]]; then mv "$RESULT" "$ROOT/Builds/Termora Native.previous.$(date +%Y%m%d%H%M%S).app"; fi
ditto "$APP" "$RESULT"
STAGE="$WORK/dmg"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Termora Native.app"
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/README.md" "$STAGE/Read Me First.md"
DMG="$ROOT/Builds/Termora-Native-0.1.0-macOS-Intel.dmg"
hdiutil create -volname "Termora Native" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
hdiutil verify "$DMG"
echo "Build, tests, native PTY smoke check and signing verification passed."
echo "App: $RESULT"
echo "DMG: $DMG"
if [[ "${TERMORA_NATIVE_NO_REVEAL:-0}" != 1 ]]; then open -R "$DMG"; fi
