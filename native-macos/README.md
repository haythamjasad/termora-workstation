# Termora Native — Swift/AppKit

This is a separate native macOS application written in Swift. All application windows, menus, sidebars, sheets, preferences and tab controls use AppKit. The terminal is SwiftTerm's AppKit/CoreText view. There is no Electron runtime, Node.js, HTML or CSS renderer.

**Build verification:** GitHub Actions compiles this project on macOS 15 Intel and runs core tests, native window/PTY tests, and a normal macOS app-launch check from the mounted DMG. Check the Actions result for the specific commit before treating an artifact as verified. RDP server interoperability requires a separate connection test.

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
- RDP uses a bundled FreeRDP SDL engine, with a graphical desktop window and authentication/output in a Termora tab. Windows App and Homebrew are not needed to run the packaged app.
- macOS Screen Sharing handles VNC, and the default browser handles web connections.
- Session JSON import/export and MobaXterm bookmark/full-backup import, including the previously inspected password-protected `_@` format. Saved-password vaults are excluded.
- Native preferences for automatic/light/dark appearance and terminal font size; reconnect, close-session confirmation, and Command-key menu shortcuts.

## Not yet ported

This first native implementation does not provide full feature parity with the existing Electron app. SFTP is an interactive terminal, not a graphical remote file browser. Embedding the RDP window inside a tab, embedded VNC, FTP/FTPS, S3, Mosh, Rsh/Rlogin, server management, tunnel management UI, macros, scheduling, advanced terminal search and an application-managed credential vault are not implemented here. Those features remain available in the separate Electron implementation.

## Data and compatibility

Native connections are stored separately in `~/Library/Application Support/TermoraNative/sessions.json` with owner-only permissions. The existing Electron application's data is not modified or silently migrated. Import its exported JSON file to copy supported connection identities. Passwords, private-key content and key passphrases are never part of native session exports.

The encrypted import test uses a synthetic fixture generated independently with Python cryptography. The real user's encrypted backup is not part of the repository and remains unverified without unlocking it in the application.

## Structure

- `Sources/TermoraCore`: session model, safe argument construction, persistence and configuration import.
- `Sources/TermoraNative`: AppKit application, window/sidebar, native sheets, preferences and SwiftTerm integration.
- `Tests/TermoraCoreTests`: argument safety, persistence, JSON handling and encrypted import tests.
- `Tools/MakeIcon.swift`: native AppKit icon generation during packaging.

SwiftTerm is pinned to version 1.10.1. Its license is in `THIRD-PARTY-NOTICES.md`. The main project uses the license in `LICENSE`.
