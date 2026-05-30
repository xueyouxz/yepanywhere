/**
 * Provider interface for pluggable speech-recognition backends.
 *
 * Each provider owns its full status state machine, error handling, and
 * any backend-specific quirks (auto-restart, mobile cumulative-final
 * handling, etc.). The consumer hook is a thin subscription layer that
 * does not branch by provider kind.
 *
 * This is Option B in task 006: thick provider, thin hook. Adding a new
 * provider is a one-time investment to straighten out its differences
 * against this contract; no consumer-side plumbing changes per provider.
 */

/** Granular status of a speech recognition session. */
export type SpeechProviderStatus =
  | "idle"
  | "starting"
  | "listening"
  | "receiving"
  | "reconnecting"
  | "error";

/** Snapshot of provider state, published to subscribers on every change. */
export interface SpeechProviderState {
  status: SpeechProviderStatus;
  isListening: boolean;
  /** Live interim transcript (may change). Empty string when idle. */
  interimTranscript: string;
  /** Last error message, or null. */
  error: string | null;
}

/** Events emitted by a provider during a listening session. */
export interface SpeechProviderEvents {
  /** Final transcript delta (only the new text since the last final). */
  onResult?: (transcript: string) => void;
  /** Interim (live) transcript. May fire many times per utterance. */
  onInterimResult?: (transcript: string) => void;
  /** Listening session ended (manual stop, error, or natural end). */
  onEnd?: () => void;
  /** Error event; also reflected in state.error / state.status. */
  onError?: (error: string) => void;
}

/** Options at construction time. */
export interface SpeechProviderOptions extends SpeechProviderEvents {
  /** Language tag, e.g. "en-US". Provider may ignore if not applicable. */
  lang?: string;
}

/** Subscriber callback receiving the latest state snapshot. */
export type SpeechProviderSubscriber = (state: SpeechProviderState) => void;

/**
 * The provider contract. Implementations must:
 * - Maintain their own state machine and publish snapshots via subscribe().
 * - Translate provider-specific quirks into the common status/event shape.
 * - Be safe to start/stop repeatedly; clean up resources on stop/dispose.
 * - Never throw from start/stop; surface failures as error state + onError.
 */
export interface SpeechProvider {
  /** Stable identifier, e.g. "browser-native", "ya-dummy", "ya-deepgram". */
  readonly id: string;

  /**
   * True when this provider can run in the current environment
   * (e.g. browser-native checks for window.SpeechRecognition).
   */
  readonly isSupported: boolean;

  /** Current state snapshot. */
  getState(): SpeechProviderState;

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(subscriber: SpeechProviderSubscriber): () => void;

  /** Begin a listening session. No-op if already listening. */
  start(): void;

  /** End the current session. No-op if not listening. */
  stop(): void;

  /** Release all resources. Provider must not be used after dispose(). */
  dispose(): void;
}

/** Initial state used by all providers. */
export const INITIAL_SPEECH_STATE: SpeechProviderState = {
  status: "idle",
  isListening: false,
  interimTranscript: "",
  error: null,
};

/** Human-readable labels for each status. */
export const SPEECH_STATUS_LABELS: Record<SpeechProviderStatus, string> = {
  idle: "Ready",
  starting: "Connecting...",
  listening: "Listening...",
  receiving: "Receiving...",
  reconnecting: "Reconnecting...",
  error: "Error",
};
