import { fetchJSON } from "../../api/client";
import {
  appendSpeechTranscript,
  computeSpeechDelta,
} from "../speechRecognition";
import {
  INITIAL_SPEECH_STATE,
  type SpeechProvider,
  type SpeechTranscriptionResultMetadata,
  type SpeechProviderOptions,
  type SpeechProviderState,
  type SpeechProviderSubscriber,
} from "./SpeechProvider";

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

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}

interface TranscribeResponse {
  text: string;
  transcriptionId?: string;
}

interface SpeechWsMessage {
  type?: "ready" | "interim" | "final" | "error";
  text?: string;
  message?: string;
  transcriptionId?: string;
  isFinal?: boolean;
  speechFinal?: boolean;
}

const STREAM_SAMPLE_RATE = 24_000;
const STREAM_MIME_TYPE = `audio/pcm;rate=${STREAM_SAMPLE_RATE};encoding=s16le`;

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  );
}

function speechWsUrl(basePath: string): string {
  const normalizedBase = basePath.replace(/\/$/, "");
  const url = new URL(`${normalizedBase}/api/speech/ws`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function floatToInt16Pcm(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const ratio = sampleRate / STREAM_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(samples.length / ratio));
  const buffer = new ArrayBuffer(outputLength * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    const count = Math.max(1, end - start);
    for (let j = start; j < end; j += 1) {
      sum += samples[j] ?? 0;
    }
    const sample = Math.max(-1, Math.min(1, sum / count));
    view.setInt16(
      i * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }

  return buffer;
}

/**
 * Speech provider that records audio locally and transcribes it through YA.
 *
 * Batch mode records Opus/WebM chunks and posts the complete utterance to
 * /api/speech/transcribe. Streaming mode captures Web Audio samples, converts
 * them to PCM16, and sends them through YA's speech WebSocket for backends
 * that advertise streaming support.
 */
export class YaServerProvider implements SpeechProvider {
  readonly id: string;
  readonly isSupported: boolean;

  private state: SpeechProviderState = { ...INITIAL_SPEECH_STATE };
  private readonly subscribers = new Set<SpeechProviderSubscriber>();
  private readonly options: SpeechProviderOptions;
  private readonly backendId: string;
  private readonly basePath: string;

  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private audioSource: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private chunks: Blob[] = [];
  private mimeType = "audio/webm";
  private submitOnStop = false;
  private streamingFinalReceived = false;
  private streamingCommittedTranscript = "";
  private startToken = 0;
  private disposed = false;

  constructor(
    backendId: string,
    basePath: string,
    options: SpeechProviderOptions = {},
  ) {
    this.backendId = backendId;
    this.basePath = basePath;
    this.id = `ya-server-${backendId}`;
    this.options = options;
    const hasMic =
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia;
    const hasStreamingCapture =
      getAudioContextConstructor() !== null && typeof WebSocket !== "undefined";
    const hasBatchCapture = typeof MediaRecorder !== "undefined";
    this.isSupported =
      typeof window !== "undefined" &&
      hasMic &&
      (options.serverStreaming ? hasStreamingCapture : hasBatchCapture);
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
    if (this.options.serverStreaming) {
      await this.doStartStreaming(token);
      return;
    }

    await this.doStartBatch(token);
  }

  private async doStartBatch(token: number): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.disposed || token !== this.startToken) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      return;
    }
    this.stream = stream;
    this.mimeType = preferredMimeType();
    this.chunks = [];
    this.submitOnStop = true;

    const recorder = new MediaRecorder(stream, {
      mimeType: this.mimeType,
      audioBitsPerSecond: 32_000,
    });
    this.recorder = recorder;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (token === this.startToken && this.submitOnStop && e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };
    recorder.onstop = () => {
      if (token === this.startToken && this.submitOnStop) {
        void this.transcribeRecording();
      }
    };

    recorder.start(250); // 250ms chunks
    this.setState({ status: "listening", isListening: true, error: null });
  }

  private async doStartStreaming(token: number): Promise<void> {
    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor || typeof WebSocket === "undefined") {
      throw new Error("Streaming speech capture is not supported");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (this.disposed || token !== this.startToken) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      return;
    }

    this.stream = stream;
    this.mimeType = STREAM_MIME_TYPE;
    this.streamingFinalReceived = false;
    this.streamingCommittedTranscript = "";
    const ws = new WebSocket(speechWsUrl(this.basePath));
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Speech streaming connection failed"));
    });
    if (this.disposed || token !== this.startToken) {
      ws.close();
      this.stopTracks();
      return;
    }

    ws.onerror = () => {
      this.handleStreamingMessage(
        JSON.stringify({
          type: "error",
          message: "Speech streaming connection failed",
        }),
      );
    };
    ws.onmessage = (event) => {
      this.handleStreamingMessage(event.data);
    };
    ws.onclose = () => {
      if (
        !this.disposed &&
        !this.streamingFinalReceived &&
        this.state.status === "receiving"
      ) {
        const message = "Speech streaming connection closed before final text";
        this.setState({
          status: "error",
          isListening: false,
          interimTranscript: "",
          error: message,
        });
        this.options.onError?.(message);
        this.options.onEnd?.();
      }
    };

    ws.send(
      JSON.stringify({
        type: "start",
        backendId: this.backendId,
        mimeType: this.mimeType,
        streaming: true,
        sampleRate: STREAM_SAMPLE_RATE,
        encoding: "pcm",
        context: this.options.getTranscriptionContext?.(),
      }),
    );

    const audioContext = new AudioContextCtor();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    if (this.disposed || token !== this.startToken) {
      await audioContext.close();
      ws.close();
      this.stopTracks();
      return;
    }

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (
        token !== this.startToken ||
        this.disposed ||
        ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      const pcm = floatToInt16Pcm(
        event.inputBuffer.getChannelData(0),
        audioContext.sampleRate,
      );
      ws.send(pcm);
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    this.audioContext = audioContext;
    this.audioSource = source;
    this.processor = processor;
    this.silentGain = silentGain;
    this.setState({ status: "listening", isListening: true, error: null });
  }

  private handleStreamingMessage(data: unknown): void {
    const text = typeof data === "string" ? data : String(data);
    let message: SpeechWsMessage;
    try {
      message = JSON.parse(text) as SpeechWsMessage;
    } catch {
      return;
    }

    if (message.type === "interim") {
      const transcript = message.text ?? "";
      if (message.isFinal || message.speechFinal) {
        this.commitStreamingTranscript(transcript);
        return;
      }
      const interim = this.getStreamingTranscriptDelta(transcript);
      this.setState({ interimTranscript: interim });
      this.options.onInterimResult?.(interim);
      return;
    }

    if (message.type === "final") {
      this.streamingFinalReceived = true;
      this.cleanupStreamingMedia();
      const metadata = message.transcriptionId
        ? { transcriptionId: message.transcriptionId }
        : undefined;
      const committed = this.commitStreamingTranscript(
        message.text ?? "",
        metadata,
      );
      if (!committed && metadata) {
        this.options.onResult?.("", metadata);
      }
      this.setState({
        status: "idle",
        isListening: false,
        interimTranscript: "",
        error: null,
      });
      this.options.onEnd?.();
      this.ws?.close();
      this.ws = null;
      return;
    }

    if (message.type === "error") {
      const error = message.message ?? "Speech streaming error";
      this.cleanupStreamingMedia();
      this.setState({
        status: "error",
        isListening: false,
        interimTranscript: "",
        error,
      });
      this.options.onError?.(error);
      this.options.onEnd?.();
      this.ws?.close();
      this.ws = null;
    }
  }

  private getStreamingTranscriptDelta(transcript: string): string {
    const latest = transcript.trim();
    if (!latest) return "";
    return computeSpeechDelta(
      latest,
      this.streamingCommittedTranscript,
    ).trimStart();
  }

  private commitStreamingTranscript(
    transcript: string,
    metadata?: SpeechTranscriptionResultMetadata,
  ): boolean {
    const latest = transcript.trim();
    const delta = this.getStreamingTranscriptDelta(latest).trim();

    this.setState({ interimTranscript: "" });
    this.options.onInterimResult?.("");

    if (!latest || !delta) return false;

    this.streamingCommittedTranscript = latest.startsWith(
      this.streamingCommittedTranscript,
    )
      ? latest
      : appendSpeechTranscript(this.streamingCommittedTranscript, delta);
    this.options.onResult?.(delta, metadata);
    return true;
  }

  private async transcribeRecording(): Promise<void> {
    this.submitOnStop = false;
    const audio = new Blob(this.chunks, { type: this.mimeType });
    this.chunks = [];
    this.stopTracks();

    try {
      const response =
        audio.size > 0
          ? await fetchJSON<TranscribeResponse>("/speech/transcribe", {
              method: "POST",
              body: JSON.stringify({
                backendId: this.backendId,
                mimeType: this.mimeType,
                audioBase64: await blobToBase64(audio),
                context: this.options.getTranscriptionContext?.(),
              }),
            })
          : { text: "" };
      if (this.disposed) return;
      this.setState({
        status: "idle",
        isListening: false,
        interimTranscript: "",
        error: null,
      });
      if (response.text) {
        this.options.onResult?.(response.text, {
          transcriptionId: response.transcriptionId,
        });
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
    }
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

    if (this.options.serverStreaming) {
      this.cleanupStreamingMedia();
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "stop" }));
      } else {
        this.ws?.close();
        this.ws = null;
      }
      return;
    }

    if (this.recorder?.state !== "inactive") {
      this.recorder?.stop();
    } else {
      void this.transcribeRecording();
    }
  }

  private stopTracks(): void {
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    this.stream = null;
  }

  private cleanupStreamingMedia(): void {
    this.processor?.disconnect();
    this.audioSource?.disconnect();
    this.silentGain?.disconnect();
    this.processor = null;
    this.audioSource = null;
    this.silentGain = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.stopTracks();
  }

  private cleanupMedia(submitOnStop: boolean): void {
    this.submitOnStop = submitOnStop;
    this.cleanupStreamingMedia();
    this.ws?.close();
    this.ws = null;
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
    }
    this.recorder = null;
    if (!submitOnStop) {
      this.chunks = [];
      this.stopTracks();
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
