import { getLogger } from "../../logging/logger.js";
import type { SpeechBackend, TranscribeOptions } from "./SpeechBackend.js";

const logger = getLogger();

const STT_URL = "https://api.x.ai/v1/stt";

interface XaiSttResponse {
  text?: string;
}

/**
 * xAI Speech-to-Text (Grok voice) cloud backend.
 *
 * Posts a complete utterance to `POST /v1/stt` (multipart) and returns the
 * top-level `text`. The key is YA-private (`YA_stt__XAI_API_KEY`, harvested
 * and stripped from process.env on load) so it never reaches the Grok coding
 * CLI and cannot flip that subscription to metered billing — see
 * topics/cost-efficiency.md.
 */
export class XaiSttBackend implements SpeechBackend {
  readonly id = "ya-grok";
  readonly label = "Grok (cloud)";

  constructor(private readonly apiKey: string) {}

  async validate(): Promise<{ ok: true } | { ok: false; reason: string }> {
    // The key is scoped to the voice capability, so probing any other endpoint
    // could 401/403 on scope alone and falsely disable us. Presence is the
    // enable signal; a genuinely bad key surfaces on the first transcription.
    return this.apiKey
      ? { ok: true }
      : { ok: false, reason: "YA_stt__XAI_API_KEY is not set" };
  }

  async transcribe(
    audio: Buffer,
    options: TranscribeOptions = {},
  ): Promise<string> {
    const mimeType = options.mimeType ?? "audio/webm;codecs=opus";
    const form = new FormData();
    // Inverse text normalization (spoken numbers/currency -> written form).
    form.append("format", "true");
    for (const term of options.keyterms ?? []) {
      form.append("keyterm", term);
    }
    // Per xAI docs the file field must come last.
    const ext = mimeType.includes("webm") ? "webm" : "bin";
    const bytes = audio.buffer.slice(
      audio.byteOffset,
      audio.byteOffset + audio.byteLength,
    ) as ArrayBuffer;
    form.append("file", new Blob([bytes], { type: mimeType }), `audio.${ext}`);

    const res = await fetch(STT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`xAI STT transcription failed (HTTP ${res.status}): ${text}`);
    }

    const data = (await res.json()) as XaiSttResponse;
    const transcript = data.text ?? "";
    logger.debug(`xAI STT transcript: "${transcript.slice(0, 80)}"`);
    return transcript;
  }
}
