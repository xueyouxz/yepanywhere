/**
 * Make the server test suite reproducible regardless of the developer's shell.
 *
 * `loadConfig()` reads `process.env`, and `run-with-safe-home.js` passes the
 * full environment through to vitest. So a dev who exports a runtime knob for
 * their live server (e.g. `YEP_DEFERRED_JOIN_WINDOW_S=30` in local.sh) silently
 * changes behavior under test — a test can pass on CI (clean env) and fail
 * locally, or vice versa. This is exactly what made the deferred one-per-boundary
 * test non-reproducible.
 *
 * This setup runs before each test file and removes every env var
 * `packages/server/src/config.ts` consults, so config resolves to its built-in
 * defaults. Tests that exercise a specific var still set it explicitly with
 * `vi.stubEnv(...)`, which takes effect after this and is auto-restored.
 *
 * NOT cleared: test-harness gates the test scripts set deliberately
 * (`REAL_SDK_TESTS`, `FOREGROUND`) and `HOME` (safe-home owns it). Keep this list
 * in sync with the `process.env.*` reads in config.ts.
 */
const CONFIG_ENV_VARS = [
  "ALLOWED_IMAGE_PATHS",
  "AUTH_COOKIE_SECRET",
  "AUTH_DISABLED",
  "AUTH_SESSION_TTL_DAYS",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECTS_DIR",
  "CLAUDE_SESSIONS_DIR",
  "CLIENT_DIST_PATH",
  "CLI_HOST_OVERRIDE",
  "CLI_PORT_OVERRIDE",
  "CODEX_HOME",
  "CODEX_SESSIONS_DIR",
  "CODEX_WATCH_PERIODIC_RESCAN_MS",
  "DESKTOP_AUTH_TOKEN",
  "ENABLED_PROVIDERS",
  "GEMINI_SESSIONS_DIR",
  "HOST",
  "HTTPS_SELF_SIGNED",
  "IDLE_PREEMPT_THRESHOLD",
  "IDLE_TIMEOUT",
  "LOG_DIR",
  "LOG_FILE",
  "LOG_FILE_LEVEL",
  "LOG_LEVEL",
  "LOG_PRETTY",
  "LOG_TO_FILE",
  "MAINTENANCE_PORT",
  "MAINTENANCE_PORT_FILE",
  "MAX_QUEUE_SIZE",
  "MAX_UPLOAD_SIZE_MB",
  "MAX_WORKERS",
  "NEMO_DEVICE",
  "NEMO_MODEL",
  "OPEN_BROWSER",
  "PARAKEET_DEVICE",
  "PARAKEET_MODEL",
  "PERMISSION_MODE",
  "PORT",
  "PORT_FILE",
  "PROJECT_SCAN_CACHE_TTL_MS",
  "SERVE_FRONTEND",
  "SESSION_AUTO_ARCHIVE_DAYS",
  "SESSION_INDEX_FULL_VALIDATION_MS",
  "SESSION_INDEX_WRITE_LOCK_STALE_MS",
  "SESSION_INDEX_WRITE_LOCK_TIMEOUT_MS",
  "STABLE_DIST_PATH",
  "USE_MOCK_SDK",
  "VITE_PORT",
  "VOICE_INPUT",
  "WHISPER_COMPUTE_TYPE",
  "WHISPER_DEVICE",
  "WHISPER_MODEL",
  "XAI_API_KEY",
  "YEP_COMPOSE_ANCHORS",
  "YEP_DEFERRED_JOIN_WINDOW_S",
  "YEP_STT_DEEPGRAM_API_KEY",
  "YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS",
  "YEP_STT_XAI_API_KEY",
  "YEP_VOICE_BACKENDS",
  "YEP_CLIENT_BASE_URL",
  "YEP_CODEX_DISABLE_LIVE_DELTAS",
  "YEP_DATA_DIR",
  "YEP_PROFILE",
  // Legacy names are also cleared so tests can opt into compatibility
  // explicitly without inheriting a developer shell value.
  "YA_COMPOSE_ANCHORS",
  "YA_CODEX_DISABLE_LIVE_DELTAS",
  "YA_DEFERRED_JOIN_WINDOW_S",
  "YA_VOICE_BACKENDS",
  "YA_stt__DEEPGRAM_API_KEY",
  "YA_stt__SHARE_XAI_KEY_WITH_CLIENTS",
  "YA_stt__XAI_API_KEY",
  "YEP_ANYWHERE_DATA_DIR",
  "YEP_ANYWHERE_PROFILE",
  "YEP_PUBLIC_SHARE_ORIGIN",
  "YEP_PUBLIC_SHARE_VIEWER_BASE_URL",
  "YEP_YA_CLIENT_BASE_URL",
  "YEP_DESKTOP",
  "YEP_DESKTOP_CODEX_CLI_PATH",
];

for (const name of CONFIG_ENV_VARS) {
  delete process.env[name];
}
