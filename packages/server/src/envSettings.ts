/**
 * Registry of documented environment variables that configure this server at
 * startup, plus the redaction-safe report the Environment settings panel reads.
 *
 * This registry is the single source of truth for which env vars affect YA and
 * what they do — prose copies in CLAUDE.md and config.ts comments are
 * convenience, this is the catalog. Each descriptor names the var, its group,
 * whether it is a secret, and a one-line description.
 *
 * Secrets never leave the server in full: {@link buildEnvSettings} replaces a
 * set secret's value with a redacted preview (a few trailing characters), so the
 * raw value is not placed in the report object that the route serializes.
 */

export type EnvGroup =
  | "Server & network"
  | "Data & profiles"
  | "Sessions & scanning"
  | "Processes & workers"
  | "Providers & features"
  | "Speech & transcription"
  | "Logging"
  | "Authentication"
  | "File access"
  | "Diagnostics & development"
  | "Desktop";

/** Group display order for the panel. */
export const ENV_GROUP_ORDER: EnvGroup[] = [
  "Server & network",
  "Data & profiles",
  "Sessions & scanning",
  "Processes & workers",
  "Providers & features",
  "Speech & transcription",
  "Logging",
  "Authentication",
  "File access",
  "Diagnostics & development",
  "Desktop",
];

export interface EnvVarDescriptor {
  name: string;
  group: EnvGroup;
  /**
   * Mark explicitly secret. Names matching {@link SECRET_NAME_RE} are treated as
   * secret regardless, so a future key var is redacted even if this is omitted.
   */
  secret?: boolean;
  description: string;
}

/**
 * One reported env var: its presence and, for non-secrets, value. For set
 * secrets, `value` is a redacted preview — never the raw value.
 */
export interface EnvSettingEntry {
  name: string;
  group: EnvGroup;
  description: string;
  secret: boolean;
  set: boolean;
  /**
   * Plain value for non-secrets; a redacted preview (e.g. "⋯xyz") for set
   * secrets; empty string for a var set to "". Absent when the var is unset.
   */
  value?: string;
  /**
   * Dynamic, runtime-computed caption (not part of the static registry). Filled
   * in per-request by the route for vars whose real effect depends on live
   * server state — e.g. HOST gets the actual active listen addresses.
   */
  note?: string;
}

export interface EnvSettingsReport {
  entries: EnvSettingEntry[];
}

/** Any var whose name contains one of these is redacted even if not flagged. */
const SECRET_NAME_RE = /KEY|SECRET|TOKEN|PASSWORD/;

const REDACT_GLYPH = "⋯";
/** Only reveal trailing chars when the value is long enough to spare them. */
const MIN_LEN_FOR_TAIL = 8;
const TAIL_CHARS = 3;

export function isSecretName(name: string, declared?: boolean): boolean {
  // An explicit flag is authoritative in both directions; the name heuristic
  // only decides for vars that don't declare one. This lets a non-secret like
  // SHARE_XAI_KEY_WITH_CLIENTS (name contains "KEY") opt out of redaction.
  if (declared !== undefined) return declared;
  return SECRET_NAME_RE.test(name);
}

/** Server-side redaction: reveal only a short tail of a long-enough secret. */
export function redactSecretValue(value: string): string {
  if (value.length >= MIN_LEN_FOR_TAIL) {
    return REDACT_GLYPH + value.slice(-TAIL_CHARS);
  }
  return REDACT_GLYPH;
}

