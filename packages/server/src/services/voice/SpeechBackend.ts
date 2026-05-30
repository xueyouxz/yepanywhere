/**
 * Server-side counterpart to the client `SpeechProvider`. Each backend
 * is a candidate for routing audio captured in the browser through
 * YA to a transcription service (cloud API, local Whisper, dummy).
 *
 * Backends are validated at startup; only those that report `enabled`
 * are advertised to clients via the version capability list. The
 * actual audio plumbing is intentionally not represented here yet —
 * Phase 1 only needs registration + advertisement so the client UI
 * can be built and wired against a stable contract.
 */

export interface SpeechBackendInfo {
  /** Stable identifier shared with the client catalog (e.g. "ya-dummy"). */
  id: string;
  /** Human-readable label for diagnostics/logging. */
  label: string;
  /** True when this backend is usable right now (credentials validated, etc.). */
  enabled: boolean;
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
