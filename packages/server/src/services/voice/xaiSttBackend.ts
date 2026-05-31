import { getLogger } from "../../logging/logger.js";
import type {
  SpeechBackend,
  SpeechStreamDone,
  SpeechStreamHandlers,
  SpeechStreamOptions,
  SpeechStreamSession,
  TranscribeOptions,
} from "./SpeechBackend.js";
import WebSocket from "ws";

const logger = getLogger();

const STT_URL = "https://api.x.ai/v1/stt";
const STT_WS_URL = "wss://api.x.ai/v1/stt";
const XAI_STT_STREAM_TIMEOUT_MS = 30_000;

interface XaiSttResponse {
  text?: string;
}

interface XaiSttStreamEvent {
  type?: string;
  text?: string;
  message?: string;
  is_final?: boolean;
  speech_final?: boolean;
  duration?: number;
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
  readonly capabilities = { streaming: true } as const;

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
    form.append("language", "en");
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
      throw new Error(
        `xAI STT transcription failed (HTTP ${res.status}): ${text}`,
      );
    }

    const data = (await res.json()) as XaiSttResponse;
    const transcript = data.text ?? "";
    logger.debug(`xAI STT transcript: "${transcript.slice(0, 80)}"`);
    return transcript;
  }

  async stream(
    options: SpeechStreamOptions,
    handlers: SpeechStreamHandlers = {},
  ): Promise<SpeechStreamSession> {
    const url = new URL(STT_WS_URL);
    url.searchParams.set("sample_rate", String(options.sampleRate));
    url.searchParams.set("encoding", options.encoding);
    url.searchParams.set(
      "interim_results",
      options.interimResults === false ? "false" : "true",
    );
    url.searchParams.set("endpointing", String(options.endpointingMs ?? 250));
    url.searchParams.set("language", options.language ?? "en");

    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    let ready = false;
    let settled = false;
    let doneText = "";
    let doneDuration: number | undefined;
    let resolveOpen!: (session: SpeechStreamSession) => void;
    let rejectOpen!: (err: Error) => void;
    let resolveDone!: (done: SpeechStreamDone) => void;
    let rejectDone!: (err: Error) => void;
    const openPromise = new Promise<SpeechStreamSession>((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    const donePromise = new Promise<SpeechStreamDone>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // `openPromise` is what callers await first. If the upstream stream fails
    // before opening, `donePromise` may reject before a session is returned.
    void donePromise.catch(() => undefined);
    const timeout = setTimeout(() => {
      const error = new Error("xAI STT streaming timed out");
      rejectIfPending(error);
      ws.close();
    }, XAI_STT_STREAM_TIMEOUT_MS);

    const session: SpeechStreamSession = {
      sendAudio(audio: Buffer) {
        if (!ready || ws.readyState !== WebSocket.OPEN) return;
        ws.send(audio);
      },
      finish() {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio.done" }));
        }
        return donePromise;
      },
      close() {
        clearTimeout(timeout);
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close();
        }
      },
    };

    const fail = (message: string) => {
      const error = new Error(message);
      rejectIfPending(error);
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };

    const rejectIfPending = (error: Error) => {
      if (!ready) rejectOpen(error);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectDone(error);
      }
    };

    ws.on("message", (data) => {
      let event: XaiSttStreamEvent;
      try {
        event = JSON.parse(data.toString()) as XaiSttStreamEvent;
      } catch {
        fail("xAI STT streaming returned non-JSON event");
        return;
      }

      if (event.type === "transcript.created") {
        ready = true;
        resolveOpen(session);
        return;
      }

      if (event.type === "transcript.partial") {
        const text = event.text ?? "";
        if (text) doneText = text;
        handlers.onPartial?.({
          text,
          isFinal: event.is_final,
          speechFinal: event.speech_final,
        });
        return;
      }

      if (event.type === "transcript.done") {
        doneText = event.text ?? doneText;
        doneDuration = event.duration;
        settled = true;
        clearTimeout(timeout);
        resolveDone({ text: doneText, duration: doneDuration });
        ws.close();
        return;
      }

      if (event.type === "error") {
        fail(event.message ?? "xAI STT streaming error");
      }
    });

    ws.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      rejectIfPending(error);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      if (!ready) {
        rejectOpen(new Error("xAI STT streaming closed before ready"));
        return;
      }
      if (!settled) {
        settled = true;
        resolveDone({ text: doneText, duration: doneDuration });
      }
    });

    return openPromise;
  }
}
