/**
 * Server settings API routes
 */

import {
  ALL_PERMISSION_MODES,
  ALL_PROVIDERS,
  type AgentContextHints,
  type ClientDefaults,
  type GrokSpeechAudioClientDefault,
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  type HelperTargetConfig,
  type ModelInfo,
  type NewSessionDefaults,
  normalizeYaClientBaseUrl,
  normalizeYaClientBaseUrlFromShareViewerUrl,
  type PermissionMode,
  DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  PROMPT_CACHE_KEEPALIVE_MODES,
  type PromptCacheKeepaliveMode,
  type PromptCacheKeepaliveSettings,
  PROMPT_SUGGESTION_MODES,
  type PromptSuggestionMode,
  type ProviderName,
  RECAP_MODES,
  type RecapMode,
  type SessionToolbarVisibilityClientDefaults,
  type SpeechSmartTurnClientDefault,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { testSSHConnection } from "../sdk/remote-spawn.js";
import type { PublicShareService } from "../services/PublicShareService.js";
import type {
  CodexUpdatePolicy,
  ServerSettings,
  ServerSettingsService,
  SpeechAudioRetentionSettings,
} from "../services/ServerSettingsService.js";
import {
  CODEX_UPDATE_POLICIES,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SPEECH_AUDIO_RETENTION_MAX_AGE_DAYS,
  DEFAULT_SPEECH_AUDIO_RETENTION_MAX_BYTES,
} from "../services/ServerSettingsService.js";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";

const HELPER_TARGET_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_HELPER_TARGETS = 20;
const HELPER_TARGET_MODEL_DISCOVERY_TIMEOUT_MS = 5000;
const SESSION_TOOLBAR_VISIBILITY_CLIENT_DEFAULT_KEYS = [
  "modeSelector",
  "steerNow",
  "attachments",
  "slashMenu",
  "thinkingToggle",
  "renderMode",
  "microphone",
  "shortcutsHelp",
  "contextUsage",
  "btw",
  "nudge",
  "queueControls",
  "sessionStatus",
] as const satisfies readonly (keyof SessionToolbarVisibilityClientDefaults)[];
const CLIENT_DEFAULT_KEYS = [
  "speech",
  "sessionToolbarVisibility",
  "steerNowDefault",
] as const;
const SPEECH_CLIENT_DEFAULT_KEYS = [
  "voiceInputEnabled",
  "speechMethod",
  "speechSmartTurnSettings",
  "grokSpeechAudioSettings",
] as const;
const MAX_SPEECH_SMART_TURN_TIMEOUT_MS = 10000;

export interface SettingsRoutesDeps {
  serverSettingsService: ServerSettingsService;
  /** Callback to apply allowedHosts changes at runtime */
  onAllowedHostsChanged?: (value: string | undefined) => void;
  /** Callback to apply remote session persistence changes at runtime */
  onRemoteSessionPersistenceChanged?: (
    enabled: boolean,
  ) => Promise<void> | void;
  /** Callback to apply Ollama URL changes at runtime */
  onOllamaUrlChanged?: (url: string | undefined) => void;
  /** Callback to apply Ollama system prompt changes at runtime */
  onOllamaSystemPromptChanged?: (prompt: string | undefined) => void;
  /** Callback to apply Ollama full system prompt toggle at runtime */
  onOllamaUseFullSystemPromptChanged?: (enabled: boolean) => void;
  /** Callback to apply Grok Build XAI_API_KEY opt-in at runtime */
  onGrokBuildUseXaiApiKeyChanged?: (enabled: boolean) => void;
  /** Public share storage, used to revoke existing shares when disabled */
  publicShareService?: PublicShareService;
}

function parseHostAliasList(rawHosts: unknown[]): {
  hosts: string[];
  invalidHost?: string;
} {
  const hosts: string[] = [];

  for (const rawHost of rawHosts) {
    if (typeof rawHost !== "string") continue;

    const host = normalizeSshHostAlias(rawHost);
    if (!host) continue;
    if (!isValidSshHostAlias(host)) {
      return { hosts: [], invalidHost: host };
    }

    hosts.push(host);
  }

  return { hosts };
}

function normalizeOpenAiCompatibleBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.pathname === "" || url.pathname === "/") {
      url.pathname = "/v1";
    }

    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    return null;
  }
}

