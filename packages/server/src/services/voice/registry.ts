import { getLogger } from "../../logging/logger.js";
import { DeepgramBackend } from "./deepgramBackend.js";
import { DummyBackend } from "./dummyBackend.js";
import { LocalNemoBackend } from "./localNemoBackend.js";
import { LocalParakeetBackend } from "./localParakeetBackend.js";
import { LocalWhisperBackend } from "./localWhisperBackend.js";
import type {
  SpeechBackend,
  SpeechBackendCapabilities,
  SpeechBackendInfo,
} from "./SpeechBackend.js";
import { XaiSttBackend } from "./xaiSttBackend.js";

const logger = getLogger();

/**
 * Server-side registry of speech backends.
 *
 * On startup, each candidate backend is validated; only those that pass are
 * advertised to clients via `voiceBackends` on the version response. The
 * registry also serves as the dispatch table for speech transcription routes.
 */
export class SpeechBackendRegistry {
  private readonly entries = new Map<
    string,
    { info: SpeechBackendInfo; backend: SpeechBackend }
  >();
  private readonly validations = new Set<Promise<void>>();

  /** Currently enabled backend ids in insertion order. */
  enabledIds(): string[] {
    return [...this.entries.values()]
      .filter(({ info }) => info.enabled)
      .map(({ info }) => info.id);
  }

  /** All configured backend ids, including pending and disabled entries. */
  knownIds(): string[] {
    return [...this.entries.keys()];
  }

  /** All known backends, including disabled ones, for diagnostics. */
  allInfo(): SpeechBackendInfo[] {
    return [...this.entries.values()].map(({ info }) => info);
  }

  /** Capabilities for currently enabled backend ids. */
  enabledCapabilities(): Record<string, SpeechBackendCapabilities> {
    return Object.fromEntries(
      [...this.entries.values()]
        .filter(({ info }) => info.enabled)
        .map(({ info }) => [info.id, info.capabilities ?? {}]),
    );
  }

  /** True when the given id is currently enabled. */
  isEnabled(id: string): boolean {
    return this.entries.get(id)?.info.enabled ?? false;
  }

  /** Return an enabled backend by id, or null if unknown/disabled. */
  getBackend(id: string): SpeechBackend | null {
    const entry = this.entries.get(id);
    if (!entry?.info.enabled) return null;
    return entry.backend;
  }

  register(backend: SpeechBackend): void {
    // Record configured backends immediately for discovery, but keep them out
    // of the routable set until validation succeeds. This separates "known"
    // from "usable" instead of optimistically weakening enabled semantics.
    const info: SpeechBackendInfo = {
      id: backend.id,
      label: backend.label,
      enabled: false,
      validationStatus: "pending",
      capabilities: backend.capabilities ?? {},
    };
    this.entries.set(backend.id, { info, backend });

    const validation = backend
      .validate()
      .then((result) => {
        info.enabled = result.ok;
        info.validationStatus = result.ok ? "enabled" : "disabled";
        if (result.ok) {
          info.disabledReason = undefined;
          logger.info(`[Voice] Backend "${backend.id}" enabled`);
        } else {
          info.disabledReason = result.reason;
          logger.warn(
            `[Voice] Backend "${backend.id}" disabled: ${result.reason}`,
          );
        }
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : String(error ?? "unknown");
        info.enabled = false;
        info.validationStatus = "disabled";
        info.disabledReason = message;
        logger.warn(
          `[Voice] Backend "${backend.id}" validate threw: ${message}`,
        );
      })
      .finally(() => {
        this.validations.delete(validation);
      });
    this.validations.add(validation);
  }

  /** Wait for startup validations currently in flight; useful for tests/tools. */
  async waitForValidation(): Promise<void> {
    await Promise.all([...this.validations]);
  }
}

