#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
ENGINE="$ROOT/Builds/rdp-engine"
export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
export PKG_CONFIG_PATH="$ENGINE/lib/pkgconfig:/opt/local/libexec/openssl3/lib/pkgconfig:/opt/local/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
cc -std=c11 -O2 -Wall -Wextra -Wno-deprecated-declarations -arch x86_64 -mmacosx-version-min=13.0 \
  "$ROOT/RDPBridge/main.c" $(pkg-config --cflags --libs freerdp-client3 winpr3) \
  -Wl,-headerpad_max_install_names -Wl,-rpath,@loader_path/../lib -o "$ENGINE/bin/termora-rdp-bridge"
"$ENGINE/bin/termora-rdp-bridge" /version
