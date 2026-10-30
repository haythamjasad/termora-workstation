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
"$APP/Contents/Helpers/TermoraRDP" /version
codesign --verify --deep --strict --verbose=2 "$APP"
lipo "$APP/Contents/MacOS/TermoraNative" -verify_arch x86_64
echo "Testing the packaged native window and local terminal..."
TERMORA_NATIVE_SMOKE_DATA="$WORK/test-data" "$APP/Contents/MacOS/TermoraNative" --smoke-test
echo "The application inside the DMG passed its native window and PTY smoke test."
echo "Testing normal macOS application launch through Launch Services..."
mkdir -p "$WORK/finder-test-data"
open -n "$APP" --args --smoke-test --smoke-test-data "$WORK/finder-test-data"
for _ in {1..30}; do
  if [[ -f "$WORK/finder-test-data/smoke-result.txt" ]]; then break; fi
  sleep 1
done
if [[ ! -f "$WORK/finder-test-data/smoke-result.txt" ]] || [[ "$(cat "$WORK/finder-test-data/smoke-result.txt")" != PASS ]]; then
  echo "FAIL Normal macOS application launch did not complete the native terminal test."
  exit 1
fi
echo "PASS Normal macOS application launch and native terminal."
shasum -a 256 "$DMG"
