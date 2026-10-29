#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
DMG="$ROOT/Builds/Termora-Native-0.1.0-macOS-Intel.dmg"
exec > >(tee "$ROOT/Builds/disk-image-test.log") 2>&1
WORK="$(mktemp -d "${TMPDIR:-/tmp}/termora-dmg-check.XXXXXX")"
MOUNT="$WORK/mounted"
mkdir -p "$MOUNT" "$WORK/test-data"
cleanup() {
  hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
  # Remove only our own temporary directory, after detaching the disk image.
  if ! mount | grep -F " on $MOUNT (" >/dev/null; then
    case "$WORK" in "${TMPDIR:-/tmp}"/termora-dmg-check.*) rm -rf "$WORK" ;; esac
  fi
}
trap cleanup EXIT
hdiutil verify "$DMG"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" "$DMG"
APP="$MOUNT/Termora Native.app"
codesign --verify --deep --strict --verbose=2 "$APP"
lipo -verify_arch x86_64 "$APP/Contents/MacOS/TermoraNative"
echo "Testing the packaged native window and local terminal..."
TERMORA_NATIVE_SMOKE_DATA="$WORK/test-data" "$APP/Contents/MacOS/TermoraNative" --smoke-test
echo "The application inside the DMG passed its native window and PTY smoke test."
shasum -a 256 "$DMG"
