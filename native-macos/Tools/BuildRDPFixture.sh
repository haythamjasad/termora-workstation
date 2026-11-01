#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
export PKG_CONFIG_PATH="$ROOT/Builds/rdp-engine/lib/pkgconfig:/opt/local/libexec/openssl3/lib/pkgconfig:/opt/local/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
cc -std=c11 -O2 -Wno-deprecated-declarations "$ROOT/../tests/native/rdp-fixture.c" \
  $(pkg-config --cflags --libs freerdp3 winpr3) -Wl,-rpath,"$ROOT/Builds/rdp-engine/lib" -o "$ROOT/Builds/rdp-fixture"