/**
 * Returns:
 * - `null` when the payload is invalid
 * - `undefined` when the setting should be cleared
 * - an array when valid helper targets should be saved
 */
function parseHelperTargets(
  raw: unknown,
): HelperTargetConfig[] | undefined | null {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_HELPER_TARGETS) return null;

  const seenIds = new Set<string>();
  const parsed: HelperTargetConfig[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const input = entry as Record<string, unknown>;
    const id = typeof input.id === "string" ? input.id.trim() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
    const model = typeof input.model === "string" ? input.model.trim() : "";

    if (
      !HELPER_TARGET_ID_PATTERN.test(id) ||
      seenIds.has(id) ||
      !name ||
      name.length > 80 ||
      input.kind !== "openai-compatible" ||
      !baseUrl ||
      model.length > 200
    ) {
      return null;
    }

    seenIds.add(id);
    parsed.push({
      id,
      name,
      kind: "openai-compatible",
      baseUrl,
      ...(model ? { model } : {}),
    });
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOpenAiModelsResponse(raw: unknown): ModelInfo[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return null;

  const models: ModelInfo[] = [];
  for (const entry of raw.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
      continue;
    }
    const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
    const rawContextWindow =
      typeof entry.max_model_len === "number"
        ? entry.max_model_len
        : typeof entry.maxModelLen === "number"
          ? entry.maxModelLen
          : typeof metadata?.max_model_len === "number"
            ? metadata.max_model_len
            : undefined;
    const contextWindow =
      rawContextWindow !== undefined && Number.isFinite(rawContextWindow)
        ? rawContextWindow
        : undefined;

    models.push({
      id: entry.id,
      name: entry.id,
      ...(contextWindow ? { contextWindow } : {}),
    });
  }

  return models;
}

function parseAgentContextHints(
  raw: unknown,
  current: AgentContextHints | undefined,
): AgentContextHints | null {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return null;

  const parsed: AgentContextHints = { ...current };
  if ("latexMathRendering" in raw) {
    if (typeof raw.latexMathRendering !== "boolean") return null;
    parsed.latexMathRendering = raw.latexMathRendering;
  }

  return parsed;
}

