#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
DEST="$ROOT/Builds/rdp-engine"
if [[ -x "$DEST/bin/sdl3-freerdp" ]]; then exit 0; fi
if [[ -x /opt/local/bin/port ]]; then
  # MacPorts continues to provide Intel Sequoia packages. Install dependencies
  # separately so this build never prompts for administrator credentials.
  export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
  PREFIXES="/opt/local/libexec/openssl3;/opt/local"
  if ! command -v cmake >/dev/null || ! command -v pkg-config >/dev/null; then
    echo "Install MacPorts dependencies: sudo /opt/local/bin/port install cmake pkgconfig openssl3 SDL3 SDL3_ttf" >&2
    exit 1
  fi
elif command -v brew >/dev/null; then
  brew install cmake pkgconf openssl@3 sdl3 sdl3_ttf
  PREFIXES="$(brew --prefix openssl@3);$(brew --prefix sdl3);$(brew --prefix sdl3_ttf)"
else
  echo "Install MacPorts and run: sudo /opt/local/bin/port install cmake pkgconfig openssl3 SDL3 SDL3_ttf" >&2
  exit 1
fi
SOURCE="$ROOT/Builds/FreeRDP-3.32.2"
if [[ ! -d "$SOURCE/.git" ]]; then
  git clone --depth 1 --branch 3.32.2 https://github.com/FreeRDP/FreeRDP.git "$SOURCE"
fi
cmake -S "$SOURCE" -B "$SOURCE/build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$DEST" \
  -DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DCMAKE_PREFIX_PATH="$PREFIXES" \
  -DBUILD_SHARED_LIBS=ON -DWITH_CLIENT=ON -DWITH_CLIENT_SDL=ON \
  -DWITH_CLIENT_SDL2=OFF -DWITH_CLIENT_SDL3=ON -DWITH_CLIENT_MAC=OFF \
  -DWITH_X11=OFF -DWITH_WAYLAND=OFF -DWITH_SERVER=OFF -DWITH_SHADOW=OFF \
  -DWITH_FFMPEG=OFF -DWITH_DSP_FFMPEG=OFF -DWITH_VIDEO_FFMPEG=OFF -DWITH_SWSCALE=OFF \
  -DWITH_OPENH264=OFF -DWITH_MANPAGES=OFF -DWITH_WEBVIEW=OFF \
  -DWITH_PCSC=OFF -DWITH_CUPS=OFF -DWITH_FUSE=OFF -DWITH_LIBUSB=OFF \
  -DCHANNEL_URBDRC=OFF -DCHANNEL_URBDRC_CLIENT=OFF \
  -DWITH_FIDO=OFF -DWITH_KRB5=OFF -DWITH_AAD=OFF -DWITH_SAMPLE=OFF \
  -DWITH_JPEG=OFF -DBUILD_TESTING=OFF -DWITH_ABSOLUTE_PLUGIN_LOAD_PATHS=OFF
cmake --build "$SOURCE/build" --parallel 3
cmake --install "$SOURCE/build"
CLIENT="$(find "$DEST/bin" -type f -name 'sdl*freerdp*' -print -quit)"
if [[ -z "$CLIENT" ]]; then echo "The SDL RDP client was not installed."; exit 1; fi
if [[ "$CLIENT" != "$DEST/bin/sdl3-freerdp" ]]; then cp "$CLIENT" "$DEST/bin/sdl3-freerdp"; fi
"$DEST/bin/sdl3-freerdp" /version
