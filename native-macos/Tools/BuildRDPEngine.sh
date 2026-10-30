#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
DEST="$ROOT/Builds/rdp-engine"
if [[ -x "$DEST/bin/sdl3-freerdp" ]]; then exit 0; fi
brew install cmake pkgconf openssl@3 sdl3 sdl3_ttf
SOURCE="$ROOT/Builds/FreeRDP-3.32.2"
if [[ ! -d "$SOURCE/.git" ]]; then
  git clone --depth 1 --branch 3.32.2 https://github.com/FreeRDP/FreeRDP.git "$SOURCE"
fi
cmake -S "$SOURCE" -B "$SOURCE/build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$DEST" \
  -DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DCMAKE_PREFIX_PATH="$(brew --prefix openssl@3);$(brew --prefix sdl3);$(brew --prefix sdl3_ttf)" \
  -DBUILD_SHARED_LIBS=ON -DWITH_CLIENT=ON -DWITH_CLIENT_SDL=ON \
  -DWITH_CLIENT_SDL2=OFF -DWITH_CLIENT_SDL3=ON -DWITH_CLIENT_MAC=OFF \
  -DWITH_X11=OFF -DWITH_WAYLAND=OFF -DWITH_SERVER=OFF -DWITH_SHADOW=OFF \
  -DWITH_FFMPEG=OFF -DWITH_DSP_FFMPEG=OFF -DWITH_VIDEO_FFMPEG=OFF -DWITH_SWSCALE=OFF \
  -DWITH_OPENH264=OFF -DWITH_MANPAGES=OFF -DWITH_WEBVIEW=OFF \
  -DWITH_PCSC=OFF -DWITH_CUPS=OFF -DWITH_FUSE=OFF -DWITH_LIBUSB=OFF \
  -DWITH_FIDO=OFF -DWITH_KRB5=OFF -DWITH_AAD=OFF -DWITH_SAMPLE=OFF \
  -DWITH_JPEG=OFF -DBUILD_TESTING=OFF -DWITH_ABSOLUTE_PLUGIN_LOAD_PATHS=OFF
cmake --build "$SOURCE/build" --parallel 3
cmake --install "$SOURCE/build"
"$DEST/bin/sdl3-freerdp" /version
