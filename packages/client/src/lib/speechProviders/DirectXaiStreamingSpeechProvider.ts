import type { ConnectionSpeechSocket } from "../connection/types";
import type {
  SpeechProvider,
  SpeechProviderOptions,
  SpeechProviderState,
  SpeechWordTimestamp,
} from "./SpeechProvider";
import { YaServerProvider } from "./YaServerProvider";
import { getXaiSttStreamingSecret } from "./xaiCredentials";

const XAI_STT_WS_URL = "wss://api.x.ai/v1/stt";
const STREAM_SAMPLE_RATE = 16_000;

interface XaiSttStreamEvent {
  type?: string;
  text?: string;
  message?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  words?: SpeechWordTimestamp[];
}

function buildXaiSttUrl(options: SpeechProviderOptions): string {
  const url = new URL(XAI_STT_WS_URL);
  url.searchParams.set("sample_rate", String(STREAM_SAMPLE_RATE));
  url.searchParams.set("encoding", "pcm");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("endpointing", "250");
  url.searchParams.set("language", options.lang ?? "en");
  if (options.smartTurn?.enabled === true) {
    url.searchParams.set("smart_turn", String(options.smartTurn.threshold));
    if (options.smartTurn.timeoutMs > 0) {
      url.searchParams.set(
        "smart_turn_timeout",
        String(options.smartTurn.timeoutMs),
      );
    }
  }
  return url.toString();
}

class DirectXaiSpeechSocket implements ConnectionSpeechSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  private upstreamReady = false;

  constructor(private readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => this.handleMessage(event.data);
    ws.onerror = (event) => this.onerror?.(event);
    ws.onclose = () => this.onclose?.();
  }

  get readyState(): number {
    if (this.ws.readyState === WebSocket.OPEN && !this.upstreamReady) {
      return WebSocket.CONNECTING;
    }
    return this.ws.readyState;
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  send(data: string | ArrayBuffer | Uint8Array | ArrayBufferView): void {
    if (typeof data === "string") {
      this.handleControl(data);
      return;
    }
    if (!this.upstreamReady || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(data);
  }

  close(): void {
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close();
    }
  }

  private handleControl(data: string): void {
    let message: { type?: string };
    try {
      message = JSON.parse(data) as { type?: string };
    } catch {
      return;
    }

    if (message.type === "stop" && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "audio.done" }));
    }
    // `start` is YA's local speech socket control frame. Direct xAI STT is
    // already configured by the WebSocket URL, so there is nothing to forward.
  }

  private handleMessage(data: unknown): void {
    let event: XaiSttStreamEvent;
    try {
      event = JSON.parse(String(data)) as XaiSttStreamEvent;
    } catch {
      this.emit({ type: "error", message: "xAI STT returned non-JSON event" });
      return;
    }

    if (event.type === "transcript.created") {
      this.upstreamReady = true;
      this.emit({ type: "ready" });
      this.onopen?.();
      return;
    }

    if (event.type === "transcript.partial") {
      this.emit({
        type: "interim",
        text: event.text ?? "",
        isFinal: event.is_final,
        speechFinal: event.speech_final,
        start: event.start,
        duration: event.duration,
        words: event.words,
      });
      return;
    }

    if (event.type === "transcript.done") {
      this.emit({ type: "final", text: event.text ?? "" });
      return;
    }

    if (event.type === "error") {
      this.emit({ type: "error", message: event.message ?? "xAI STT error" });
    }
  }

  private emit(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

async function openDirectXaiStreamingSocket(
  options: SpeechProviderOptions,
): Promise<ConnectionSpeechSocket> {
  const secret = await getXaiSttStreamingSecret();
  if (typeof WebSocket === "undefined") {
    throw new Error("Direct xAI streaming requires browser WebSocket support");
  }
  const ws = new WebSocket(buildXaiSttUrl(options), [
    `xai-client-secret.${secret.clientSecret}`,
  ]);
  return new DirectXaiSpeechSocket(ws);
}

/**
 * Browser-to-xAI streaming speech provider.
 *
 * Reuses YA's existing Web Audio -> PCM16 capture path while replacing the YA
 * speech socket with a direct xAI STT WebSocket authenticated by the
 * browser-compatible `xai-client-secret.*` subprotocol.
 */
export class DirectXaiStreamingSpeechProvider implements SpeechProvider {
  readonly id = "xai-grok-direct-streaming";

  private readonly delegate: YaServerProvider;

  constructor(options: SpeechProviderOptions = {}) {
    this.delegate = new YaServerProvider("xai-grok-direct-streaming", "", {
      ...options,
      serverStreaming: true,
      openRelayedSpeechSocket: () => openDirectXaiStreamingSocket(options),
    });
  }

  get isSupported(): boolean {
    return this.delegate.isSupported;
  }

  getState(): SpeechProviderState {
    return this.delegate.getState();
  }

  subscribe(subscriber: (state: SpeechProviderState) => void): () => void {
    return this.delegate.subscribe(subscriber);
  }

  start(): void {
    this.delegate.start();
  }

  stop(): void {
    this.delegate.stop();
  }

  prewarm(): void {
    this.delegate.prewarm();
  }

  dispose(): void {
    this.delegate.dispose();
  }
}