export const ENV_VAR_REGISTRY: EnvVarDescriptor[] = [
  // Server & network
  {
    name: "PORT",
    group: "Server & network",
    description:
      "Base port. The server uses PORT (main), PORT+1 (maintenance), PORT+2 (Vite dev). Default 3400.",
  },
  {
    name: "HOST",
    group: "Server & network",
    description:
      "Extra network interface to bind, applied only when the server is launched with --host. localhost is always served regardless.",
  },
  {
    name: "SERVE_FRONTEND",
    group: "Server & network",
    description:
      "Serve the web UI (proxied in dev, static in prod). Set false for API-only mode. Default true.",
  },
  {
    name: "HTTPS_SELF_SIGNED",
    group: "Server & network",
    description:
      "Serve over HTTPS using an auto-generated self-signed certificate.",
  },
  {
    name: "OPEN_BROWSER",
    group: "Server & network",
    description: "Open the dashboard in your default browser on startup.",
  },
  {
    name: "MAINTENANCE_PORT",
    group: "Server & network",
    description:
      "Maintenance HTTP server port for out-of-band diagnostics. Default PORT+1; 0 disables.",
  },
  {
    name: "VITE_PORT",
    group: "Server & network",
    description:
      "Vite dev server port the frontend proxy targets. Default PORT+2.",
  },
  {
    name: "ALLOWED_HOSTS",
    group: "Server & network",
    description:
      "Extra Host header values to accept, comma-separated; '*' allows any. Adds to built-in localhost/LAN patterns.",
  },
  {
    name: "PORT_FILE",
    group: "Server & network",
    description: "File to write the actually-bound main port (test harnesses).",
  },
  {
    name: "MAINTENANCE_PORT_FILE",
    group: "Server & network",
    description:
      "File to write the actually-bound maintenance port (test harnesses).",
  },
  {
    name: "YEP_CLIENT_BASE_URL",
    group: "Server & network",
    description:
      "Hosted YA client base URL used when generating public-share links.",
  },

  // Data & profiles
  {
    name: "YEP_DATA_DIR",
    group: "Data & profiles",
    description:
      "Full path override for the server data directory (logs, indexes, uploads, metadata).",
  },
  {
    name: "YEP_PROFILE",
    group: "Data & profiles",
    description:
      "Profile suffix; data dir becomes ~/.yep-anywhere-{profile}. Run multiple instances side by side.",
  },
  {
    name: "CLAUDE_CONFIG_DIR",
    group: "Data & profiles",
    description:
      "Claude Code config directory (default ~/.claude). Sessions are scanned from {dir}/projects.",
  },

  // Sessions & scanning
  {
    name: "CLAUDE_SESSIONS_DIR",
    group: "Sessions & scanning",
    description:
      "Override the Claude sessions directory (default {CLAUDE_CONFIG_DIR}/projects).",
  },
  {
    name: "CLAUDE_PROJECTS_DIR",
    group: "Sessions & scanning",
    description:
      "Override the Claude projects directory (defaults to the sessions directory).",
  },
  {
    name: "GEMINI_SESSIONS_DIR",
    group: "Sessions & scanning",
    description:
      "Override the Gemini sessions directory (default ~/.gemini/tmp).",
  },
  {
    name: "CODEX_SESSIONS_DIR",
    group: "Sessions & scanning",
    description: "Override the Codex sessions directory.",
  },
  {
    name: "CODEX_HOME",
    group: "Sessions & scanning",
    description: "Codex home directory used to locate its sessions.",
  },
  {
    name: "GROK_SESSIONS_DIR",
    group: "Sessions & scanning",
    description: "Override the Grok sessions directory.",
  },
  {
    name: "CODEX_WATCH_PERIODIC_RESCAN_MS",
    group: "Sessions & scanning",
    description:
      "Periodic full-rescan interval for the Codex session watcher (ms). 0 disables; on by default on macOS/Windows.",
  },
  {
    name: "SESSION_INDEX_FULL_VALIDATION_MS",
    group: "Sessions & scanning",
    description:
      "Session index full-validation interval (ms). 0 validates every request.",
  },
  {
    name: "SESSION_INDEX_WRITE_LOCK_TIMEOUT_MS",
    group: "Sessions & scanning",
    description:
      "Timeout (ms) to acquire the cross-process session index write lock.",
  },
  {
    name: "SESSION_INDEX_WRITE_LOCK_STALE_MS",
    group: "Sessions & scanning",
    description:
      "Age (ms) after which a session index write lock is considered stale.",
  },
  {
    name: "PROJECT_SCAN_CACHE_TTL_MS",
    group: "Sessions & scanning",
    description: "Project scanner cache TTL (ms). 0 rescans every request.",
  },
  {
    name: "SESSION_AUTO_ARCHIVE_DAYS",
    group: "Sessions & scanning",
    description:
      "Days of inactivity before a session is auto-archived. 0 disables.",
  },

  // Processes & workers
  {
    name: "IDLE_TIMEOUT",
    group: "Processes & workers",
    description:
      "Seconds an idle provider process is kept warm before it is reaped. Default 3600 (60 min), matching the prompt-cache window.",
  },
  {
    name: "IDLE_PREEMPT_THRESHOLD",
    group: "Processes & workers",
    description:
      "Seconds a worker must be idle before it can be preempted. Default 10.",
  },
  {
    name: "MAX_WORKERS",
    group: "Processes & workers",
    description: "Maximum concurrent provider processes. 0 = unlimited.",
  },
  {
    name: "MAX_QUEUE_SIZE",
    group: "Processes & workers",
    description:
      "Maximum pending request queue length. 0 = unlimited. Default 100.",
  },
  {
    name: "MAX_UPLOAD_SIZE_MB",
    group: "Processes & workers",
    description: "Maximum upload size in MB. 0 = unlimited. Default 100.",
  },
  {
    name: "PERMISSION_MODE",
    group: "Processes & workers",
    description: "Default permission mode for new sessions.",
  },
  {
    name: "USE_MOCK_SDK",
    group: "Processes & workers",
    description: "Use the mock SDK instead of the real Claude SDK (testing).",
  },

  // Providers & features
  {
    name: "ENABLED_PROVIDERS",
    group: "Providers & features",
    description:
      "Comma-separated providers to expose (claude, codex, gemini, …). Empty = all enabled.",
  },
  {
    name: "VOICE_INPUT",
    group: "Providers & features",
    description:
      "Show the voice input (microphone) button. Set false to disable. Default true.",
  },
  {
    name: "YEP_DEFERRED_JOIN_WINDOW_S",
    group: "Providers & features",
    description:
      "Maximum compose-time gap in seconds for joining deferred turns. 0 keeps each turn separate.",
  },
  {
    name: "YEP_COMPOSE_ANCHORS",
    group: "Providers & features",
    description:
      "Set 1 to prepend compose-time staleness anchors to delivered deferred turns.",
  },
  {
    name: "OLLAMA_URL",
    group: "Providers & features",
    description:
      "Base URL for the Ollama server used by the claude-ollama provider.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    group: "Providers & features",
    secret: true,
    description:
      "Anthropic API key passed through to the Claude provider when set.",
  },
  {
    name: "CLAUDE_CODE_EXECUTABLE",
    group: "Providers & features",
    description: "Path to the Claude Code CLI executable.",
  },
  {
    name: "CLAUDE_CODE_PATH",
    group: "Providers & features",
    description: "Alternate path hint for the Claude Code CLI executable.",
  },

  // Speech & transcription
  {
    name: "YEP_VOICE_BACKENDS",
    group: "Speech & transcription",
    description:
      "Comma-separated server-routed STT backends to enable (e.g. ya-whisper).",
  },
  {
    name: "YEP_STT_DEEPGRAM_API_KEY",
    group: "Speech & transcription",
    secret: true,
    description: "Deepgram API key for the ya-deepgram STT backend.",
  },
  {
    name: "YEP_STT_XAI_API_KEY",
    group: "Speech & transcription",
    secret: true,
    description: "xAI API key for the ya-grok STT backend.",
  },
  {
    name: "YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS",
    group: "Speech & transcription",
    secret: false,
    description:
      "Allow authenticated clients to borrow the server's xAI STT key.",
  },
  {
    name: "XAI_API_KEY",
    group: "Speech & transcription",
    secret: true,
    description:
      "General xAI key; accepted as an STT fallback, then stripped from the environment so provider CLIs can't inherit it.",
  },
  {
    name: "WHISPER_MODEL",
    group: "Speech & transcription",
    description:
      "Model name for the ya-whisper backend (default distil-large-v3).",
  },
  {
    name: "WHISPER_DEVICE",
    group: "Speech & transcription",
    description: "Device for the ya-whisper backend (default cpu).",
  },
  {
    name: "WHISPER_COMPUTE_TYPE",
    group: "Speech & transcription",
    description: "Compute type for the ya-whisper backend (default int8).",
  },
  {
    name: "PARAKEET_MODEL",
    group: "Speech & transcription",
    description: "Model name for the ya-parakeet backend.",
  },
  {
    name: "PARAKEET_DEVICE",
    group: "Speech & transcription",
    description: "Device for the ya-parakeet backend (default auto).",
  },
  {
    name: "NEMO_MODEL",
    group: "Speech & transcription",
    description: "Model name for the ya-nemo backend.",
  },
  {
    name: "NEMO_DEVICE",
    group: "Speech & transcription",
    description: "Device for the ya-nemo backend (default auto).",
  },

  // Logging
  {
    name: "LOG_DIR",
    group: "Logging",
    description: "Directory for log files. Default {dataDir}/logs.",
  },
  {
    name: "LOG_FILE",
    group: "Logging",
    description: "Log filename. Default server.log.",
  },
  {
    name: "LOG_LEVEL",
    group: "Logging",
    description:
      "Minimum log level (fatal|error|warn|info|debug|trace). Default info.",
  },
  {
    name: "LOG_FILE_LEVEL",
    group: "Logging",
    description:
      "Separate minimum level for file logging (default same as LOG_LEVEL).",
  },
  {
    name: "LOG_TO_FILE",
    group: "Logging",
    description: "Write logs to file. Default off.",
  },
  {
    name: "LOG_PRETTY",
    group: "Logging",
    description: "Pretty-print console logs. Default on; set false for JSON.",
  },
  {
    name: "LOG_SDK_MESSAGES",
    group: "Logging",
    description:
      "Log raw SDK messages to sdk-raw.jsonl for tool-result debugging.",
  },

  // Authentication
  {
    name: "AUTH_DISABLED",
    group: "Authentication",
    description:
      "Disable cookie-based auth (recovery if the password is lost). Default false.",
  },
  {
    name: "AUTH_COOKIE_SECRET",
    group: "Authentication",
    secret: true,
    description: "Cookie signing secret. Auto-generated when unset.",
  },
  {
    name: "AUTH_SESSION_TTL_DAYS",
    group: "Authentication",
    description: "Auth session lifetime in days. Default 30.",
  },
  {
    name: "DESKTOP_AUTH_TOKEN",
    group: "Authentication",
    secret: true,
    description:
      "Token that lets the Tauri desktop app bypass auth via the X-Desktop-Token header.",
  },

  // File access
  {
    name: "ALLOWED_FILE_PATHS",
    group: "File access",
    description:
      "Directory prefixes the server may read for project files and media. When set, pins the allow-list (UI becomes read-only).",
  },
  {
    name: "ALLOWED_IMAGE_PATHS",
    group: "File access",
    description: "Legacy alias for ALLOWED_FILE_PATHS (image/media paths).",
  },

  // Diagnostics & development
  {
    name: "PROXY_DEBUG",
    group: "Diagnostics & development",
    description: "Log dev-proxy traffic at startup.",
  },
  {
    name: "CODEX_CORRELATION_DEBUG",
    group: "Diagnostics & development",
    description: "Verbose logging for Codex event correlation.",
  },
  {
    name: "YEP_CODEX_DISABLE_LIVE_DELTAS",
    group: "Diagnostics & development",
    description:
      "Drop Codex live delta notifications before raw logging and client delivery.",
  },
  {
    name: "YEP_ALLOW_SUSPICIOUS_HOME",
    group: "Diagnostics & development",
    description:
      "Allow development commands to run when HOME points inside the repository.",
  },
  {
    name: "SESSION_INDEX_LOG_PERF",
    group: "Diagnostics & development",
    description: "Log session-index performance timings.",
  },
  {
    name: "SESSION_FOCUSED_WATCH_LOG_EVENTS",
    group: "Diagnostics & development",
    description: "Log focused-session file-watch events.",
  },
  {
    name: "NO_BACKEND_RELOAD",
    group: "Diagnostics & development",
    description: "Disable automatic backend reload in dev.",
  },
  {
    name: "NO_FRONTEND_RELOAD",
    group: "Diagnostics & development",
    description: "Disable automatic frontend reload in dev.",
  },
  {
    name: "CLIENT_DIST_PATH",
    group: "Diagnostics & development",
    description: "Override the path to the built client dist directory.",
  },
  {
    name: "STABLE_DIST_PATH",
    group: "Diagnostics & development",
    description:
      "Override the path to the stable (emergency) client dist directory.",
  },
  {
    name: "NODE_ENV",
    group: "Diagnostics & development",
    description: "Node environment (development|production).",
  },

  // Desktop
  {
    name: "YEP_DESKTOP",
    group: "Desktop",
    description: "Set by the Tauri desktop app to mark a desktop runtime.",
  },
  {
    name: "YEP_DESKTOP_CODEX_CLI_PATH",
    group: "Desktop",
    description: "Desktop-provided Codex CLI path (authoritative when set).",
  },
];

