import type { SpeechBackend } from "./SpeechBackend.js";

/**
 * The dummy backend is always available and always returns a canned
 * transcript. It exists to validate end-to-end audio plumbing through
 * the new server-routed speech path before any real backend
 * (Deepgram, local Whisper) is wired in. It does not consume audio.
 */
export const DUMMY_TRANSCRIPT =
  "Dummy server backend response. Audio was not transcribed.";

export class DummyBackend implements SpeechBackend {
  readonly id = "ya-dummy";
  readonly label = "YA dummy (test only)";

  async validate(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async transcribe(_audio: Buffer): Promise<string> {
    return DUMMY_TRANSCRIPT;
  }
}
