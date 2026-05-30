import {
  INITIAL_SPEECH_STATE,
  type SpeechProvider,
  type SpeechProviderOptions,
  type SpeechProviderState,
  type SpeechProviderSubscriber,
} from "./SpeechProvider";

type ServerMsg =
  | { type: "ready" }
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string };

function buildWsUrl(basePath: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${basePath}/api/speech/ws`;
}

function preferredMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return "audio/webm";
}

/**
 * Speech provider that streams audio over a YA server WebSocket
 * and receives transcript responses (batch, on stop).
 *
 * Audio is captured via MediaRecorder (Opus/WebM) and sent as binary
 * frames. On stop(), a JSON "stop" frame is sent; the server responds
 * with { type: "final", text } once transcription completes.
 */
export class YaServerProvider implements SpeechProvider {
  readonly id: string;
  readonly isSupported: boolean;

  private state: SpeechProviderState = { ...INITIAL_SPEECH_STATE };
  private readonly subscribers = new Set<SpeechProviderSubscriber>();
  private readonly options: SpeechProviderOptions;
  private readonly backendId: string;
  private readonly basePath: string;

  private ws: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;

  constructor(backendId: string, basePath: string, options: SpeechProviderOptions = {}) {
    this.backendId = backendId;
    this.basePath = basePath;
    this.id = `ya-server-${backendId}`;
    this.options = options;
    this.isSupported =
      typeof window !== "undefined" &&
      typeof MediaRecorder !== "undefined" &&
      typeof WebSocket !== "undefined";
  }

  getState(): SpeechProviderState {
    return this.state;
  }

  subscribe(subscriber: SpeechProviderSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private setState(patch: Partial<SpeechProviderState>): void {
    this.state = { ...this.state, ...patch };
    for (const sub of this.subscribers) sub(this.state);
  }

  start(): void {
    if (this.state.isListening) return;
    this.setState({ status: "starting", isListening: false, error: null });
    this.doStart().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ status: "error", isListening: false, error: msg });
      this.options.onError?.(msg);
    });
  }

  private async doStart(): Promise<void> {
    const ws = new WebSocket(buildWsUrl(this.basePath));
    this.ws = ws;

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket connection failed"));
      ws.onclose = () => reject(new Error("WebSocket closed unexpectedly"));
    });

    // Wait for server "ready" handshake
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Server ready timeout")), 6_000);
      ws.onmessage = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data as string) as ServerMsg;
          if (msg.type === "ready") {
            clearTimeout(t);
            resolve();
          } else if (msg.type === "error") {
            clearTimeout(t);
            reject(new Error(msg.message));
          }
        } catch {
          /* ignore parse errors during handshake */
        }
      };
    });

    // Switch to ongoing message handler
    ws.onmessage = (e: MessageEvent) => this.onServerMessage(e);
    ws.onclose = () => {
      if (this.state.isListening || this.state.status === "receiving") {
        this.setState({ status: "error", isListening: false, error: "Connection closed" });
        this.options.onError?.("Connection closed unexpectedly");
        this.options.onEnd?.();
      }
    };

    // Request microphone access
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream = stream;

    const mimeType = preferredMimeType();

    // Tell server which backend + mime we'll use
    ws.send(JSON.stringify({
      type: "start",
      backendId: this.backendId,
      mimeType,
    }));

    const recorder = new MediaRecorder(stream, {
      mimeType,
      audioBitsPerSecond: 16_000,
    });
    this.recorder = recorder;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
        e.data.arrayBuffer().then((buf) => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(buf);
          }
        });
      }
    };

    recorder.start(250); // 250ms chunks
    this.setState({ status: "listening", isListening: true, error: null });
  }

  private onServerMessage(e: MessageEvent): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(e.data as string) as ServerMsg;
    } catch {
      return;
    }

    if (msg.type === "interim") {
      this.setState({ status: "receiving", interimTranscript: msg.text });
      this.options.onInterimResult?.(msg.text);
    } else if (msg.type === "final") {
      this.setState({
        status: "idle",
        isListening: false,
        interimTranscript: "",
      });
      if (msg.text) this.options.onResult?.(msg.text);
      this.options.onEnd?.();
      this.cleanupMedia();
    } else if (msg.type === "error") {
      this.setState({
        status: "error",
        isListening: false,
        error: msg.message,
      });
      this.options.onError?.(msg.message);
      this.options.onEnd?.();
      this.cleanupMedia();
    }
  }

  stop(): void {
    if (!this.state.isListening) return;
    this.setState({ status: "receiving", isListening: false });

    if (this.recorder?.state !== "inactive") {
      this.recorder?.stop();
    }

    // Brief delay so the final ondataavailable fires before we send stop
    setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "stop" }));
      }
    }, 150);
  }

  private cleanupMedia(): void {
    this.recorder?.stop();
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  dispose(): void {
    this.cleanupMedia();
    this.ws?.close();
    this.ws = null;
    this.setState({ ...INITIAL_SPEECH_STATE });
    this.subscribers.clear();
  }
}