/**
 * Build the redaction-safe report from an environment. Secrets that are set are
 * reported with a redacted preview only; raw secret values never enter the
 * returned object.
 */
export function buildEnvSettings(
  env: NodeJS.ProcessEnv = process.env,
): EnvSettingsReport {
  const entries: EnvSettingEntry[] = ENV_VAR_REGISTRY.map((d) => {
    const secret = isSecretName(d.name, d.secret);
    const raw = env[d.name];
    const set = raw !== undefined;
    let value: string | undefined;
    if (set) {
      value = secret && raw.length > 0 ? redactSecretValue(raw) : raw;
    }
    return {
      name: d.name,
      group: d.group,
      description: d.description,
      secret,
      set,
      value,
    };
  });
  return { entries };
}

/**
 * Startup snapshot. Captured before secrets are harvested/stripped from
 * process.env so harvested keys still report as present (redacted). Redaction
 * runs at capture, so no extra raw secret copies are retained here.
 */
let startupReport: EnvSettingsReport | null = null;

export function captureStartupEnvSettings(
  env: NodeJS.ProcessEnv = process.env,
): void {
  startupReport = buildEnvSettings(env);
}

export function getStartupEnvSettings(): EnvSettingsReport {
  // Fall back to live env if capture was skipped (e.g. a direct test call).
  // Secrets harvested before capture would already be absent in that path.
  return startupReport ?? buildEnvSettings();
}
