# Changelog

## [0.0.2] - 2026-06-01

### Added
- Windows local installer script for testing the desktop app from a normal per-user installation.
- Claude child-process diagnostics for Windows session startup failures.

### Fixed
- Desktop startup health probe and allowed-host handling for Windows Tauri origins.

## [0.0.1] - 2026-06-01

### Added
- Disposable desktop release for validating CI artifacts, signing fallback, and release publishing.

## [0.1.0] - Unreleased

### Added
- Initial desktop app with setup wizard
- Bundled Bun runtime for running Yep Anywhere server
- Agent installation (Claude Code, Codex CLI)
- System tray with server management
- Auto-start and window state persistence
- Auto-updater support
