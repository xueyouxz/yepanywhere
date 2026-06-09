# Desktop Surfaces And Server Output

Status: Implemented.

Progress:

- [x] 2026-06-09: Captured the first-class desktop surface model and server
  output implementation shape.
- [x] 2026-06-09: Implemented startup-view selection, setup repair access,
  in-app server output, output buffering, and hidden Windows sidecar consoles.

## Context

The desktop app has grown beyond a tray-only launcher. It now has three
user-facing surfaces:

- setup and repair flow for installing Yep Anywhere and agent CLIs;
- Yep Anywhere dashboard webview served by the local server;
- server output console for users who mainly run the desktop app as a local
  server and remote-access enabler.

The server child process is currently spawned by Tauri without explicit
stdout/stderr handling. That creates platform drift: Windows can show a native
console window for the Bun sidecar, while macOS has no visible server output at
all.

## Goals

- Treat setup, dashboard, and server output as first-class desktop surfaces.
- Let users choose the startup surface: dashboard, server output, or tray only.
- Hide accidental native server console windows on Windows.
- Capture server stdout/stderr while the server runs, even when no output
  window is open.
- Render recent and live server output consistently on every platform.
- Let users rerun setup as a non-destructive repair flow from the tray.

## Non-Goals

- Do not launch Terminal.app, cmd.exe, or PowerShell as the primary output
  surface.
- Do not make the server output window interactive or pass stdin to the server.
- Do not delete sessions, auth state, relay settings, or desktop data when the
  setup flow is rerun.
- Do not add unbounded output buffering.

## Surface Model

### Setup

The setup flow remains a Tauri-hosted React view. First launch opens setup.
After first launch, the tray exposes `Setup / Repair` so users can re-check or
reinstall desktop-managed components.

The repair path should preserve existing configuration unless the user changes
it. Completion saves the current config and starts the server only if it is not
already running.

### Dashboard

The dashboard surface is a Tauri webview that waits for the server port/token,
then navigates to the local Yep Anywhere server URL. It remains the right
surface for users who want to interact with sessions locally.

### Server Output

The server output surface is a Tauri-hosted React view using xterm.js. It is
read-only and receives:

- the bounded buffered output captured before the window opened;
- live stdout/stderr chunks from the server process;
- small lifecycle markers for server start, stop, and restart events.

xterm.js is preferred over a plain `<pre>` because the server's pretty console
logs include ANSI color codes. It is preferred over native terminals because
Tauri keeps ownership of restart, shutdown, environment, auth token handling,
and process status.

## Settings

Add a `startup_view` config field with these values:

- `dashboard`;
- `server_output`;
- `tray_only`.

Existing `start_minimized` values are treated as backwards-compatibility input:
when `startup_view` is missing and `start_minimized` is true, the effective
startup view is `tray_only`.

Keep the existing settings:

- `Start at Login`;
- `Run in Background`.

`Run in Background` controls whether closing primary desktop surfaces hides
them or exits the desktop app and stops the server.

## Tray Menu

The tray should expose:

- `Open Dashboard`;
- `Open Server Output`;
- `Setup / Repair`;
- `Restart Server`;
- `Settings`;
- `Quit`.

The settings submenu should include `Start at Login`, `Run in Background`, and
the three startup-view choices.

## Server Output Capture

The Tauri server launcher should:

1. spawn the server with stdout and stderr piped;
2. hide native sidecar console windows on Windows;
3. merge stdout/stderr into a bounded in-memory buffer;
4. emit live output events to Tauri windows;
5. redact obvious sensitive token fragments before storing or emitting output.

The buffer is diagnostic state only. It must remain bounded by byte size and
must not become a durable log file. Persistent logs remain the server's own
file logging responsibility.

## Verification

Focused checks:

```bash
pnpm --filter @yep-anywhere/desktop build
cd packages/desktop/src-tauri && cargo check
```

Then run repo lint for TypeScript diagnostics:

```bash
pnpm lint
```
