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

import type { ConnectionSpeechSocket } from "../connection/types";

/** Granular status of a speech recognition session. */
export type SpeechProviderStatus =
  | "idle"
  | "starting"
  | "listening"
  | "receiving"
  | "processing"
  | "finalizing"
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

export interface SpeechTranscriptionContext {
  projectId?: string;
  sessionId?: string;
  clientTurnId?: string;
  draftKey?: string;
  speechTargetId?: string;
}

export type SpeechTurnCommand = "send" | "cancel" | "wait";

export interface SpeechSmartTurnSettings {
  enabled: boolean;
  threshold: number;
  timeoutMs: number;
}

export const DEFAULT_SPEECH_SMART_TURN_SETTINGS: SpeechSmartTurnSettings = {
  enabled: false,
  threshold: 0.95,
  timeoutMs: 3000,
};

export type GrokSpeechAudioUplinkMode = "pcm16" | "browser-compressed";

export interface GrokSpeechAudioSettings {
  uplinkMode: GrokSpeechAudioUplinkMode;
}

export const DEFAULT_GROK_SPEECH_AUDIO_SETTINGS: GrokSpeechAudioSettings = {
  uplinkMode: "pcm16",
};

export interface SpeechWordTimestamp {
  word?: string;
  text?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  duration?: number;
  speaker?: number | string;
}

export interface SpeechTranscriptionResultMetadata {
  transcriptionId?: string;
  speechTargetId?: string;
  smartTurnCommand?: SpeechTurnCommand;
  /**
   * True when a `send` is an automatic Smart Turn *endpoint* send (no spoken
   * command word), as opposed to an explicit spoken `send`. A composer may hold
   * the auto-send when the user has manually edited the draft mid-dictation;
   * an explicit `send` always submits. See topics/mic-button-speech-ui.md.
   */
  smartTurnAutoSend?: boolean;
  /** Replace this many characters immediately before the current speech range. */
  replacePreviousTranscriptChars?: number;
}

/** Events emitted by a provider during a listening session. */
export interface SpeechProviderEvents {
  /** Final transcript delta (only the new text since the last final). */
  onResult?: (
    transcript: string,
    metadata?: SpeechTranscriptionResultMetadata,
  ) => void;
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
  /** Context attached to YA-server transcription requests. */
  getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;
  /** Use the YA speech WebSocket streaming path when the backend supports it. */
  serverStreaming?: boolean;
  /** Smart Turn settings for streaming backends that support it. */
  smartTurn?: SpeechSmartTurnSettings;
  /** Keep the mic device warm between dictations (skips getUserMedia cold-open). */
  keepMicWarm?: boolean;
  /** Browser-local microphone device id for YA-server capture. */
  micDeviceId?: string | null;
  /** Browser-selected local Parakeet model id for YA Parakeet backends. */
  parakeetModel?: string;
  /** Open a dedicated relayed speech socket when YA is reached through relay. */
  openRelayedSpeechSocket?: () => Promise<ConnectionSpeechSocket>;
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

  /**
   * Abandon an in-flight post-capture (`processing`) transcription. The
   * contract is result-suppression, not work-interruption: a transcription
   * that still completes after cancel() must be discarded (no onResult, no
   * state change beyond returning to idle). No-op outside `processing`.
   * Aborting the underlying request/model work is an optional optimization.
   */
  cancel?(): void;

  /** Speculatively acquire reusable resources before the user clicks. */
  prewarm?(): void;

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
  processing: "Transcribing...",
  finalizing: "Finalizing...",
  reconnecting: "Reconnecting...",
  error: "Error",
};
