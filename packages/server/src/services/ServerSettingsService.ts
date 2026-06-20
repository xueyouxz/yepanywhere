/**
 * ServerSettingsService - Manages server-wide settings that persist across restarts
 *
 * Stores settings like:
 * - serviceWorkerEnabled: Whether clients should register the service worker
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AgentContextHints,
  ClientDefaults,
  HelperTargetConfig,
  NewSessionDefaults,
  PromptCacheKeepaliveSettings,
} from "@yep-anywhere/shared";
import { normalizeYaClientBaseUrlFromShareViewerUrl } from "@yep-anywhere/shared";
import type { FileAccessSettings } from "../middleware/file-access.js";
import { publishDeferredDeliverySettings } from "../supervisor/deferredDeliverySettings.js";

export type { FileAccessSettings };

const CURRENT_VERSION = 2;
export const DEFAULT_SPEECH_AUDIO_RETENTION_MAX_AGE_DAYS = 56;
export const DEFAULT_SPEECH_AUDIO_RETENTION_MAX_BYTES = 400 * 1024 * 1024;
const DEFAULT_HEARTBEAT_TURN_TEXT = "continue";
const LEGACY_DEFAULT_HEARTBEAT_TURN_TEXTS = new Set([
  "heartbeat",
  "yepanywhere heartbeat",
]);
const DEFAULT_CLIENT_DEFAULTS: ClientDefaults = {};

export interface SpeechAudioRetentionSettings {
  /** Whether YA persists server-routed speech audio and sidecar metadata. */
  enabled: boolean;
  /** Prune retained speech audio older than this many days. */
  maxAgeDays: number;
  /** Prune oldest retained speech audio when the store exceeds this many bytes. */
  maxBytes: number;
}

/** Server-wide settings */
export interface ServerSettings {
  /** Whether clients should register the service worker (for push notifications) */
  serviceWorkerEnabled: boolean;
  /** Whether remote SRP resume sessions should be persisted to disk (default: false/in-memory only) */
  persistRemoteSessionsToDisk: boolean;
  /** Whether the server is requesting browser clients to upload diagnostic logs */
  clientLogCollectionRequested: boolean;
  /** Whether users may create public read-only share links */
  publicSharesEnabled: boolean;
  /** Base URL for the hosted YA client; remote login/share routes are appended */
  yaClientBaseUrl?: string;
  /** @deprecated Use yaClientBaseUrl. Kept to migrate older settings files. */
  publicShareViewerBaseUrl?: string;
  /** SSH host aliases for remote executors (from ~/.ssh/config) */
  remoteExecutors?: string[];
  /** SSH host aliases for ChromeOS device-bridge targets */
  chromeOsHosts?: string[];
  /** Allowed hostnames for host/origin validation. "*" = allow all, comma-separated = specific hosts. */
  allowedHosts?: string;
  /**
   * Which local path prefixes the HTTP file doors (media + project-files routes)
   * may read. Undefined = secure defaults (projects/uploads/temp on, home off,
   * no custom). Ignored when ALLOWED_FILE_PATHS/ALLOWED_IMAGE_PATHS is set.
   * See docs/tactical/018-file-access-scoping.md.
   */
  fileAccess?: FileAccessSettings;
  /** Free-form instructions appended to the system prompt for all sessions */
  globalInstructions?: string;
  /** Optional client-context hints composed additively with global instructions */
  agentContextHints?: AgentContextHints;
  /** Default idle minutes before an opted-in session queues a heartbeat turn */
  heartbeatTurnsAfterMinutes?: number;
  /** Default text queued as the synthetic heartbeat user turn */
  heartbeatTurnText?: string;
  /** Ollama server URL for claude-ollama provider (default: http://localhost:11434) */
  ollamaUrl?: string;
  /** Custom system prompt for Ollama provider (overrides the default minimal prompt) */
  ollamaSystemPrompt?: string;
  /** Whether to use the full Claude system prompt for Ollama (for large-context models like Qwen3) */
  ollamaUseFullSystemPrompt?: boolean;
  /** Whether Grok Build may receive the scrubbed ambient XAI_API_KEY. */
  grokBuildUseXaiApiKey?: boolean;
  /** Whether the device bridge (emulator/device streaming) feature is enabled */
  deviceBridgeEnabled?: boolean;
  /** Defaults applied when opening the new session form */
  newSessionDefaults?: NewSessionDefaults;
  /** Defaults applied by browser clients when their local value is unset. */
  clientDefaults?: ClientDefaults;
  /** Server-routed speech audio retention policy. */
  speechAudioRetention: SpeechAudioRetentionSettings;
  /** OpenAI-compatible helper endpoints for side-session helper work */
  helperTargets?: HelperTargetConfig[];
  /** Per-provider prompt-cache keepalive policy and cadence. */
  promptCacheKeepalive?: PromptCacheKeepaliveSettings;
  /** Whether lifecycle webhook delivery is enabled */
  lifecycleWebhooksEnabled?: boolean;
  /** External webhook URL that receives lifecycle events */
  lifecycleWebhookUrl?: string;
  /** Optional bearer token used for lifecycle webhook delivery */
  lifecycleWebhookToken?: string;
  /** When true, include dryRun=true in lifecycle webhook payloads */
  lifecycleWebhookDryRun?: boolean;
  /**
   * How the server handles Codex CLI updates:
   * - "auto": automatically run `npm install -g <pkg>@latest` when an update
   *   is available and the install was done via npm (best effort, logs only).
   * - "notify": surface a banner in the UI but do nothing automatically.
   * - "off": don't check or surface updates.
   */
  codexUpdatePolicy?: "auto" | "notify" | "off";
  /**
   * Max seconds between consecutive compose times for queued-while-busy turns
   * to join into one `--------`-joined provider turn at a delivery boundary.
   * 0 = never join (the vanilla default). Unset falls back to env
   * `YEP_DEFERRED_JOIN_WINDOW_S` (topics/compose-time-context-anchors.md).
   */
  deferredJoinWindowSeconds?: number;
  /**
   * Prepend `(Ns ago)` / `(Ms later)` compose-time staleness anchors to
   * delivered queued turns. Unset falls back to env `YEP_COMPOSE_ANCHORS`.
   */
  composeAnchorsEnabled?: boolean;
}

