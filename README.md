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

Mac RDP sessions open inside a Termora tab. Enter the Windows username, domain
(if needed), and password in the connection's Basic settings. Saving a password
is optional and uses macOS Keychain. Passwords are never placed in helper
arguments or connection files. Unknown or changed server certificates still
require a trust decision inside Termora.

The embedded desktop supports keyboard/mouse, Ctrl+Alt+Del, fit-to-tab scaling,
view-only mode, fullscreen, reconnect and closing the session from its tab.
Clipboard transfer is one-way and happens only when the user clicks **Paste
clipboard** in that tab; there is no automatic local clipboard sharing or
server-to-local clipboard synchronization.

Use `npm run test:mac` for the shared Mac menus, settings and terminal checks,
and `npm run test:rdp` for the embedded RDP tab and private credential path.
`npm test` also exercises real TLS/NLA login, bitmap decoding, input, wrong
passwords and certificate rejection against a local-only test RDP server when
the native test helpers are built. Windows keeps its existing RDP launcher and
uses `npm run test:desktop` for Windows desktop UI checks.

Build the full Intel Electron installer with:

```sh
bash scripts/build-mac-port.sh
```

This produces `release/Termora-Workstation-macOS-Intel.dmg`, bundles FreeRDP,
checks its `/version`, signs the application locally, and verifies both the
staged app and the app mounted from the DMG, including embedded RDP tab checks.
The local TLS/NLA test server is compiled only for tests and is not shipped. The build requires a logged-in Mac
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
