# Third-party notices

Termora bundles the following open-source components in its renderer.

## noVNC 1.7.0 — embedded VNC viewer

- License: Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/)
- Source: https://github.com/novnc/noVNC (npm package `@novnc/novnc@1.7.0`)
- Modification: at build time (`scripts/build.mjs`), one line of `core/util/browser.js` is
  changed so the H.264 decoder probe runs in the background instead of as a top-level
  `await`. The modified line is:

  ```js
  _checkWebCodecsH264DecodeSupport().then(value => { supportsWebCodecsH264Decode = value; });
  ```

  All other noVNC files are used unchanged.

## xterm.js — terminal emulator

- License: MIT. Packages `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-search`.

The license texts of bundled packages are also preserved as legal comments at the end of
`dist/renderer.js`.
