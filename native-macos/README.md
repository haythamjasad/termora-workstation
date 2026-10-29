# Termora Native — Swift/AppKit

This is a separate native macOS application written in Swift. All application windows, menus, sidebars, sheets, preferences and tab controls use AppKit. The terminal is SwiftTerm's AppKit/CoreText view. There is no Electron runtime, Node.js, HTML or CSS renderer.

**Status:** source prepared and Swift grammar checked on Windows. It has not yet been compiled or run with Xcode. Do not treat this source package as a verified binary release. The included Mac builder performs compilation, tests, signing verification and a real native PTY smoke test before producing the DMG.

## Build on your Intel Mac

Requirements: macOS 13+, Xcode 15+ with its initial setup completed, and an Internet connection for Swift Package Manager. Xcode 16 on Sequoia is supported by the project's declared Swift 5.9 tools/language version, but compilation still needs to be verified on that Mac.

1. Extract the source ZIP into Downloads. The extracted folder is `TermoraNative`.
2. Open Terminal and run:

   ```bash
   cd "$HOME/Downloads/TermoraNative"
   bash "Build Native Mac.command"
   ```

3. The script fetches the pinned SwiftTerm dependency, runs six core tests, builds an Intel executable, generates the app icon, signs using macOS `codesign`, verifies the signature, and starts an isolated test window. That window tests a local `/bin/sh` PTY round-trip and then exits.
4. On success, Finder reveals `Builds/Termora-Native-0.1.0-macOS-Intel.dmg`. Open it and drag **Termora Native.app** into Applications.

If a build or test fails, the script stops and retains the complete output in `Builds/build.log`. Send that log to continue fixing compilation/runtime issues. It does not produce a success message or a new installer after a failed check.

You can also open `Package.swift` in Xcode, select the `TermoraNative` scheme and **My Mac**, and run it. Use the builder above to produce the distributable `.app` and DMG. The project defaults to local ad-hoc signing; it is not Apple-notarized. A configured signing identity can be selected explicitly with `TERMORA_SIGNING_IDENTITY`.

## Implemented in the native source

- Native resizable Mac window, traffic-light controls, unified toolbar, standard macOS menu bar and system appearance.
- Native source-list sidebar with folders, connection search, save/edit/delete, and terminal tabs.
- Local login-shell PTYs, SSH and SFTP sessions using macOS OpenSSH, and serial sessions through `/usr/bin/screen` when available.
- SSH key selection, jump host, compression, optional X11 forwarding to installed XQuartz, and interactive OpenSSH host-key verification.
- Passwords and key passphrases are entered interactively inside the terminal. The app does not request Keychain access on startup or store authentication secrets.
- macOS Screen Sharing for VNC, installed Windows App for RDP, and the default browser for web connections. These launch external native applications.
- Session JSON import/export and MobaXterm bookmark/full-backup import, including the previously inspected password-protected `_@` format. Saved-password vaults are excluded.
- Native preferences for automatic/light/dark appearance and terminal font size; reconnect, close-session confirmation, and Command-key menu shortcuts.

## Not yet ported

This first native implementation does not provide full feature parity with the existing Electron app. SFTP is an interactive terminal, not a graphical remote file browser. Embedded RDP/VNC, FTP/FTPS, S3, Mosh, Rsh/Rlogin, server management, tunnel management UI, macros, scheduling, advanced terminal search and an application-managed credential vault are not implemented here. Those features remain available in the separate Electron implementation.

## Data and compatibility

Native connections are stored separately in `~/Library/Application Support/TermoraNative/sessions.json` with owner-only permissions. The existing Electron application's data is not modified or silently migrated. Import its exported JSON file to copy supported connection identities. Passwords, private-key content and key passphrases are never part of native session exports.

The encrypted import test uses a synthetic fixture generated independently with Python cryptography. The real user's encrypted backup is not part of the repository and remains unverified without unlocking it in the application.

## Structure

- `Sources/TermoraCore`: session model, safe argument construction, persistence and configuration import.
- `Sources/TermoraNative`: AppKit application, window/sidebar, native sheets, preferences and SwiftTerm integration.
- `Tests/TermoraCoreTests`: argument safety, persistence, JSON handling and encrypted import tests.
- `Tools/MakeIcon.swift`: native AppKit icon generation during packaging.

SwiftTerm is pinned to version 1.10.1. Its license is in `THIRD-PARTY-NOTICES.md`. The main project uses the license in `LICENSE`.
