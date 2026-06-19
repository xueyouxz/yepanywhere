import {
  INITIAL_SPEECH_STATE,
  type SpeechProvider,
  type SpeechProviderOptions,
  type SpeechProviderState,
  type SpeechProviderSubscriber,
  type SpeechTranscriptionContext,
  type SpeechTranscriptionResultMetadata,
  type SpeechTranscriptionSettlementStatus,
} from "./SpeechProvider";
import {
  getSpeechMicStream,
  isSharedSpeechMicStream,
  startSpeechWaveformMonitor,
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

interface DirectBatchRecording {
  token: number;
  chunks: Blob[];
  context?: SpeechTranscriptionContext;
  credential: XaiSttCredential;
  mimeType: string;
  stream: MediaStream;
  submitOnStop: boolean;
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

function releaseSpeechStream(stream: MediaStream | null): void {
  if (stream && !isSharedSpeechMicStream(stream)) {
    stopSpeechStreamTracks(stream);
  }
}

function withSpeechContextMetadata(
  metadata: SpeechTranscriptionResultMetadata | undefined,
  context: SpeechTranscriptionContext | undefined,
): SpeechTranscriptionResultMetadata | undefined {
  if (!context?.speechTargetId) return metadata;
  return { ...metadata, speechTargetId: context.speechTargetId };
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
  private stopWaveformMonitor: (() => void) | null = null;
  private batchRecording: DirectBatchRecording | null = null;
  private mimeType = "audio/webm";
  private startToken = 0;
  // See YaServerProvider: cancel() marks only the in-flight batch token so its
  // late result is discarded, without affecting an overlapping recording's
  // result delivery (every start() bumps startToken).
  private processingBatchToken: number | null = null;
  private cancelledBatchTokens = new Set<number>();
  private pendingBatchContexts = new Map<
    number,
    SpeechTranscriptionContext | undefined
  >();
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
      (this.state.status === "receiving" && this.state.isListening)
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
      (this.state.status === "receiving" && this.state.isListening)
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

    this.stream = stream;
    this.stopWaveformMonitor?.();
    this.stopWaveformMonitor = startSpeechWaveformMonitor(
      stream,
      this.options.onAudioSamples,
    );
    const mimeType = preferredMimeType();
    this.mimeType = mimeType;
    const recording: DirectBatchRecording = {
      token,
      chunks: [],
      context: this.options.getTranscriptionContext?.(),
      credential,
      mimeType,
      stream,
      submitOnStop: true,
    };
    this.batchRecording = recording;
    this.pendingBatchContexts.set(recording.token, recording.context);

    const recorder = new MediaRecorder(stream, {
      mimeType,
      audioBitsPerSecond: 32_000,
    });
    this.recorder = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (
        !this.disposed &&
        recording.submitOnStop &&
        event.data.size > 0
      ) {
        recording.chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      if (this.batchRecording === recording) {
        this.batchRecording = null;
      }
      if (recording.submitOnStop) {
        void this.transcribeRecording(recording);
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
    this.setState({ status: "processing", isListening: false });
    this.stopWaveformMonitor?.();
    this.stopWaveformMonitor = null;

    const recorder = this.recorder;
    const recording = this.batchRecording;
    this.processingBatchToken = recording?.token ?? null;
    this.recorder = null;
    this.batchRecording = null;
    this.stream = null;
    if (recorder?.state !== "inactive") {
      recorder?.stop();
    } else {
      if (recording) void this.transcribeRecording(recording);
    }
  }

  cancel(): void {
    if (this.disposed) return;
    if (this.state.status !== "processing") return;
    // Mark the in-flight transcription so its late result is discarded; the
    // backend request may still complete but stays inert.
    if (this.processingBatchToken !== null) {
      const token = this.processingBatchToken;
      this.cancelledBatchTokens.add(token);
      this.processingBatchToken = null;
      this.settleBatchTranscription(token, "cancelled");
    }
    this.setState({
      status: "idle",
      isListening: false,
      interimTranscript: "",
      error: null,
    });
    this.options.onEnd?.();
  }

  private async transcribeRecording(
    recording: DirectBatchRecording,
  ): Promise<void> {
    recording.submitOnStop = false;
    const audio = new Blob(recording.chunks, { type: recording.mimeType });
    recording.chunks = [];
    releaseSpeechStream(recording.stream);

    let settlementStatus: SpeechTranscriptionSettlementStatus = "cancelled";
    try {
      const text =
        audio.size > 0
          ? await postDirectXaiStt(audio, recording.credential)
          : "";
      if (this.disposed) return;
      // A cancelled pending transcription must be a no-op even though the
      // backend request still completed.
      if (this.cancelledBatchTokens.delete(recording.token)) return;
      if (text) {
        const decision = decideBatchSpeechCommand(text);
        this.options.onResult?.(
          decision.transcript,
          withSpeechContextMetadata(
            decision.recognizedCommand
              ? { smartTurnCommand: decision.command }
              : undefined,
            recording.context,
          ),
        );
      } else {
        const metadata = withSpeechContextMetadata(undefined, recording.context);
        if (metadata) this.options.onResult?.("", metadata);
      }
      settlementStatus = "completed";
      if (
        recording.token === this.startToken &&
        !this.state.isListening &&
        this.state.status === "processing"
      ) {
        this.setState({
          status: "idle",
          isListening: false,
          interimTranscript: "",
          error: null,
        });
        this.options.onEnd?.();
      }
    } catch (err: unknown) {
      if (this.disposed) return;
      // A cancelled pending transcription is a no-op even when it fails: the
      // user already abandoned it, so do not surface its error.
      if (this.cancelledBatchTokens.delete(recording.token)) return;
      const message = err instanceof Error ? err.message : String(err);
      settlementStatus = "error";
      this.options.onError?.(message);
      if (
        recording.token === this.startToken &&
        !this.state.isListening &&
        this.state.status === "processing"
      ) {
        this.setState({
          status: "error",
          isListening: false,
          interimTranscript: "",
          error: message,
        });
        this.options.onEnd?.();
      }
    } finally {
      if (this.processingBatchToken === recording.token) {
        this.processingBatchToken = null;
      }
      this.settleBatchTranscription(recording.token, settlementStatus);
    }
  }

  private settleBatchTranscription(
    token: number,
    status: SpeechTranscriptionSettlementStatus,
  ): void {
    const context = this.pendingBatchContexts.get(token);
    if (!this.pendingBatchContexts.delete(token)) return;
    this.options.onTranscriptionSettled?.({
      speechTargetId: context?.speechTargetId,
      status,
    });
  }

  private cleanupMedia(submitOnStop: boolean): void {
    this.stopWaveformMonitor?.();
    this.stopWaveformMonitor = null;
    const recorder = this.recorder;
    const recording = this.batchRecording;
    this.recorder = null;
    this.batchRecording = null;
    if (recording) {
      recording.submitOnStop = submitOnStop;
    }
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    if (!submitOnStop) {
      this.releaseActiveStream();
      if (recording) {
        recording.chunks = [];
        releaseSpeechStream(recording.stream);
        this.settleBatchTranscription(recording.token, "cancelled");
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.startToken += 1;
    for (const token of this.pendingBatchContexts.keys()) {
      this.settleBatchTranscription(token, "cancelled");
    }
    this.processingBatchToken = null;
    this.cancelledBatchTokens.clear();
    this.cleanupMedia(false);
    this.setState({ ...INITIAL_SPEECH_STATE });
    this.subscribers.clear();
  }
}
