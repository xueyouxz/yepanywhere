# Desktop Auto-Updater Basic Slice

Status: Implemented.

Progress:

- [x] 2026-06-09: Captured the first desktop updater slice and recorded the
  JSTorrent reference implementation.
- [x] 2026-06-09: Added startup, periodic, and manual Tauri update checks with
  install progress and relaunch.

## Reference

Use the JSTorrent desktop updater as the implementation reference for future
improvements:

- `~/code/jstorrent/desktop/tauri-app/src/updater.ts` — frontend update check,
  dialog, download progress, install, and relaunch.
- `~/code/jstorrent/desktop/tauri-app/src-tauri/src/lib.rs` — tray/menu
  `Check for Updates` item and `check-for-updates` event emission.
- `~/code/jstorrent/desktop/tauri-app/src-tauri/src/headless_updater.rs` —
  future reference for a no-UI `--check-update` / `--auto-update` mode.
- `~/code/jstorrent/.github/workflows/tauri-app-ci.yml` — release artifact and
  `latest.json` validation reference.
- `~/code/jstorrent/desktop/tauri-app/src-tauri/src/lib.rs` updater config
  tests — future reference for guarding endpoint/pubkey/artifact settings.

## Context

Yep Anywhere desktop already has the Tauri updater plugin, updater endpoint,
pubkey, capabilities, and CI artifact validation. What was missing was runtime
behavior: checking for updates, showing users what is available, installing,
and relaunching.

This work is separate from managed component updates:

- desktop shell updates use the Tauri updater;
- Yep server package updates need a managed-component update path;
- Claude Code and Codex CLI updates remain separate tool updates.

Do not silently update Codex CLI, Claude Code, or the installed Yep server
package as part of the Tauri app update flow.

## Goals

- Check for Tauri desktop app updates shortly after startup.
- Check periodically while the app is running.
- Add a tray action for a manual update check.
- Show a modal dialog when an update is available.
- Download and install through the Tauri updater plugin.
- Relaunch after successful install.
- Send a lightweight check-reason header so the update endpoint can distinguish
  startup, periodic, and manual checks.

## Non-Goals

- Do not implement headless updater mode in this slice.
- Do not add auto-install without user confirmation.
- Do not add managed component updates.
- Do not add per-install telemetry or analytics identifiers yet.
- Do not change updater endpoint defaults.

## Implementation Shape

1. Add a desktop `updater.ts` module modeled after JSTorrent:
   - listen for `check-for-updates`;
   - run a delayed startup check;
   - run a 24-hour periodic check;
   - call `check({ headers: { "X-Check-Reason": reason } })`;
   - show an update dialog with release notes;
   - call `downloadAndInstall` and show progress;
   - call `relaunch`.
2. Initialize the updater from `packages/desktop/src/main.tsx`.
3. Add `Check for Updates` to the tray menu and emit `check-for-updates`.

## Future Work

- Add endpoint/config tests similar to JSTorrent's updater guard tests.
- Add a headless updater mode if desktop needs background update checks outside
  the main UI process.
- Add a managed components screen for Yep server package, Claude Code, and
  Codex CLI updates.
- Add explicit telemetry policy and a stable check-for-update install id only
  after deciding what data is acceptable to send to the update endpoint.
