# Termora Workstation

Electron terminal and remote-session workstation for Windows and Intel macOS.
The shared backend and renderer live in `lib/`, `extensions/`, `electron/` and
`src/`. The Swift/AppKit prototype in `native-macos/` is incomplete and does not
replace the Electron application. The Electron Mac build reuses its FreeRDP
build and bundling tools.

## Intel macOS development

Use Node.js 24 and Apple Command Line Tools. Install MacPorts for macOS Sequoia,
then install the FreeRDP build dependencies:

```sh
sudo /opt/local/bin/port install cmake pkgconfig openssl3 SDL3 SDL3_ttf
npm ci
npm test
npm start
```

Existing Homebrew installations remain supported by the RDP build tools.
The current Homebrew installer does not support Intel Macs.

Run `npm run test:mac` to build and verify the source Electron app with an
isolated, temporary workspace. It checks native menu routing in the main and
detached windows, SSH settings, saved appearance, real shell input/output,
multiple tabs and split panes. Windows desktop UI checks use
`npm run test:desktop` on Windows.

Build the full Intel Electron installer with:

```sh
bash scripts/build-mac-port.sh
```

This produces `release/Termora-Workstation-macOS-Intel.dmg`, bundles FreeRDP,
checks its `/version`, signs the application locally, and verifies both the
staged app and the app mounted from the DMG. RDP verification also makes a
loopback connection attempt with the bundled OpenSSL legacy provider and checks
that connection failures reach the UI. The build requires a logged-in Mac
desktop for its UI checks. The local signature is ad hoc, not a Developer ID
signature or notarization.

Mac startup does not access Keychain. macOS may request authorization when you
explicitly save a password or connect using a saved credential. Locally signed
builds can trigger another authorization prompt after updates; consistent
Developer ID signing is required for a stable application identity. See
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

To verify another completed Mac bundle, set `TERMORA_VERIFY_EXECUTABLE` to its
`Termora.app/Contents/MacOS/Electron` and run `npm run test:mac`. Packaged
verification requires a detected bundled RDP helper.

Build output alone does not establish that the packaged application or mounted
DMG has passed runtime verification.