export const CODEX_UPDATE_POLICIES = ["auto", "notify", "off"] as const;
export type CodexUpdatePolicy = (typeof CODEX_UPDATE_POLICIES)[number];

/** Default settings */
export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  serviceWorkerEnabled: true,
  persistRemoteSessionsToDisk: false,
  clientLogCollectionRequested: false,
  publicSharesEnabled: false,
  heartbeatTurnsAfterMinutes: 15,
  heartbeatTurnText: DEFAULT_HEARTBEAT_TURN_TEXT,
  speechAudioRetention: {
    enabled: true,
    maxAgeDays: DEFAULT_SPEECH_AUDIO_RETENTION_MAX_AGE_DAYS,
    maxBytes: DEFAULT_SPEECH_AUDIO_RETENTION_MAX_BYTES,
  },
  lifecycleWebhooksEnabled: false,
  lifecycleWebhookDryRun: true,
  grokBuildUseXaiApiKey: false,
  codexUpdatePolicy: "notify",
  clientDefaults: DEFAULT_CLIENT_DEFAULTS,
};

function mergeLoadedClientDefaults(
  loaded: ClientDefaults | undefined,
): ClientDefaults | undefined {
  const merged: ClientDefaults = {
    ...DEFAULT_CLIENT_DEFAULTS,
    ...loaded,
  };
  const speech = {
    ...DEFAULT_CLIENT_DEFAULTS.speech,
    ...loaded?.speech,
  };
  const sessionToolbarVisibility = {
    ...DEFAULT_CLIENT_DEFAULTS.sessionToolbarVisibility,
    ...loaded?.sessionToolbarVisibility,
  };

  if (Object.keys(speech).length > 0) {
    merged.speech = speech;
  } else {
    delete merged.speech;
  }
  if (Object.keys(sessionToolbarVisibility).length > 0) {
    merged.sessionToolbarVisibility = sessionToolbarVisibility;
  } else {
    delete merged.sessionToolbarVisibility;
  }

  // Per-model compaction thresholds: keep only valid in-range percents (1–99);
  // anything else (including >= 100 = "off") is dropped per model, and an empty
  // map is removed so "off everywhere" stays canonically absent.
  const compactByModel = merged.compactAtContextPercent;
  if (compactByModel && typeof compactByModel === "object") {
    const cleaned: Record<string, number> = {};
    for (const [modelId, pct] of Object.entries(compactByModel)) {
      if (
        typeof pct === "number" &&
        Number.isFinite(pct) &&
        pct > 0 &&
        pct < 100
      ) {
        cleaned[modelId] = Math.round(pct);
      }
    }
    if (Object.keys(cleaned).length > 0) {
      merged.compactAtContextPercent = cleaned;
    } else {
      delete merged.compactAtContextPercent;
    }
  } else {
    delete merged.compactAtContextPercent;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeLoadedSettings(settings: ServerSettings): ServerSettings {
  const normalized = { ...DEFAULT_SERVER_SETTINGS, ...settings };
  normalized.clientDefaults = mergeLoadedClientDefaults(
    settings.clientDefaults,
  );
  const loadedHeartbeatText = settings.heartbeatTurnText?.trim();
  if (
    loadedHeartbeatText &&
    LEGACY_DEFAULT_HEARTBEAT_TURN_TEXTS.has(loadedHeartbeatText)
  ) {
    normalized.heartbeatTurnText = DEFAULT_SERVER_SETTINGS.heartbeatTurnText;
  }
  if (!normalized.yaClientBaseUrl && normalized.publicShareViewerBaseUrl) {
    try {
      normalized.yaClientBaseUrl = normalizeYaClientBaseUrlFromShareViewerUrl(
        normalized.publicShareViewerBaseUrl,
      );
      delete normalized.publicShareViewerBaseUrl;
    } catch {
      // Leave invalid legacy values for the status endpoint to report clearly.
    }
  }
  return normalized;
}

/** Stored state with version for migrations */
interface SettingsState {
  version: number;
  settings: ServerSettings;
}

export interface ServerSettingsServiceOptions {
  dataDir: string;
}

export class ServerSettingsService {
  private state: SettingsState;
  private dataDir: string;
  private filePath: string;
  private initialized = false;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: ServerSettingsServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, "server-settings.json");
    this.state = {
      version: CURRENT_VERSION,
      settings: DEFAULT_SERVER_SETTINGS,
    };
  }

  /**
   * Initialize the service by loading state from disk.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as SettingsState;

      if (parsed.version === CURRENT_VERSION) {
        // Merge with defaults in case new settings were added
        this.state = {
          version: CURRENT_VERSION,
          settings: normalizeLoadedSettings(parsed.settings),
        };
      } else {
        // Future: handle migrations
        this.state = {
          version: CURRENT_VERSION,
          settings: normalizeLoadedSettings(parsed.settings),
        };
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[ServerSettingsService] Failed to load settings, using defaults:",
          error,
        );
      }
      this.state = {
        version: CURRENT_VERSION,
        settings: DEFAULT_SERVER_SETTINGS,
      };
    }

    this.initialized = true;
    this.publishDeferredDelivery();
  }

  /** Push deferred-delivery settings to the supervisor's live bridge. */
  private publishDeferredDelivery(): void {
    publishDeferredDeliverySettings({
      deferredJoinWindowSeconds: this.state.settings.deferredJoinWindowSeconds,
      composeAnchorsEnabled: this.state.settings.composeAnchorsEnabled,
    });
  }

  /**
   * Get all settings.
   */
  getSettings(): ServerSettings {
    this.ensureInitialized();
    return { ...this.state.settings };
  }

  /**
   * Get a specific setting.
   */
  getSetting<K extends keyof ServerSettings>(key: K): ServerSettings[K] {
    this.ensureInitialized();
    return this.state.settings[key];
  }

  /**
   * Update settings.
   */
  async updateSettings(
    updates: Partial<ServerSettings>,
  ): Promise<ServerSettings> {
    this.ensureInitialized();

    this.state.settings = {
      ...this.state.settings,
      ...updates,
    };

    await this.save();
    this.publishDeferredDelivery();
    return { ...this.state.settings };
  }

  /**
   * Ensure service is initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "ServerSettingsService not initialized. Call initialize() first.",
      );
    }
  }

  /**
   * Save state to disk with debouncing.
   */
  private async save(): Promise<void> {
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;

    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[ServerSettingsService] Failed to save settings:", error);
      throw error;
    }
  }
}