async function discoverOpenAiCompatibleModels(
  baseUrl: string,
): Promise<ModelInfo[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    HELPER_TARGET_MODEL_DISCOVERY_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseOpenAiModelsResponse(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns:
 * - `null` when the payload is invalid
 * - `undefined` when the setting should be cleared
 * - an object when valid defaults should be saved
 */
function parseNewSessionDefaults(
  raw: unknown,
): NewSessionDefaults | undefined | null {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return undefined;
  if (typeof raw !== "object") return null;

  const input = raw as Record<string, unknown>;
  const parsed: NewSessionDefaults = {};

  if ("provider" in input) {
    if (
      input.provider !== undefined &&
      input.provider !== null &&
      input.provider !== "" &&
      !ALL_PROVIDERS.includes(input.provider as ProviderName)
    ) {
      return null;
    }
    if (typeof input.provider === "string" && input.provider.length > 0) {
      parsed.provider = input.provider as ProviderName;
    }
  }

  if ("model" in input) {
    if (
      input.model !== undefined &&
      input.model !== null &&
      input.model !== "" &&
      typeof input.model !== "string"
    ) {
      return null;
    }
    if (typeof input.model === "string" && input.model.length > 0) {
      parsed.model = input.model;
    }
  }

  if ("permissionMode" in input) {
    if (
      input.permissionMode !== undefined &&
      input.permissionMode !== null &&
      input.permissionMode !== "" &&
      !ALL_PERMISSION_MODES.includes(input.permissionMode as PermissionMode)
    ) {
      return null;
    }
    if (
      typeof input.permissionMode === "string" &&
      input.permissionMode.length > 0
    ) {
      parsed.permissionMode = input.permissionMode as PermissionMode;
    }
  }

  if ("recapMode" in input) {
    if (
      input.recapMode !== undefined &&
      input.recapMode !== null &&
      input.recapMode !== "" &&
      !RECAP_MODES.includes(input.recapMode as RecapMode)
    ) {
      return null;
    }
    if (typeof input.recapMode === "string" && input.recapMode.length > 0) {
      parsed.recapMode = input.recapMode as RecapMode;
    }
  }

  if ("promptSuggestionMode" in input) {
    if (
      input.promptSuggestionMode !== undefined &&
      input.promptSuggestionMode !== null &&
      input.promptSuggestionMode !== "" &&
      !PROMPT_SUGGESTION_MODES.includes(
        input.promptSuggestionMode as PromptSuggestionMode,
      )
    ) {
      return null;
    }
    if (
      typeof input.promptSuggestionMode === "string" &&
      input.promptSuggestionMode.length > 0
    ) {
      parsed.promptSuggestionMode =
        input.promptSuggestionMode as PromptSuggestionMode;
    }
  }

  if ("helperSideModel" in input) {
    if (
      input.helperSideModel !== undefined &&
      input.helperSideModel !== null &&
      input.helperSideModel !== "" &&
      typeof input.helperSideModel !== "string"
    ) {
      return null;
    }
    if (
      typeof input.helperSideModel === "string" &&
      input.helperSideModel.length > 0
    ) {
      parsed.helperSideModel =
        input.helperSideModel === HELPER_SIDE_MODEL_SAME_AS_MAIN
          ? HELPER_SIDE_MODEL_SAME_AS_MAIN
          : input.helperSideModel === HELPER_SIDE_MODEL_CHEAPEST
            ? HELPER_SIDE_MODEL_CHEAPEST
            : input.helperSideModel.slice(0, 200);
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseSpeechSmartTurnClientDefault(
  raw: unknown,
): SpeechSmartTurnClientDefault | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.enabled !== "boolean" ||
    typeof raw.threshold !== "number" ||
    typeof raw.timeoutMs !== "number" ||
    !Number.isFinite(raw.threshold) ||
    !Number.isFinite(raw.timeoutMs) ||
    raw.threshold < 0 ||
    raw.threshold > 1 ||
    raw.timeoutMs < 0 ||
    raw.timeoutMs > MAX_SPEECH_SMART_TURN_TIMEOUT_MS
  ) {
    return null;
  }
  return {
    enabled: raw.enabled,
    threshold: raw.threshold,
    timeoutMs: Math.round(raw.timeoutMs),
  };
}

function parseGrokSpeechAudioClientDefault(
  raw: unknown,
): GrokSpeechAudioClientDefault | null {
  if (!isRecord(raw)) return null;
  if (raw.uplinkMode !== "pcm16" && raw.uplinkMode !== "browser-compressed") {
    return null;
  }
  return { uplinkMode: raw.uplinkMode };
}

function parseSessionToolbarVisibilityClientDefaults(
  raw: unknown,
): SessionToolbarVisibilityClientDefaults | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (!isRecord(raw)) return null;

  const allowedKeys = new Set<string>(
    SESSION_TOOLBAR_VISIBILITY_CLIENT_DEFAULT_KEYS,
  );
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) return null;
  }

  const parsed: SessionToolbarVisibilityClientDefaults = {};
  for (const key of SESSION_TOOLBAR_VISIBILITY_CLIENT_DEFAULT_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value !== "boolean") return null;
    parsed[key] = value;
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function parseClientDefaults(raw: unknown): ClientDefaults | undefined | null {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return undefined;
  if (!isRecord(raw)) return null;

  const allowedKeys = new Set<string>(CLIENT_DEFAULT_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) return null;
  }
  if (Object.keys(raw).length === 0) return null;

  const parsed: ClientDefaults = {};
  if ("speech" in raw) {
    if (raw.speech === undefined || raw.speech === null || raw.speech === "") {
      parsed.speech = undefined;
    } else if (!isRecord(raw.speech)) {
      return null;
    } else {
      const allowedSpeechKeys = new Set<string>(SPEECH_CLIENT_DEFAULT_KEYS);
      for (const key of Object.keys(raw.speech)) {
        if (!allowedSpeechKeys.has(key)) return null;
      }

      const speech: NonNullable<ClientDefaults["speech"]> = {};
      if ("voiceInputEnabled" in raw.speech) {
        if (typeof raw.speech.voiceInputEnabled !== "boolean") return null;
        speech.voiceInputEnabled = raw.speech.voiceInputEnabled;
      }
      if ("speechMethod" in raw.speech) {
        if (
          typeof raw.speech.speechMethod !== "string" ||
          raw.speech.speechMethod.trim().length === 0
        ) {
          return null;
        }
        speech.speechMethod = raw.speech.speechMethod.trim().slice(0, 120);
      }
      if ("speechSmartTurnSettings" in raw.speech) {
        const parsedSmartTurn = parseSpeechSmartTurnClientDefault(
          raw.speech.speechSmartTurnSettings,
        );
        if (!parsedSmartTurn) return null;
        speech.speechSmartTurnSettings = parsedSmartTurn;
      }
      if ("grokSpeechAudioSettings" in raw.speech) {
        const parsedGrokAudio = parseGrokSpeechAudioClientDefault(
          raw.speech.grokSpeechAudioSettings,
        );
        if (!parsedGrokAudio) return null;
        speech.grokSpeechAudioSettings = parsedGrokAudio;
      }
      if (Object.keys(speech).length === 0) return null;
      parsed.speech = speech;
    }
  }
  if ("steerNowDefault" in raw) {
    if (raw.steerNowDefault === undefined || raw.steerNowDefault === null) {
      parsed.steerNowDefault = undefined;
    } else if (typeof raw.steerNowDefault !== "boolean") {
      return null;
    } else {
      parsed.steerNowDefault = raw.steerNowDefault;
    }
  }
  if ("sessionToolbarVisibility" in raw) {
    const parsedVisibility = parseSessionToolbarVisibilityClientDefaults(
      raw.sessionToolbarVisibility,
    );
    if (parsedVisibility === null) return null;
    parsed.sessionToolbarVisibility = parsedVisibility;
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function mergeClientDefaults(
  current: ClientDefaults | undefined,
  update: ClientDefaults | undefined,
): ClientDefaults | undefined {
  if (!update) return undefined;
  const merged: ClientDefaults = { ...current };
  if ("speech" in update) {
    if (update.speech === undefined) {
      delete merged.speech;
    } else {
      merged.speech = {
        ...current?.speech,
        ...update.speech,
      };
    }
  }
  if ("steerNowDefault" in update) {
    if (update.steerNowDefault === undefined) {
      delete merged.steerNowDefault;
    } else {
      merged.steerNowDefault = update.steerNowDefault;
    }
  }
  if ("sessionToolbarVisibility" in update) {
    if (update.sessionToolbarVisibility === undefined) {
      delete merged.sessionToolbarVisibility;
    } else {
      merged.sessionToolbarVisibility = {
        ...current?.sessionToolbarVisibility,
        ...update.sessionToolbarVisibility,
      };
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function parseSpeechAudioRetention(
  raw: unknown,
): SpeechAudioRetentionSettings | null {
  if (raw === undefined || raw === null) {
    return DEFAULT_SERVER_SETTINGS.speechAudioRetention;
  }
  if (!isRecord(raw)) return null;

  const enabled =
    typeof raw.enabled === "boolean"
      ? raw.enabled
      : DEFAULT_SERVER_SETTINGS.speechAudioRetention.enabled;
  const maxAgeDays =
    raw.maxAgeDays === undefined || raw.maxAgeDays === null
      ? DEFAULT_SPEECH_AUDIO_RETENTION_MAX_AGE_DAYS
      : raw.maxAgeDays;
  const maxBytes =
    raw.maxBytes === undefined || raw.maxBytes === null
      ? DEFAULT_SPEECH_AUDIO_RETENTION_MAX_BYTES
      : raw.maxBytes;

  if (
    typeof maxAgeDays !== "number" ||
    !Number.isInteger(maxAgeDays) ||
    maxAgeDays < 1 ||
    maxAgeDays > 3650
  ) {
    return null;
  }
  if (
    typeof maxBytes !== "number" ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1024 * 1024 ||
    maxBytes > 100 * 1024 * 1024 * 1024
  ) {
    return null;
  }

  return { enabled, maxAgeDays, maxBytes };
}

function parsePromptCacheKeepalive(
  raw: unknown,
): PromptCacheKeepaliveSettings | undefined | null {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return undefined;
  if (!isRecord(raw)) return null;

  const rawProviders = raw.providers;
  if (rawProviders === undefined || rawProviders === null) return {};
  if (!isRecord(rawProviders)) return null;

  const providers: PromptCacheKeepaliveSettings["providers"] = {};
  for (const [providerName, rawProviderSetting] of Object.entries(
    rawProviders,
  )) {
    if (!ALL_PROVIDERS.includes(providerName as ProviderName)) return null;
    if (rawProviderSetting === undefined || rawProviderSetting === null) {
      continue;
    }
    if (!isRecord(rawProviderSetting)) return null;

    const setting: {
      mode?: PromptCacheKeepaliveMode;
      inactivityMinutes?: number;
    } = {};
    if ("mode" in rawProviderSetting) {
      if (
        typeof rawProviderSetting.mode !== "string" ||
        !PROMPT_CACHE_KEEPALIVE_MODES.includes(
          rawProviderSetting.mode as PromptCacheKeepaliveMode,
        )
      ) {
        return null;
      }
      setting.mode = rawProviderSetting.mode as PromptCacheKeepaliveMode;
    }
    if ("inactivityMinutes" in rawProviderSetting) {
      const value = rawProviderSetting.inactivityMinutes;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 1440
      ) {
        return null;
      }
      setting.inactivityMinutes = value;
    }
    if (Object.keys(setting).length > 0) {
      providers[providerName as ProviderName] = setting;
    }
  }

  return { providers };
}

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono {
  const app = new Hono();
  const {
    serverSettingsService,
    onAllowedHostsChanged,
    onRemoteSessionPersistenceChanged,
    onOllamaUrlChanged,
    onOllamaSystemPromptChanged,
    onOllamaUseFullSystemPromptChanged,
    onGrokBuildUseXaiApiKeyChanged,
    publicShareService,
  } = deps;

  /**
   * GET /api/settings
   * Get all server settings
   */
  app.get("/", (c) => {
    const settings = serverSettingsService.getSettings();
    return c.json({ settings });
  });

  /**
   * PUT /api/settings
   * Update server settings
   */
  app.put("/", async (c) => {
    const body = await c.req.json<Partial<ServerSettings>>();

    const updates: Partial<ServerSettings> = {};

    // Handle boolean settings
    if (typeof body.serviceWorkerEnabled === "boolean") {
      updates.serviceWorkerEnabled = body.serviceWorkerEnabled;
    }
    if (typeof body.persistRemoteSessionsToDisk === "boolean") {
      updates.persistRemoteSessionsToDisk = body.persistRemoteSessionsToDisk;
    }
    if (typeof body.clientLogCollectionRequested === "boolean") {
      updates.clientLogCollectionRequested = body.clientLogCollectionRequested;
    }
    if (typeof body.publicSharesEnabled === "boolean") {
      updates.publicSharesEnabled = body.publicSharesEnabled;
    }
    if (typeof body.composeAnchorsEnabled === "boolean") {
      updates.composeAnchorsEnabled = body.composeAnchorsEnabled;
    }
    if ("deferredJoinWindowSeconds" in body) {
      if (
        body.deferredJoinWindowSeconds === undefined ||
        body.deferredJoinWindowSeconds === null
      ) {
        updates.deferredJoinWindowSeconds = undefined;
      } else if (
        typeof body.deferredJoinWindowSeconds === "number" &&
        Number.isFinite(body.deferredJoinWindowSeconds) &&
        body.deferredJoinWindowSeconds >= 0
      ) {
        updates.deferredJoinWindowSeconds = body.deferredJoinWindowSeconds;
      } else {
        return c.json(
          {
            error:
              "deferredJoinWindowSeconds must be a non-negative number of seconds (0 = never join)",
          },
          400,
        );
      }
    }

    if ("yaClientBaseUrl" in body) {
      if (
        body.yaClientBaseUrl === undefined ||
        body.yaClientBaseUrl === null ||
        body.yaClientBaseUrl === ""
      ) {
        updates.yaClientBaseUrl = undefined;
        updates.publicShareViewerBaseUrl = undefined;
      } else if (typeof body.yaClientBaseUrl === "string") {
        try {
          updates.yaClientBaseUrl = normalizeYaClientBaseUrl(
            body.yaClientBaseUrl,
          );
          updates.publicShareViewerBaseUrl = undefined;
        } catch (error) {
          return c.json(
            {
              error: error instanceof Error ? error.message : "Invalid YA URL",
            },
            400,
          );
        }
      } else {
        return c.json({ error: "yaClientBaseUrl must be a string URL" }, 400);
      }
    } else if ("publicShareViewerBaseUrl" in body) {
      if (
        body.publicShareViewerBaseUrl === undefined ||
        body.publicShareViewerBaseUrl === null ||
        body.publicShareViewerBaseUrl === ""
      ) {
        updates.yaClientBaseUrl = undefined;
        updates.publicShareViewerBaseUrl = undefined;
      } else if (typeof body.publicShareViewerBaseUrl === "string") {
        try {
          updates.yaClientBaseUrl = normalizeYaClientBaseUrlFromShareViewerUrl(
            body.publicShareViewerBaseUrl,
          );
          updates.publicShareViewerBaseUrl = undefined;
        } catch (error) {
          return c.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Invalid public share viewer URL",
            },
            400,
          );
        }
      } else {
        return c.json(
          { error: "publicShareViewerBaseUrl must be a string URL" },
          400,
        );
      }
    }

    // Handle remoteExecutors array
    if (Array.isArray(body.remoteExecutors)) {
      const { hosts, invalidHost } = parseHostAliasList(body.remoteExecutors);
      if (invalidHost) {
        return c.json(
          { error: `Invalid remote executor host alias: ${invalidHost}` },
          400,
        );
      }
      updates.remoteExecutors = hosts;
    }

    // Handle chromeOsHosts array
    if (Array.isArray(body.chromeOsHosts)) {
      const { hosts, invalidHost } = parseHostAliasList(body.chromeOsHosts);
      if (invalidHost) {
        return c.json(
          { error: `Invalid ChromeOS host alias: ${invalidHost}` },
          400,
        );
      }
      updates.chromeOsHosts = hosts;
    }

    // Handle allowedHosts string ("*", comma-separated hostnames, or undefined to clear)
    if ("allowedHosts" in body) {
      if (
        body.allowedHosts === undefined ||
        body.allowedHosts === null ||
        body.allowedHosts === ""
      ) {
        updates.allowedHosts = undefined;
      } else if (typeof body.allowedHosts === "string") {
        updates.allowedHosts = body.allowedHosts;
      }
    }

    // Handle globalInstructions string (free-form text, or undefined/null/"" to clear)
    if ("globalInstructions" in body) {
      if (
        body.globalInstructions === undefined ||
        body.globalInstructions === null ||
        body.globalInstructions === ""
      ) {
        updates.globalInstructions = undefined;
      } else if (typeof body.globalInstructions === "string") {
        updates.globalInstructions = body.globalInstructions.slice(0, 10000);
      }
    }

    if ("agentContextHints" in body) {
      const parsedHints = parseAgentContextHints(
        body.agentContextHints,
        serverSettingsService.getSetting("agentContextHints"),
      );
      if (parsedHints === null) {
        return c.json({ error: "Invalid agentContextHints setting" }, 400);
      }
      updates.agentContextHints = parsedHints;
    }

    if ("heartbeatTurnsAfterMinutes" in body) {
      if (
        body.heartbeatTurnsAfterMinutes === undefined ||
        body.heartbeatTurnsAfterMinutes === null
      ) {
        updates.heartbeatTurnsAfterMinutes =
          DEFAULT_SERVER_SETTINGS.heartbeatTurnsAfterMinutes;
      } else if (
        typeof body.heartbeatTurnsAfterMinutes === "number" &&
        Number.isInteger(body.heartbeatTurnsAfterMinutes) &&
        body.heartbeatTurnsAfterMinutes >= 1 &&
        body.heartbeatTurnsAfterMinutes <= 1440
      ) {
        updates.heartbeatTurnsAfterMinutes = body.heartbeatTurnsAfterMinutes;
      } else {
        return c.json(
          {
            error:
              "heartbeatTurnsAfterMinutes must be an integer between 1 and 1440",
          },
          400,
        );
      }
    }

    if ("heartbeatTurnText" in body) {
      if (
        body.heartbeatTurnText === undefined ||
        body.heartbeatTurnText === null ||
        body.heartbeatTurnText === ""
      ) {
        updates.heartbeatTurnText = DEFAULT_SERVER_SETTINGS.heartbeatTurnText;
      } else if (typeof body.heartbeatTurnText === "string") {
        updates.heartbeatTurnText = body.heartbeatTurnText.slice(0, 200);
      }
    }

    // Handle ollamaUrl string (URL, or undefined/null/"" to clear)
    if ("ollamaUrl" in body) {
      if (
        body.ollamaUrl === undefined ||
        body.ollamaUrl === null ||
        body.ollamaUrl === ""
      ) {
        updates.ollamaUrl = undefined;
      } else if (typeof body.ollamaUrl === "string") {
        updates.ollamaUrl = body.ollamaUrl;
      }
    }

    // Handle ollamaSystemPrompt string (free-form text, or undefined/null/"" to clear)
    if ("ollamaSystemPrompt" in body) {
      if (
        body.ollamaSystemPrompt === undefined ||
        body.ollamaSystemPrompt === null ||
        body.ollamaSystemPrompt === ""
      ) {
        updates.ollamaSystemPrompt = undefined;
      } else if (typeof body.ollamaSystemPrompt === "string") {
        updates.ollamaSystemPrompt = body.ollamaSystemPrompt.slice(0, 10000);
      }
    }

    // Handle ollamaUseFullSystemPrompt boolean
    if (typeof body.ollamaUseFullSystemPrompt === "boolean") {
      updates.ollamaUseFullSystemPrompt = body.ollamaUseFullSystemPrompt;
    }

    if (typeof body.grokBuildUseXaiApiKey === "boolean") {
      updates.grokBuildUseXaiApiKey = body.grokBuildUseXaiApiKey;
    }

    // Handle deviceBridgeEnabled boolean
    if (typeof body.deviceBridgeEnabled === "boolean") {
      updates.deviceBridgeEnabled = body.deviceBridgeEnabled;
    }

    if ("newSessionDefaults" in body) {
      const parsedDefaults = parseNewSessionDefaults(body.newSessionDefaults);
      if (parsedDefaults === null) {
        return c.json({ error: "Invalid newSessionDefaults setting" }, 400);
      }
      updates.newSessionDefaults = parsedDefaults;
    }

    if ("clientDefaults" in body) {
      const parsedDefaults = parseClientDefaults(body.clientDefaults);
      if (parsedDefaults === null) {
        return c.json({ error: "Invalid clientDefaults setting" }, 400);
      }
      updates.clientDefaults = mergeClientDefaults(
        serverSettingsService.getSetting("clientDefaults"),
        parsedDefaults,
      );
    }

    if ("speechAudioRetention" in body) {
      const parsedRetention = parseSpeechAudioRetention(
        body.speechAudioRetention,
      );
      if (parsedRetention === null) {
        return c.json({ error: "Invalid speechAudioRetention setting" }, 400);
      }
      updates.speechAudioRetention = parsedRetention;
    }

    if ("helperTargets" in body) {
      const parsedTargets = parseHelperTargets(body.helperTargets);
      if (parsedTargets === null) {
        return c.json({ error: "Invalid helperTargets setting" }, 400);
      }
      updates.helperTargets = parsedTargets;
    }

    if ("promptCacheKeepalive" in body) {
      const parsedKeepalive = parsePromptCacheKeepalive(
        body.promptCacheKeepalive,
      );
      if (parsedKeepalive === null) {
        return c.json(
          {
            error: `promptCacheKeepalive must configure provider modes (${PROMPT_CACHE_KEEPALIVE_MODES.join(
              ", ",
            )}) and integer inactivityMinutes between 1 and 1440 (default ${DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES})`,
          },
          400,
        );
      }
      updates.promptCacheKeepalive = parsedKeepalive;
    }

    if (typeof body.lifecycleWebhooksEnabled === "boolean") {
      updates.lifecycleWebhooksEnabled = body.lifecycleWebhooksEnabled;
    }
    if (typeof body.lifecycleWebhookDryRun === "boolean") {
      updates.lifecycleWebhookDryRun = body.lifecycleWebhookDryRun;
    }
    if ("lifecycleWebhookUrl" in body) {
      if (
        body.lifecycleWebhookUrl === undefined ||
        body.lifecycleWebhookUrl === null ||
        body.lifecycleWebhookUrl === ""
      ) {
        updates.lifecycleWebhookUrl = undefined;
      } else if (typeof body.lifecycleWebhookUrl === "string") {
        updates.lifecycleWebhookUrl = body.lifecycleWebhookUrl.slice(0, 2000);
      }
    }
    if ("lifecycleWebhookToken" in body) {
      if (
        body.lifecycleWebhookToken === undefined ||
        body.lifecycleWebhookToken === null ||
        body.lifecycleWebhookToken === ""
      ) {
        updates.lifecycleWebhookToken = undefined;
      } else if (typeof body.lifecycleWebhookToken === "string") {
        updates.lifecycleWebhookToken = body.lifecycleWebhookToken.slice(
          0,
          5000,
        );
      }
    }

    if ("codexUpdatePolicy" in body) {
      if (
        body.codexUpdatePolicy === undefined ||
        body.codexUpdatePolicy === null
      ) {
        updates.codexUpdatePolicy = DEFAULT_SERVER_SETTINGS.codexUpdatePolicy;
      } else if (
        typeof body.codexUpdatePolicy === "string" &&
        CODEX_UPDATE_POLICIES.includes(
          body.codexUpdatePolicy as CodexUpdatePolicy,
        )
      ) {
        updates.codexUpdatePolicy = body.codexUpdatePolicy as CodexUpdatePolicy;
      } else {
        return c.json(
          { error: "codexUpdatePolicy must be one of: auto, notify, off" },
          400,
        );
      }
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "At least one valid setting is required" }, 400);
    }

    const settings = await serverSettingsService.updateSettings(updates);

    // Apply allowedHosts change to middleware at runtime
    if ("allowedHosts" in updates && onAllowedHostsChanged) {
      onAllowedHostsChanged(settings.allowedHosts);
    }
    if (
      "persistRemoteSessionsToDisk" in updates &&
      onRemoteSessionPersistenceChanged
    ) {
      await onRemoteSessionPersistenceChanged(
        settings.persistRemoteSessionsToDisk,
      );
    }
    if ("ollamaUrl" in updates && onOllamaUrlChanged) {
      onOllamaUrlChanged(settings.ollamaUrl);
    }
    if ("ollamaSystemPrompt" in updates && onOllamaSystemPromptChanged) {
      onOllamaSystemPromptChanged(settings.ollamaSystemPrompt);
    }
    if (
      "ollamaUseFullSystemPrompt" in updates &&
      onOllamaUseFullSystemPromptChanged
    ) {
      onOllamaUseFullSystemPromptChanged(
        settings.ollamaUseFullSystemPrompt ?? false,
      );
    }
    if ("grokBuildUseXaiApiKey" in updates && onGrokBuildUseXaiApiKeyChanged) {
      onGrokBuildUseXaiApiKeyChanged(settings.grokBuildUseXaiApiKey ?? false);
    }
    if (updates.publicSharesEnabled === false && publicShareService) {
      await publicShareService.revokeAllShares();
    }

    return c.json({ settings });
  });

  /**
   * GET /api/settings/remote-executors
   * Get list of configured remote executors
   */
  app.get("/remote-executors", (c) => {
    const settings = serverSettingsService.getSettings();
    return c.json({ executors: settings.remoteExecutors ?? [] });
  });

  /**
   * POST /api/settings/helper-targets/models
   * Discover model ids exposed by an OpenAI-compatible helper endpoint.
   */
  app.post("/helper-targets/models", async (c) => {
    const body = await c.req.json<{ baseUrl?: unknown }>();
    const baseUrl = normalizeOpenAiCompatibleBaseUrl(body.baseUrl);
    if (!baseUrl) {
      return c.json({ error: "baseUrl must be an http(s) URL" }, 400);
    }

    const models = await discoverOpenAiCompatibleModels(baseUrl);
    if (!models) {
      return c.json({ error: "Failed to load helper target models" }, 502);
    }

    return c.json({ baseUrl, models });
  });

  /**
   * PUT /api/settings/remote-executors
   * Update list of remote executors
   */
  app.put("/remote-executors", async (c) => {
    const body = await c.req.json<{ executors: string[] }>();

    if (!Array.isArray(body.executors)) {
      return c.json({ error: "executors must be an array" }, 400);
    }

    const { hosts: validExecutors, invalidHost } = parseHostAliasList(
      body.executors,
    );
    if (invalidHost) {
      return c.json(
        { error: `Invalid remote executor host alias: ${invalidHost}` },
        400,
      );
    }

    await serverSettingsService.updateSettings({
      remoteExecutors: validExecutors,
    });

    return c.json({ executors: validExecutors });
  });

  /**
   * POST /api/settings/remote-executors/:host/test
   * Test SSH connection to a remote executor
   */
  app.post("/remote-executors/:host/test", async (c) => {
    const host = normalizeSshHostAlias(c.req.param("host"));

    if (!host) {
      return c.json({ error: "host is required" }, 400);
    }
    if (!isValidSshHostAlias(host)) {
      return c.json({ error: "host must be a valid SSH host alias" }, 400);
    }

    const result = await testSSHConnection(host);
    return c.json(result);
  });

  return app;
}
