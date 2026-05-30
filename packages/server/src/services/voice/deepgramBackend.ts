import { getLogger } from "../../logging/logger.js";
import type { SpeechBackend, TranscribeOptions } from "./SpeechBackend.js";

const logger = getLogger();

const LISTEN_URL = "https://api.deepgram.com/v1/listen";
const PROJECTS_URL = "https://api.deepgram.com/v1/projects";

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{ transcript?: string }>;
    }>;
  };
}

export class DeepgramBackend implements SpeechBackend {
  readonly id = "ya-deepgram";
  readonly label = "Deepgram (cloud)";

  constructor(private readonly apiKey: string) {}

  async validate(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const res = await fetch(PROJECTS_URL, {
        headers: { Authorization: `Token ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: `Deepgram API key rejected (HTTP ${res.status})` };
      }
      return { ok: false, reason: `Deepgram API returned HTTP ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        reason: `Deepgram unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async transcribe(audio: Buffer, options: TranscribeOptions = {}): Promise<string> {
    const params = new URLSearchParams({
      model: "nova-3",
      smart_format: "true",
    });
    for (const term of options.keyterms ?? []) {
      params.append("keyterm", term);
    }

    const mimeType = options.mimeType ?? "audio/webm;codecs=opus";
    const url = `${LISTEN_URL}?${params}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": mimeType,
      },
      body: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Deepgram transcription failed (HTTP ${res.status}): ${text}`);
    }

    const data = (await res.json()) as DeepgramResponse;
    const transcript =
      data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    logger.debug(`Deepgram transcript: "${transcript.slice(0, 80)}"`);
    return transcript;
  }
}
