/**
 * Server-side counterpart to the client `SpeechProvider`. Each backend
 * is a candidate for routing audio captured in the browser through
 * YA to a transcription service (cloud API, local Whisper, dummy).
 *
 * Backends are validated at startup; only those that report `enabled`
 * are advertised to clients via the version capability list. Speech
 * routes pass complete utterance audio buffers into this interface. Backends
 * that can accept real-time audio additionally implement the streaming
 * extension below.
 */

export interface SpeechBackendCapabilities {
  /** Backend can accept streaming raw PCM audio and emit interim/final text. */
  streaming?: boolean;
  /** Backend supports xAI-style Smart Turn end-of-turn detection. */
  smartTurn?: boolean;
}

export interface SpeechBackendInfo {
  /** Stable identifier shared with the client catalog (e.g. "ya-dummy"). */
  id: string;
  /** Human-readable label for diagnostics/logging. */
  label: string;
  /** True when this backend is usable right now (credentials validated, etc.). */
  enabled: boolean;
  /** Runtime capabilities available for this backend. */
  capabilities?: SpeechBackendCapabilities;
  /** Optional reason this backend is not enabled (for /api/version diagnostics). */
  disabledReason?: string;
}

export interface TranscribeOptions {
  /** MIME type of the audio buffer (e.g. "audio/webm;codecs=opus"). */
  mimeType?: string;
  /** Free-text context prompt for Whisper-compatible backends. */
  prompt?: string;
  /** Keyword boosts for Deepgram-style backends. */
  keyterms?: string[];
}

export interface SpeechBackend {
  readonly id: string;
  readonly label: string;
  readonly capabilities?: SpeechBackendCapabilities;
  /**
   * Validate credentials/connectivity. Called once at server startup.
   * Implementations should resolve quickly; long-running setup belongs
   * in lazy initialization on first use.
   */
  validate(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Transcribe audio to text. Audio is a complete utterance (press-to-talk
   * batch). Streaming partials are a follow-up.
   */
  transcribe(audio: Buffer, options?: TranscribeOptions): Promise<string>;
}

export interface SpeechStreamOptions extends TranscribeOptions {
  /** Raw audio sample rate in Hz. */
  sampleRate: number;
  /** Raw audio encoding. xAI currently requires signed PCM16 little-endian. */
  encoding: "pcm";
  /** Whether the backend should emit mutable interim transcripts. */
  interimResults?: boolean;
  /** Silence duration before utterance-final events, in milliseconds. */
  endpointingMs?: number;
  /** Language hint when supported by the backend. */
  language?: string;
  /** Smart Turn end-of-turn confidence threshold, 0.0-1.0. */
  smartTurnThreshold?: number;
  /** Maximum Smart Turn silence wait before speech_final, in milliseconds. */
  smartTurnTimeoutMs?: number;
}

export interface SpeechWordTimestamp {
  word?: string;
  text?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  duration?: number;
  speaker?: number | string;
}

export interface SpeechStreamPartial {
  text: string;
  isFinal?: boolean;
  speechFinal?: boolean;
  words?: SpeechWordTimestamp[];
}

export interface SpeechStreamDone {
  text: string;
  duration?: number;
}

export interface SpeechStreamHandlers {
  onPartial?: (event: SpeechStreamPartial) => void;
}

export interface SpeechStreamSession {
  sendAudio(audio: Buffer): void;
  finish(): Promise<SpeechStreamDone>;
  close(): void;
}

export interface StreamingSpeechBackend extends SpeechBackend {
  readonly capabilities: SpeechBackendCapabilities & { streaming: true };
  stream(
    options: SpeechStreamOptions,
    handlers?: SpeechStreamHandlers,
  ): Promise<SpeechStreamSession>;
}

export function supportsStreaming(
  backend: SpeechBackend,
): backend is StreamingSpeechBackend {
  return (
    backend.capabilities?.streaming === true &&
    typeof (backend as { stream?: unknown }).stream === "function"
  );
}
