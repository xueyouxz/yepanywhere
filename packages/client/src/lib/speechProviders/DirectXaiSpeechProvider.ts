import {
  INITIAL_SPEECH_STATE,
  type SpeechProvider,
  type SpeechProviderOptions,
  type SpeechProviderState,
  type SpeechProviderSubscriber,
} from "./SpeechProvider";
import {
  getSpeechMicStream,
  isSharedSpeechMicStream,
  stopSpeechStreamTracks,
} from "./sharedMicCapture";
import {
  getXaiSttCredential,
  type XaiSttCredential,
} from "./xaiCredentials";
import { decideBatchSpeechCommand } from "./speechCommands";

const XAI_STT_URL = "https://api.x.ai/v1/stt";
const DIRECT_STT_TIMEOUT_MS = 30_000;

interface XaiSttResponse {
  text?: string;
}

function preferredMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const mime of candidates) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(mime)
    ) {
      return mime;
    }
  }
  return "audio/webm";
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

async function postDirectXaiStt(
  audio: Blob,
  credential: XaiSttCredential,
): Promise<string> {
  const form = new FormData();
  form.append("format", "true");
  form.append("language", "en");
  // xAI documents that `file` must be the last multipart field.
  const extension = audio.type.includes("ogg")
    ? "ogg"
    : audio.type.includes("webm")
      ? "webm"
      : "bin";
  form.append("file", audio, `speech.${extension}`);

  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    DIRECT_STT_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(XAI_STT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Direct xAI STT request failed: ${detail}`);
  } finally {
    window.clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(
      `xAI STT transcription failed (HTTP ${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as XaiSttResponse;
  return data.text ?? "";
}

/**
 * Browser-to-xAI batch speech provider.
 *
 * This bypasses YA audio routing: the browser records a complete utterance
 * with MediaRecorder and posts the file directly to xAI STT. YA is involved
 * only when the browser has no local key and asks the authenticated server for
 * the explicitly borrowed STT key.
 */
export class DirectXaiSpeechProvider implements SpeechProvider {
  readonly id = "xai-grok-direct-batch";
  readonly isSupported: boolean;

  private state: SpeechProviderState = { ...INITIAL_SPEECH_STATE };
  private readonly subscribers = new Set<SpeechProviderSubscriber>();
  private readonly options: SpeechProviderOptions;

  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private prewarmRequest: Promise<void> | null = null;
  private chunks: Blob[] = [];
  private mimeType = "audio/webm";
  private submitOnStop = false;
  private credential: XaiSttCredential | null = null;
  private startToken = 0;
  private disposed = false;

  constructor(options: SpeechProviderOptions = {}) {
    this.options = options;
    this.isSupported =
      typeof window !== "undefined" &&
      typeof MediaRecorder !== "undefined" &&
      typeof fetch !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia;
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

  private releaseActiveStream(): void {
    if (this.stream && !isSharedSpeechMicStream(this.stream)) {
      stopSpeechStreamTracks(this.stream);
    }
    this.stream = null;
  }

  private getMicStream(): Promise<MediaStream> {
    return getSpeechMicStream({
      keepWarm: this.options.keepMicWarm === true,
      micDeviceId: this.options.micDeviceId,
    });
  }

  prewarm(): void {
    if (this.options.keepMicWarm !== true || !this.isSupported) return;
    if (
      this.state.isListening ||
      this.state.status === "starting" ||
      this.state.status === "receiving"
    ) {
      return;
    }
    const permissions = navigator.permissions;
    if (typeof permissions?.query !== "function") return;
    if (this.prewarmRequest) return;

    this.prewarmRequest = permissions
      .query({ name: "microphone" as PermissionName })
      .then((status) => {
        if (status.state !== "granted" || this.disposed) return;
        void this.getMicStream().catch((err: unknown) => {
          console.warn(
            "[DirectXaiSTT] Warm microphone pre-open failed",
            err instanceof Error ? err.message : String(err),
          );
        });
      })
      .catch(() => undefined)
      .finally(() => {
        this.prewarmRequest = null;
      });
  }

  start(): void {
    if (this.disposed) return;
    if (
      this.state.isListening ||
      this.state.status === "starting" ||
      this.state.status === "receiving"
    ) {
      return;
    }
    const token = ++this.startToken;
    this.setState({ status: "starting", isListening: false, error: null });
    this.doStart(token).catch((err: unknown) => {
      if (this.disposed || token !== this.startToken) return;
      this.cleanupMedia(false);
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ status: "error", isListening: false, error: msg });
      this.options.onError?.(msg);
    });
  }

  private async doStart(token: number): Promise<void> {
    const credential = await getXaiSttCredential();
    if (this.disposed || token !== this.startToken) return;
    const stream = await this.getMicStream();
    if (this.disposed || token !== this.startToken) {
      if (!isSharedSpeechMicStream(stream)) {
        stopSpeechStreamTracks(stream);
      }
      return;
    }

    this.credential = credential;
    this.stream = stream;
    this.mimeType = preferredMimeType();
    this.chunks = [];
    this.submitOnStop = true;

    const recorder = new MediaRecorder(stream, {
      mimeType: this.mimeType,
      audioBitsPerSecond: 32_000,
    });
    this.recorder = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (
        token === this.startToken &&
        this.submitOnStop &&
        event.data.size > 0
      ) {
        this.chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      if (token === this.startToken && this.submitOnStop) {
        void this.transcribeRecording();
      }
    };

    recorder.start(250);
    this.setState({ status: "listening", isListening: true, error: null });
  }

  stop(): void {
    if (this.disposed) return;
    if (this.state.status === "starting") {
      this.startToken += 1;
      this.cleanupMedia(false);
      this.setState({
        status: "idle",
        isListening: false,
        interimTranscript: "",
        error: null,
      });
      this.options.onEnd?.();
      return;
    }
    if (!this.state.isListening) return;
    this.setState({ status: "receiving", isListening: false });

    if (this.recorder?.state !== "inactive") {
      this.recorder?.stop();
    } else {
      void this.transcribeRecording();
    }
  }

  private async transcribeRecording(): Promise<void> {
    this.submitOnStop = false;
    const audio = new Blob(this.chunks, { type: this.mimeType });
    this.chunks = [];
    this.releaseActiveStream();

    try {
      const text =
        audio.size > 0 && this.credential
          ? await postDirectXaiStt(audio, this.credential)
          : "";
      if (this.disposed) return;
      this.setState({
        status: "idle",
        isListening: false,
        interimTranscript: "",
        error: null,
      });
      if (text) {
        const decision = decideBatchSpeechCommand(text);
        this.options.onResult?.(
          decision.transcript,
          decision.recognizedCommand
            ? { smartTurnCommand: decision.command }
            : undefined,
        );
      }
      this.options.onEnd?.();
    } catch (err: unknown) {
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      this.setState({
        status: "error",
        isListening: false,
        interimTranscript: "",
        error: message,
      });
      this.options.onError?.(message);
      this.options.onEnd?.();
    } finally {
      this.credential = null;
    }
  }

  private cleanupMedia(submitOnStop: boolean): void {
    this.submitOnStop = submitOnStop;
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
    }
    this.recorder = null;
    if (!submitOnStop) {
      this.chunks = [];
      this.credential = null;
      this.releaseActiveStream();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.startToken += 1;
    this.cleanupMedia(false);
    this.setState({ ...INITIAL_SPEECH_STATE });
    this.subscribers.clear();
  }
}
