# Termora Workstation

Native Swift/AppKit terminal application for Intel macOS.

The source is in `native-macos/`. GitHub Actions builds on macOS 15 Intel, runs core tests and a native window/PTY smoke test, then mounts the completed DMG and tests its bundled app. A DMG artifact is uploaded only after these checks pass.

The first native implementation is not yet feature-complete. See `native-macos/README.md` for its scope. Build status must be checked in Actions; source upload alone does not establish a working release.