export interface SpeechRegistryInitOptions {
  /** Master switch — when false, no backends are registered. */
  voiceInputEnabled?: boolean;
  /** Explicit backend ids from YEP_VOICE_BACKENDS (cloud keys auto-enable separately). */
  voiceBackends?: string[];
  /**
   * Deepgram API key (from YEP_STT_DEEPGRAM_API_KEY) for ya-deepgram. When set,
   * the backend is auto-enabled — presence of the key is the opt-in signal.
   */
  deepgramApiKey?: string;
  /**
   * xAI key (from YEP_STT_XAI_API_KEY) for ya-grok. When set, the backend is
   * auto-enabled even if not listed in voiceBackends — presence of the key is
   * the opt-in signal.
   */
  xaiSttApiKey?: string;
  /** Whisper model name (default: distil-large-v3). */
  whisperModel?: string;
  /** Whisper device (default: cpu). */
  whisperDevice?: string;
  /** Whisper compute type (default: int8). */
  whisperComputeType?: string;
  /** Parakeet fallback model name (default: nvidia/parakeet-tdt-0.6b-v3). */
  parakeetModel?: string;
  /** Parakeet device (default: auto). */
  parakeetDevice?: string;
  /** NeMo Parakeet fallback model name (default: nvidia/parakeet-tdt-0.6b-v3). */
  nemoModel?: string;
  /** NeMo Parakeet device (default: auto). */
  nemoDevice?: string;
}

export async function initSpeechBackendRegistry(
  options: SpeechRegistryInitOptions = {},
): Promise<SpeechBackendRegistry> {
  const registry = new SpeechBackendRegistry();
  await registerSpeechBackends(registry, options);
  return registry;
}

export function getRequestedSpeechBackendIds(
  options: SpeechRegistryInitOptions = {},
): string[] {
  if (options.voiceInputEnabled === false) {
    return [];
  }

  // Cloud STT backends auto-enable when their key is present — a provisioned
  // key is the opt-in signal. Local/test backends stay explicit via
  // YEP_VOICE_BACKENDS. Set keeps insertion order and de-dupes when a key is
  // also listed explicitly.
  const requested = new Set(options.voiceBackends ?? []);
  if (options.deepgramApiKey) {
    requested.add("ya-deepgram");
  }
  if (options.xaiSttApiKey) {
    requested.add("ya-grok");
  }

  return [...requested];
}

export async function registerSpeechBackends(
  registry: SpeechBackendRegistry,
  options: SpeechRegistryInitOptions = {},
): Promise<void> {
  for (const backendId of getRequestedSpeechBackendIds(options)) {
    switch (backendId) {
      case "ya-dummy":
        registry.register(new DummyBackend());
        break;

      case "ya-deepgram": {
        const key = options.deepgramApiKey ?? "";
        if (!key) {
          logger.warn(
            "[Voice] ya-deepgram requested but YEP_STT_DEEPGRAM_API_KEY is not set",
          );
        } else {
          registry.register(new DeepgramBackend(key));
        }
        break;
      }

      case "ya-grok": {
        const key = options.xaiSttApiKey ?? "";
        if (!key) {
          logger.warn(
            "[Voice] ya-grok requested but YEP_STT_XAI_API_KEY is not set",
          );
        } else {
          registry.register(new XaiSttBackend(key));
        }
        break;
      }

      case "ya-whisper":
        registry.register(
          new LocalWhisperBackend({
            model: options.whisperModel,
            device: options.whisperDevice,
            computeType: options.whisperComputeType,
          }),
        );
        break;

      case "ya-parakeet":
        registry.register(
          new LocalParakeetBackend({
            model: options.parakeetModel,
            device: options.parakeetDevice,
          }),
        );
        break;

      case "ya-nemo":
        registry.register(
          new LocalNemoBackend({
            model: options.nemoModel,
            device: options.nemoDevice,
          }),
        );
        break;

      default:
        logger.warn(`[Voice] Unknown speech backend requested: ${backendId}`);
    }
  }
}
