import { fetchJSON } from "../../api/client";
import type { ConnectionSpeechSocket } from "../connection/types";
import { appendSpeechTranscript } from "../speechRecognition";
import {
  INITIAL_SPEECH_STATE,
  type SpeechProvider,
  type SpeechTurnCommand,
  type SpeechTranscriptionContext,
  type SpeechTranscriptionResultMetadata,
  type SpeechProviderOptions,
  type SpeechProviderState,
  type SpeechProviderSubscriber,
  type SpeechWordTimestamp,
} from "./SpeechProvider";
import {
  getSpeechMicStream,
  isSharedSpeechMicStream,
  SPEECH_CAPTURE_SAMPLE_RATE,
  stopSpeechStreamTracks,
} from "./sharedMicCapture";
import {
  decideBatchSpeechCommand,
  getTrailingTranscriptCommand,
  getWordText,
  normalizeSpeechCommandWord,
  stripTrailingCommandWord,
} from "./speechCommands";

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

function releaseSpeechStream(stream: MediaStream | null): void {
  if (stream && !isSharedSpeechMicStream(stream)) {
    stopSpeechStreamTracks(stream);
  }
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

interface PrewarmResponse {
  ok: boolean;
}

interface SpeechWsMessage {
  type?: "ready" | "interim" | "final" | "error";
  text?: string;
  message?: string;
  transcriptionId?: string;
  isFinal?: boolean;
  speechFinal?: boolean;
  start?: number;
  duration?: number;
  words?: SpeechWordTimestamp[];
}

type SpeechStreamingSocket = WebSocket | ConnectionSpeechSocket;

const STREAM_SAMPLE_RATE = SPEECH_CAPTURE_SAMPLE_RATE;
const STREAM_CHUNK_MS = 100;
const STREAM_CHUNK_SAMPLES = Math.round(
  (STREAM_SAMPLE_RATE * STREAM_CHUNK_MS) / 1000,
);
const SCRIPT_PROCESSOR_BUFFER_SIZE = 1024;
const PCM_FRAME_POOL_SIZE = 16;
const STREAM_MIME_TYPE = `audio/pcm;rate=${STREAM_SAMPLE_RATE};encoding=s16le`;
// If the Web Audio processor never fires within this window the capture
// pipeline is dead (e.g. a mobile AudioContext that refused to resume). Surface
// a real error instead of ending silently with no transcript.
const AUDIO_FLOW_TIMEOUT_MS = 3500;
const SMART_TURN_COMMAND_PAUSE_SECONDS = 0.3;
const STREAMING_AUDIO_SPAN_EPSILON_SECONDS = 0.02;
interface SmartTurnDecision {
  command: SpeechTurnCommand;
  transcript: string;
  recognizedCommand: boolean;
}

export async function prewarmYaServerSpeechBackend(
  backendId: string,
  model?: string,
): Promise<void> {
  await fetchJSON<PrewarmResponse>("/speech/prewarm", {
    method: "POST",
    body: JSON.stringify({
      backendId,
      ...(model ? { model } : {}),
    }),
  });
}

interface PendingSmartTurnCommand {
  command: SpeechTurnCommand;
  recognizedCommand: boolean;
}

interface StreamingTranscriptSpan {
  start: number;
  end: number;
}

interface PendingStreamingFinalPartial {
  transcript: string;
  span: StreamingTranscriptSpan | null;
  groupStart: number | null;
  replaceGroup: boolean;
  words?: SpeechWordTimestamp[];
}

interface BatchRecording {
  token: number;
  chunks: Blob[];
  context?: SpeechTranscriptionContext;
  mimeType: string;
  stream: MediaStream;
  submitOnStop: boolean;
}

interface StreamingCommittedGroup {
  groupStart: number;
  text: string;
  audioEnd: number | null;
}

interface StreamingCommitOptions {
  span?: StreamingTranscriptSpan | null;
  groupStart?: number | null;
  replaceGroup?: boolean;
  words?: SpeechWordTimestamp[];
}

function withSpeechContextMetadata(
  metadata: SpeechTranscriptionResultMetadata | undefined,
  context: SpeechTranscriptionContext | undefined,
): SpeechTranscriptionResultMetadata | undefined {
  if (!context?.speechTargetId) return metadata;
  return { ...metadata, speechTargetId: context.speechTargetId };
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  );
}

function createStreamingAudioContext(
  AudioContextCtor: typeof AudioContext,
): AudioContext {
  try {
    return new AudioContextCtor({
      latencyHint: "interactive",
      sampleRate: STREAM_SAMPLE_RATE,
    });
  } catch {
    try {
      return new AudioContextCtor({ latencyHint: "interactive" });
    } catch {
      return new AudioContextCtor();
    }
  }
}

function speechWsUrl(basePath: string): string {
  const normalizedBase = basePath.replace(/\/$/, "");
  const url = new URL(`${normalizedBase}/api/speech/ws`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function getWordStart(word: SpeechWordTimestamp | undefined): number | null {
  return typeof word?.start === "number" && Number.isFinite(word.start)
    ? word.start
    : null;
}

function getWordEnd(word: SpeechWordTimestamp | undefined): number | null {
  if (!word) return null;
  if (typeof word.end === "number" && Number.isFinite(word.end)) {
    return word.end;
  }
  if (
    typeof word.start === "number" &&
    Number.isFinite(word.start) &&
    typeof word.duration === "number" &&
    Number.isFinite(word.duration)
  ) {
    return word.start + word.duration;
  }
  return null;
}

function getPauseBeforeFinalWordSeconds(
  words: SpeechWordTimestamp[],
): number | null {
  if (words.length <= 1) return Number.POSITIVE_INFINITY;
  const last = words.at(-1);
  const previous = words.at(-2);
  const lastStart = getWordStart(last);
  const previousEnd = getWordEnd(previous);
  if (lastStart === null || previousEnd === null) return null;
  return lastStart - previousEnd;
}

export function decideSmartTurn(
  transcript: string,
  words: SpeechWordTimestamp[] | undefined,
): SmartTurnDecision {
  const trimmed = transcript.trim();
  const finalWord = words?.at(-1);
  const wordCommand = normalizeSpeechCommandWord(getWordText(finalWord));
  const transcriptCommand = getTrailingTranscriptCommand(trimmed);
  const command = wordCommand ?? transcriptCommand;
  const pauseSeconds =
    wordCommand && words ? getPauseBeforeFinalWordSeconds(words) : null;
  // `wait` holds the send eagerly: it skips the pause gate that distinguishes a
  // spoken `send`/`cancel` command from dictation, because a missed `wait`
  // prematurely submits the turn (the disruptive failure) while a missed
  // `send`/`cancel` only fails to act. The cost is that a sentence legitimately
  // ending in "wait" also holds — which is why `wait` stays in the draft (it is
  // not stripped below), making that case a one-click manual send with nothing
  // lost.
  const commandIsAllowed =
    command !== null &&
    (command === "wait" ||
      pauseSeconds === null ||
      pauseSeconds > SMART_TURN_COMMAND_PAUSE_SECONDS);

  if (command && commandIsAllowed) {
    return {
      command,
      recognizedCommand: true,
      // `cancel` clears the owned chunk; `send` is stripped (the turn submits
      // without it); `wait` is left in the draft for a low-friction manual send.
      transcript:
        command === "cancel"
          ? ""
          : command === "send"
            ? stripTrailingCommandWord(trimmed, command)
            : trimmed,
    };
  }
  return { command: "send", transcript: trimmed, recognizedCommand: false };
}

function getMessageWindowSpan(
  message: SpeechWsMessage,
): StreamingTranscriptSpan | null {
  if (
    typeof message.start === "number" &&
    Number.isFinite(message.start) &&
    typeof message.duration === "number" &&
    Number.isFinite(message.duration) &&
    message.duration >= 0
  ) {
    return {
      start: message.start,
      end: message.start + message.duration,
    };
  }

  return null;
}

function getWordTimestampSpan(
  words: readonly SpeechWordTimestamp[],
): StreamingTranscriptSpan | null {
  const firstStart = getWordStart(words[0]);
  const lastEnd = getWordEnd(words.at(-1));
  if (firstStart === null || lastEnd === null || lastEnd < firstStart) {
    return null;
  }
  return { start: firstStart, end: lastEnd };
}

function getStreamingMessageSpan(
  message: SpeechWsMessage,
): StreamingTranscriptSpan | null {
  return (
    getWordTimestampSpan(message.words ?? []) ?? getMessageWindowSpan(message)
  );
}

function getStreamingMessageGroupStart(
  message: SpeechWsMessage,
): number | null {
  if (typeof message.start === "number" && Number.isFinite(message.start)) {
    return message.start;
  }
  return getWordTimestampSpan(message.words ?? [])?.start ?? null;
}

function getTranscriptFromWords(words: readonly SpeechWordTimestamp[]): string {
  return words.reduce(
    (transcript, word) => appendSpeechTranscript(transcript, getWordText(word)),
    "",
  );
}

function getTranscriptAfterAudioTime(
  words: readonly SpeechWordTimestamp[] | undefined,
  audioTimeSeconds: number,
): string | null {
  if (!words?.length) return null;
  const tailWords = words.filter((word) => {
    const start = getWordStart(word);
    if (start !== null) {
      return start >= audioTimeSeconds - STREAMING_AUDIO_SPAN_EPSILON_SECONDS;
    }
    const end = getWordEnd(word);
    return (
      end !== null &&
      end > audioTimeSeconds + STREAMING_AUDIO_SPAN_EPSILON_SECONDS
    );
  });
  return getTranscriptFromWords(tailWords);
}

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

interface Pcm16Frame {
  readonly view: Int16Array;
  readonly dataView: DataView;
  samples: number;
}

function createPcm16Frame(): Pcm16Frame {
  const buffer = new ArrayBuffer(
    STREAM_CHUNK_SAMPLES * Int16Array.BYTES_PER_ELEMENT,
  );
  return {
    view: new Int16Array(buffer),
    dataView: new DataView(buffer),
    samples: 0,
  };
}

function pcm16FramePayload(frame: Pcm16Frame): ArrayBufferView {
  return frame.samples === frame.view.length
    ? frame.view
    : frame.view.subarray(0, frame.samples);
}

class Pcm16Chunker {
  private readonly available: Pcm16Frame[] = Array.from(
    { length: PCM_FRAME_POOL_SIZE },
    () => createPcm16Frame(),
  );
  private current = createPcm16Frame();
  private offset = 0;

  constructor(private readonly onFrame: (frame: Pcm16Frame) => void) {}

  release(frame: Pcm16Frame): void {
    frame.samples = 0;
    this.available.push(frame);
  }

  flush(): void {
    if (this.offset === 0) return;
    const frame = this.current;
    frame.samples = this.offset;
    this.current = this.available.pop() ?? createPcm16Frame();
    this.offset = 0;
    this.onFrame(frame);
  }

  writeFloatSamples(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0) return;
    const ratio =
      Number.isFinite(sampleRate) && sampleRate > 0
        ? sampleRate / STREAM_SAMPLE_RATE
        : 1;
    const outputLength = Math.max(1, Math.round(samples.length / ratio));

    for (let i = 0; i < outputLength; i += 1) {
      const start = Math.min(samples.length - 1, Math.floor(i * ratio));
      // Span at least one input sample. When the context runs below the target
      // rate (ratio < 1) the naive window can be empty and would otherwise
      // write silence for a slice of output samples, attenuating capture.
      const end = Math.max(
        start + 1,
        Math.min(samples.length, Math.floor((i + 1) * ratio)),
      );
      let sum = 0;
      for (let j = start; j < end; j += 1) {
        sum += samples[j] ?? 0;
      }
      this.writeSample(sum / (end - start));
    }
  }

  private writeSample(sample: number): void {
    const clamped = Math.max(-1, Math.min(1, sample));
    const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (IS_LITTLE_ENDIAN) {
      this.current.view[this.offset] = pcm;
    } else {
      this.current.dataView.setInt16(this.offset * 2, pcm, true);
    }
    this.offset += 1;
    if (this.offset === STREAM_CHUNK_SAMPLES) {
      this.flush();
    }
  }
}

function describeAudioTrackSettings(stream: MediaStream): string | null {
  const track =
    typeof stream.getAudioTracks === "function"
      ? stream.getAudioTracks()[0]
      : undefined;
  const settings = track?.getSettings?.();
  if (!settings) return null;
  const part = (label: string, value: unknown): string =>
    `${label}=${value ?? "?"}`;
  return [
    "track settings",
    part("rate", settings.sampleRate),
    part("channels", settings.channelCount),
    part("sampleSize", settings.sampleSize),
    part("ec", settings.echoCancellation),
    part("ns", settings.noiseSuppression),
    part("agc", settings.autoGainControl),
  ].join(" ");
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
  private prewarmRequest: Promise<void> | null = null;
  // backendId:model already warmed this session, so a repeated pointer-near
  // does not re-hit /speech/prewarm. Cleared on failure to allow a retry.
  private prewarmedBackendKey: string | null = null;
  private ws: SpeechStreamingSocket | null = null;
  private audioContext: AudioContext | null = null;
  private audioSource: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private pcmChunker: Pcm16Chunker | null = null;
  private batchRecording: BatchRecording | null = null;
  private mimeType = "audio/webm";
  private streamingContext: SpeechTranscriptionContext | undefined;
  private streamingFinalReceived = false;
  private streamingCommittedTranscript = "";
  private streamingCommittedAudioEnd: number | null = null;
  private streamingCommittedGroups: StreamingCommittedGroup[] = [];
  private streamingCurrentPreviewTranscript = "";
  private streamingStopRequested = false;
  private pendingStreamingFinalPartials: PendingStreamingFinalPartial[] = [];
  private pendingSmartTurnCommand: PendingSmartTurnCommand | null = null;
  private audioFlowWatchdog: ReturnType<typeof setTimeout> | null = null;
  private audioProcessorActive = false;
  private startToken = 0;
  // Token of the batch recording currently in post-capture transcription, and
  // tokens whose pending transcription the user cancelled. startToken alone
  // cannot signal cancel: every start() bumps it, and an earlier overlapping
  // recording must still deliver its result to its target. cancel() marks only
  // the in-flight token so its late result becomes a no-op.
  private processingBatchToken: number | null = null;
  private cancelledBatchTokens = new Set<number>();
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

  private getMicStream(): Promise<MediaStream> {
    return getSpeechMicStream({
      keepWarm: this.options.keepMicWarm === true,
      micDeviceId: this.options.micDeviceId,
    });
  }

  private async openStreamingSocket(): Promise<SpeechStreamingSocket> {
    if (this.options.openRelayedSpeechSocket) {
      return this.options.openRelayedSpeechSocket();
    }
    const ws = new WebSocket(speechWsUrl(this.basePath));
    ws.binaryType = "arraybuffer";
    return ws;
  }

  prewarm(): void {
    if (this.options.keepMicWarm !== true || !this.isSupported) return;
    if (
      this.state.isListening ||
      this.state.status === "starting" ||
      this.state.status === "finalizing" ||
      (this.state.status === "receiving" && this.state.isListening)
    ) {
      return;
    }
    // Warm the server STT model alongside the mic so the first dictation skips
    // the backend's cold model load (e.g. parakeet's ~20s first-load). This is
    // a one-shot /speech/prewarm HTTP call — no audio, no held WebSocket — and
    // needs no mic permission, so it runs even where the mic warm cannot.
    this.prewarmBackendModel();
    const permissions = navigator.permissions;
    if (typeof permissions?.query !== "function") return;
    if (this.prewarmRequest) return;

    this.prewarmRequest = permissions
      .query({ name: "microphone" as PermissionName })
      .then((status) => {
        if (status.state !== "granted" || this.disposed) return;
        void this.getMicStream().catch((err: unknown) => {
          console.warn(
            "[YaSTT] Warm microphone pre-open failed",
            err instanceof Error ? err.message : String(err),
          );
        });
      })
      .catch(() => undefined)
      .finally(() => {
        this.prewarmRequest = null;
      });
  }

  private prewarmBackendModel(): void {
    const model =
      this.backendId === "ya-parakeet" || this.backendId === "ya-nemo"
        ? this.options.parakeetModel
        : undefined;
    const key = `${this.backendId}:${model ?? ""}`;
    if (this.prewarmedBackendKey === key) return;
    this.prewarmedBackendKey = key;
    void prewarmYaServerSpeechBackend(this.backendId, model).catch(
      (err: unknown) => {
        // Let a later pointer-near retry a failed warm.
        if (this.prewarmedBackendKey === key) this.prewarmedBackendKey = null;
        console.warn(
          "[YaSTT] Speech model prewarm failed",
          err instanceof Error ? err.message : String(err),
        );
      },
    );
  }

  start(): void {
    if (this.disposed) return;
    if (
      this.state.isListening ||
      this.state.status === "starting" ||
      this.state.status === "finalizing" ||
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
    if (this.options.serverStreaming) {
      await this.doStartStreaming(token);
      return;
    }

    await this.doStartBatch(token);
  }

  private async doStartBatch(token: number): Promise<void> {
    const stream = await this.getMicStream();
    if (this.disposed || token !== this.startToken) {
      if (!isSharedSpeechMicStream(stream)) {
        stopSpeechStreamTracks(stream);
      }
      return;
    }
    this.stream = stream;
    const mimeType = preferredMimeType();
    this.mimeType = mimeType;
    const recording: BatchRecording = {
      token,
      chunks: [],
      context: this.options.getTranscriptionContext?.(),
      mimeType,
      stream,
      submitOnStop: true,
    };
    this.batchRecording = recording;

    const recorder = new MediaRecorder(stream, {
      mimeType,
      audioBitsPerSecond: 32_000,
    });
    this.recorder = recorder;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (!this.disposed && recording.submitOnStop && e.data.size > 0) {
        recording.chunks.push(e.data);
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

    recorder.start(250); // 250ms chunks
    this.setState({ status: "listening", isListening: true, error: null });
  }

  private async doStartStreaming(token: number): Promise<void> {
    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor || typeof WebSocket === "undefined") {
      throw new Error("Streaming speech capture is not supported");
    }

    // Greppable startup timing so a multi-second "connecting" window can be
    // localized to a specific step (mic acquisition vs. socket vs. resume vs.
    // first audio frame) from the console or remote client logs.
    const startedAt = performance.now();
    const mark = (label: string): void => {
      console.log(
        `[YaSTT] +${Math.round(performance.now() - startedAt)}ms ${label}`,
      );
    };
    mark("start");

    // Create and resume the AudioContext synchronously, before any await, so the
    // resume runs inside the click's user-activation window. iOS/Android refuse
    // to start an AudioContext resumed outside a user gesture; resuming after
    // `await getUserMedia` previously left capture dead on mobile.
    const audioContext = createStreamingAudioContext(AudioContextCtor);
    this.audioContext = audioContext;
    const resumePromise =
      audioContext.state === "suspended"
        ? audioContext.resume()
        : Promise.resolve();
    // Do not swallow a rejected resume. We still build the graph (connecting a
    // source can start the context on some browsers), but if it truly never
    // runs no processor callback fires, "listening" is never shown, and the
    // audio-flow watchdog surfaces a visible error.
    resumePromise.catch((err: unknown) => {
      console.warn("[YaSTT] AudioContext.resume() rejected", err);
    });

    const abandonContext = (): void => {
      void audioContext.close();
      if (this.audioContext === audioContext) this.audioContext = null;
    };

    // Open the socket in parallel with mic acquisition and graph setup. Relay
    // mode pairs and resumes a second secure channel here; the audio graph
    // must not wait for that handshake, or the first speech frames are lost.
    const socketPromise = this.openStreamingSocket();
    const closePendingSocket = (): void => {
      void socketPromise.then((socket) => socket.close()).catch(() => {});
    };

    mark("getUserMedia call");
    let stream: MediaStream;
    try {
      stream = await this.getMicStream();
    } catch (err) {
      closePendingSocket();
      throw err;
    }
    if (this.disposed || token !== this.startToken) {
      if (!isSharedSpeechMicStream(stream)) {
        stopSpeechStreamTracks(stream);
      }
      abandonContext();
      closePendingSocket();
      return;
    }
    mark("getUserMedia ready");
    const trackSettings = describeAudioTrackSettings(stream);
    if (trackSettings) mark(trackSettings);

    this.stream = stream;
    this.mimeType = STREAM_MIME_TYPE;
    this.streamingFinalReceived = false;
    this.streamingCommittedTranscript = "";
    this.streamingCommittedAudioEnd = null;
    this.streamingCommittedGroups = [];
    this.streamingCurrentPreviewTranscript = "";
    this.streamingStopRequested = false;
    this.pendingStreamingFinalPartials = [];
    this.pendingSmartTurnCommand = null;
    this.streamingContext = this.options.getTranscriptionContext?.();

    // Build the capture graph immediately: the mic is live now, so begin
    // capturing at once and buffer PCM frames until the socket handshake
    // completes. Waiting for the socket/resume here is what dropped the first
    // seconds of speech.
    let ws: SpeechStreamingSocket | null = null;
    let socketReady = false;
    const pendingFrames: Pcm16Frame[] = [];
    const sentFrames: Pcm16Frame[] = [];
    let pcmChunker: Pcm16Chunker;
    const releaseTransmittedFrames = (): void => {
      if (!ws) return;
      if (ws.bufferedAmount !== 0) return;
      while (sentFrames.length > 0) {
        const frame = sentFrames.pop();
        if (frame) pcmChunker.release(frame);
      }
    };
    const sendPcmFrameNow = (frame: Pcm16Frame): void => {
      if (!ws) {
        pendingFrames.push(frame);
        return;
      }
      releaseTransmittedFrames();
      ws.send(pcm16FramePayload(frame));
      sentFrames.push(frame);
    };
    const sendPcmFrame = (frame: Pcm16Frame): void => {
      if (socketReady && ws?.readyState === WebSocket.OPEN) {
        sendPcmFrameNow(frame);
      } else {
        pendingFrames.push(frame);
      }
    };
    pcmChunker = new Pcm16Chunker(sendPcmFrame);
    this.pcmChunker = pcmChunker;
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(
      SCRIPT_PROCESSOR_BUFFER_SIZE,
      1,
      1,
    );
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    this.audioProcessorActive = false;
    let loudnessFramesLeft = 6;
    processor.onaudioprocess = (event) => {
      if (token !== this.startToken || this.disposed) return;
      const input = event.inputBuffer.getChannelData(0);
      if (!this.audioProcessorActive) {
        // First real callback: capture is genuinely live. Only now flip to
        // "listening" so the indicator never claims to record while the
        // pipeline is dead (a suspended context never reaches this point).
        this.audioProcessorActive = true;
        this.clearAudioFlowWatchdog();
        mark(`first audio frame (rate=${audioContext.sampleRate})`);
        this.setState({ status: "listening", isListening: true, error: null });
      }
      if (loudnessFramesLeft > 0) {
        let peak = 0;
        for (let i = 0; i < input.length; i += 1) {
          const a = Math.abs(input[i] ?? 0);
          if (a > peak) peak = a;
        }
        mark(`frame peak=${peak.toFixed(3)}`);
        loudnessFramesLeft -= 1;
      }
      pcmChunker.writeFloatSamples(input, audioContext.sampleRate);
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    this.audioSource = source;
    this.processor = processor;
    this.silentGain = silentGain;
    this.startAudioFlowWatchdog(token);
    mark("graph built");

    const sendStartAndFlush = (): void => {
      if (!ws) return;
      if (this.disposed || token !== this.startToken) {
        ws.close();
        return;
      }
      mark("ws open");
      ws.send(
        JSON.stringify({
          type: "start",
          backendId: this.backendId,
          mimeType: this.mimeType,
          streaming: true,
          sampleRate: STREAM_SAMPLE_RATE,
          encoding: "pcm",
          context: this.streamingContext,
          smartTurn:
            this.options.smartTurn?.enabled === true
              ? {
                  enabled: true,
                  threshold: this.options.smartTurn.threshold,
                  timeoutMs: this.options.smartTurn.timeoutMs,
                }
              : undefined,
        }),
      );
      socketReady = true;
      for (const frame of pendingFrames) {
        if (ws.readyState === WebSocket.OPEN) {
          sendPcmFrameNow(frame);
        } else {
          pcmChunker.release(frame);
        }
      }
      pendingFrames.length = 0;
    };

    try {
      ws = await socketPromise;
    } catch (err) {
      this.cleanupStreamingMedia();
      throw err;
    }
    if (this.disposed || token !== this.startToken) {
      ws.close();
      return;
    }
    this.ws = ws;
    ws.onerror = () => {
      if (this.disposed || token !== this.startToken) return;
      this.handleStreamingMessage(
        JSON.stringify({
          type: "error",
          message: "Speech streaming connection failed",
        }),
        token,
      );
    };
    ws.onmessage = (event: MessageEvent | { data: unknown }) => {
      this.handleStreamingMessage(event.data, token);
    };
    ws.onclose = () => {
      if (
        !this.disposed &&
        token === this.startToken &&
        !this.streamingFinalReceived &&
        (this.state.status === "receiving" ||
          this.state.status === "finalizing")
      ) {
        const message = "Speech streaming connection closed before final text";
        const salvaged = this.commitStreamingTranscript(
          this.getUncommittedStreamingPreviewText(
            this.streamingCurrentPreviewTranscript,
          ),
        );
        this.setState({
          status:
            salvaged || this.streamingCommittedTranscript ? "idle" : "error",
          isListening: false,
          interimTranscript: "",
          error: salvaged || this.streamingCommittedTranscript ? null : message,
        });
        if (!salvaged && !this.streamingCommittedTranscript) {
          this.options.onError?.(message);
        }
        this.options.onEnd?.();
      }
    };

    if (ws.readyState === WebSocket.OPEN) {
      sendStartAndFlush();
    } else {
      ws.onopen = sendStartAndFlush;
    }
  }

  private startAudioFlowWatchdog(token: number): void {
    this.clearAudioFlowWatchdog();
    this.audioFlowWatchdog = setTimeout(() => {
      if (
        this.disposed ||
        token !== this.startToken ||
        this.audioProcessorActive
      ) {
        return;
      }
      const message =
        "No microphone audio detected. Check mic permissions and the selected microphone device.";
      this.cleanupStreamingMedia();
      this.setState({
        status: "error",
        isListening: false,
        interimTranscript: "",
        error: message,
      });
      this.options.onError?.(message);
      this.options.onEnd?.();
      this.ws?.close();
      this.ws = null;
    }, AUDIO_FLOW_TIMEOUT_MS);
  }

  private clearAudioFlowWatchdog(): void {
    if (this.audioFlowWatchdog !== null) {
      clearTimeout(this.audioFlowWatchdog);
      this.audioFlowWatchdog = null;
    }
  }

  private handleStreamingMessage(data: unknown, token = this.startToken): void {
    if (this.disposed || token !== this.startToken) return;
    const text = typeof data === "string" ? data : String(data);
    let message: SpeechWsMessage;
    try {
      message = JSON.parse(text) as SpeechWsMessage;
    } catch {
      return;
    }

    if (message.type === "interim") {
      const transcript = message.text ?? "";
      const finalPartial =
        message.isFinal === true || message.speechFinal === true;
      if (this.streamingStopRequested && !finalPartial) return;
      const span = getStreamingMessageSpan(message);
      const groupStart = getStreamingMessageGroupStart(message);
      if (finalPartial && !transcript.trim()) {
        return;
      }
      if (this.streamingStopRequested) {
        this.rememberStreamingFinalPartial(
          transcript,
          span,
          groupStart,
          message.speechFinal === true,
          message.words,
        );
        return;
      }
      if (message.speechFinal) {
        if (this.options.smartTurn?.enabled === true) {
          this.handleSmartTurnSpeechFinal(
            transcript,
            message.words,
            span,
            groupStart,
          );
          return;
        }
        this.commitStreamingTranscript(transcript, undefined, {
          span,
          groupStart,
          replaceGroup: true,
          words: message.words,
        });
        return;
      }
      if (message.isFinal) {
        this.commitStreamingTranscript(transcript, undefined, {
          span,
          groupStart,
          words: message.words,
        });
        return;
      }
      this.setStreamingPreview(transcript);
      return;
    }

    if (message.type === "final") {
      this.streamingFinalReceived = true;
      this.cleanupStreamingMedia();
      const pendingSmartTurn = this.pendingSmartTurnCommand ?? undefined;
      const smartTurnCommand = pendingSmartTurn?.command;
      const pendingFinalPartials = this.pendingStreamingFinalPartials;
      this.pendingSmartTurnCommand = null;
      this.pendingStreamingFinalPartials = [];
      const metadata: SpeechTranscriptionResultMetadata | undefined =
        message.transcriptionId || smartTurnCommand ? {} : undefined;
      if (metadata && message.transcriptionId) {
        metadata.transcriptionId = message.transcriptionId;
      }
      if (metadata && smartTurnCommand) {
        metadata.smartTurnCommand = smartTurnCommand;
      }
      const resultMetadata = withSpeechContextMetadata(
        metadata,
        this.streamingContext,
      );
      // The server's final text can be empty when the end-of-utterance
      // speechFinal races past our stop request, or a hallucinated near-silence
      // token when little audio was captured. A non-empty final may also
      // include text already delivered as `is_final`; commit only the
      // uncommitted tail so manual stop can wait for transcript.done without
      // duplicating prior chunks.
      let finalText = (message.text ?? "").trim();
      // Only `send` is stripped (the turn submits without it); `wait` stays in
      // the draft for a one-click manual send. See decideSmartTurn.
      if (
        finalText &&
        pendingSmartTurn?.recognizedCommand &&
        smartTurnCommand === "send"
      ) {
        finalText = stripTrailingCommandWord(finalText, smartTurnCommand);
      }
      let committed = false;
      let metadataApplied = false;
      if (finalText) {
        committed = this.commitStreamingTranscript(
          this.getUncommittedStreamingFinalText(
            finalText,
            pendingSmartTurn?.recognizedCommand === false,
          ),
          resultMetadata,
        );
        metadataApplied = committed;
      } else if (pendingFinalPartials.length > 0) {
        pendingFinalPartials.forEach((partial, index) => {
          const last = index === pendingFinalPartials.length - 1;
          let transcript = partial.transcript;
          if (
            last &&
            pendingSmartTurn?.recognizedCommand &&
            smartTurnCommand === "send"
          ) {
            transcript = stripTrailingCommandWord(transcript, smartTurnCommand);
          }
          const partialMetadata = last ? metadata : undefined;
          const partialCommitted = this.commitStreamingTranscript(
            transcript,
            withSpeechContextMetadata(partialMetadata, this.streamingContext),
            {
              span: partial.span,
              groupStart: partial.groupStart,
              replaceGroup: partial.replaceGroup,
              words: partial.words,
            },
          );
          committed = partialCommitted || committed;
          if (partialMetadata) metadataApplied = partialCommitted;
        });
      } else {
        committed = this.commitStreamingTranscript(
          this.streamingCurrentPreviewTranscript,
          resultMetadata,
        );
        metadataApplied = committed;
      }
      if (!metadataApplied && resultMetadata) {
        this.options.onResult?.("", resultMetadata);
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
      // A mid-session failure (e.g. an upstream timeout while the user paused
      // expecting Smart Turn to finalize) must not discard already-transcribed
      // words. Commit whatever preview we have and end cleanly; only surface
      // the error when there is nothing to salvage.
      const salvaged = this.commitStreamingTranscript(
        this.getUncommittedStreamingPreviewText(
          this.streamingCurrentPreviewTranscript,
        ),
      );
      if (salvaged || this.streamingCommittedTranscript) {
        this.setState({
          status: "idle",
          isListening: false,
          interimTranscript: "",
          error: null,
        });
        this.options.onEnd?.();
      } else {
        this.setState({
          status: "error",
          isListening: false,
          interimTranscript: "",
          error,
        });
        this.options.onError?.(error);
        this.options.onEnd?.();
      }
      this.ws?.close();
      this.ws = null;
    }
  }

  private handleSmartTurnSpeechFinal(
    transcript: string,
    words: SpeechWordTimestamp[] | undefined,
    span: StreamingTranscriptSpan | null,
    groupStart: number | null,
  ): void {
    const decision = decideSmartTurn(transcript, words);

    if (decision.recognizedCommand && decision.command === "cancel") {
      this.clearStreamingPreview();
      this.options.onResult?.(
        "",
        withSpeechContextMetadata(
          { smartTurnCommand: "cancel" },
          this.streamingContext,
        ),
      );
      return;
    }

    this.pendingSmartTurnCommand = {
      command: decision.command,
      recognizedCommand: decision.recognizedCommand,
    };

    this.commitStreamingTranscript(decision.transcript, undefined, {
      span,
      groupStart,
      replaceGroup: true,
      // Drop the trailing word only when it was stripped from the text (`send`);
      // `wait` keeps its word, so keep its timing too.
      words:
        decision.recognizedCommand && decision.command === "send"
          ? words?.slice(0, -1)
          : words,
    });

    this.streamingStopRequested = true;
    this.cleanupStreamingMedia();
    this.setState({ status: "finalizing", isListening: false, error: null });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "stop" }));
    } else {
      this.ws?.close();
      this.ws = null;
    }
  }

  private setStreamingPreview(transcript: string): void {
    const preview = transcript.trim();
    this.streamingCurrentPreviewTranscript = preview;
    this.setState({ interimTranscript: preview });
    this.options.onInterimResult?.(preview);
  }

  private rememberStreamingFinalPartial(
    transcript: string,
    span: StreamingTranscriptSpan | null,
    groupStart: number | null,
    replaceGroup: boolean,
    words?: SpeechWordTimestamp[],
  ): void {
    const trimmed = transcript.trim();
    if (!trimmed) return;
    this.pendingStreamingFinalPartials.push({
      transcript: trimmed,
      span,
      groupStart,
      replaceGroup,
      words,
    });
  }

  private getUncommittedStreamingFinalText(
    finalText: string,
    commitNonPrefix: boolean,
  ): string {
    const latest = finalText.trim();
    const committed = this.streamingCommittedTranscript.trim();
    if (!latest || !committed) return latest;
    if (latest === committed) return "";
    if (latest.startsWith(committed))
      return latest.slice(committed.length).trim();
    return commitNonPrefix ? latest : "";
  }

  private getUncommittedStreamingPreviewText(previewText: string): string {
    const latest = previewText.trim();
    const committed = this.streamingCommittedTranscript.trim();
    if (!latest || !committed) return latest;
    if (latest === committed) return "";
    if (latest.startsWith(committed))
      return latest.slice(committed.length).trim();
    return latest;
  }

  private clearStreamingPreview(): void {
    this.streamingCurrentPreviewTranscript = "";
    this.setState({ interimTranscript: "" });
    this.options.onInterimResult?.("");
  }

  private getLatestCommittedGroup(
    groupStart: number | null | undefined,
  ): StreamingCommittedGroup | null {
    const index = this.getCommittedGroupIndex(groupStart);
    return index >= 0 && index === this.streamingCommittedGroups.length - 1
      ? this.streamingCommittedGroups[index]!
      : null;
  }

  private getCommittedGroupIndex(
    groupStart: number | null | undefined,
  ): number {
    if (groupStart === null || groupStart === undefined) return -1;
    return this.streamingCommittedGroups.findIndex(
      (group) =>
        Math.abs(group.groupStart - groupStart) <=
        STREAMING_AUDIO_SPAN_EPSILON_SECONDS,
    );
  }

  private getCommittedGroupTextFrom(index: number): string {
    return this.streamingCommittedGroups
      .slice(index)
      .reduce(
        (transcript, group) =>
          appendSpeechTranscript(transcript, group.text.trim()),
        "",
      );
  }

  private recomputeCommittedAudioEnd(): number | null {
    let latest: number | null = null;
    for (const group of this.streamingCommittedGroups) {
      if (group.audioEnd === null) continue;
      if (latest === null || group.audioEnd > latest) latest = group.audioEnd;
    }
    return latest;
  }

  private appendStreamingCommittedGroup(
    latest: string,
    span: StreamingTranscriptSpan | null,
    groupStart: number | null,
  ): void {
    const audioEnd = span?.end ?? null;
    const group = this.getLatestCommittedGroup(groupStart);
    if (group) {
      group.text = appendSpeechTranscript(group.text, latest);
      if (
        audioEnd !== null &&
        (group.audioEnd === null || audioEnd > group.audioEnd)
      ) {
        group.audioEnd = audioEnd;
      }
    } else if (groupStart !== null) {
      this.streamingCommittedGroups.push({
        groupStart,
        text: latest,
        audioEnd,
      });
    }
    if (
      audioEnd !== null &&
      (this.streamingCommittedAudioEnd === null ||
        audioEnd > this.streamingCommittedAudioEnd)
    ) {
      this.streamingCommittedAudioEnd = audioEnd;
    }
  }

  private replaceStreamingCommittedGroup(
    groupIndex: number,
    nextText: string,
    span: StreamingTranscriptSpan | null,
  ): number {
    const group = this.streamingCommittedGroups[groupIndex];
    if (!group) return 0;
    const previousText = this.getCommittedGroupTextFrom(groupIndex);
    const previousAudioEnd = this.streamingCommittedGroups
      .slice(groupIndex)
      .reduce<number | null>((latest, committedGroup) => {
        if (committedGroup.audioEnd === null) return latest;
        return latest === null || committedGroup.audioEnd > latest
          ? committedGroup.audioEnd
          : latest;
      }, null);
    this.streamingCommittedGroups.splice(
      groupIndex,
      this.streamingCommittedGroups.length - groupIndex,
      {
        groupStart: group.groupStart,
        text: nextText,
        audioEnd: span?.end ?? previousAudioEnd,
      },
    );
    if (
      previousText &&
      this.streamingCommittedTranscript.endsWith(previousText)
    ) {
      const before = this.streamingCommittedTranscript
        .slice(0, -previousText.length)
        .trimEnd();
      this.streamingCommittedTranscript = appendSpeechTranscript(
        before,
        nextText,
      );
    } else {
      this.streamingCommittedTranscript = appendSpeechTranscript(
        this.streamingCommittedTranscript,
        nextText,
      );
    }
    this.streamingCommittedAudioEnd = this.recomputeCommittedAudioEnd();
    return previousText.length;
  }

  private commitStreamingTranscript(
    transcript: string,
    metadata?: SpeechTranscriptionResultMetadata,
    options: StreamingCommitOptions = {},
  ): boolean {
    let latest = transcript.trim();
    const span = options.span ?? null;
    const groupStart = options.groupStart ?? span?.start ?? null;
    const group = this.getLatestCommittedGroup(groupStart);
    const groupIndex = this.getCommittedGroupIndex(groupStart);

    if (options.replaceGroup === true && group && group.text.trim()) {
      if (!latest) return false;
      const previousText = group.text.trim();
      if (latest === previousText) {
        this.setState({ interimTranscript: "" });
        this.options.onInterimResult?.("");
        this.streamingCurrentPreviewTranscript = "";
        if (metadata) {
          this.options.onResult?.("", metadata);
          return true;
        }
        return false;
      }
      const replacePreviousTranscriptChars =
        this.replaceStreamingCommittedGroup(groupIndex, latest, span);
      this.setState({ interimTranscript: "" });
      this.options.onInterimResult?.("");
      this.streamingCurrentPreviewTranscript = "";
      this.options.onResult?.(
        latest,
        withSpeechContextMetadata(
          {
            ...metadata,
            replacePreviousTranscriptChars,
          },
          this.streamingContext,
        ),
      );
      return true;
    }

    if (
      options.replaceGroup === true &&
      groupIndex >= 0 &&
      groupIndex < this.streamingCommittedGroups.length - 1
    ) {
      if (!latest) return false;
      const previousText = this.getCommittedGroupTextFrom(groupIndex);
      if (previousText && !latest.startsWith(previousText)) {
        const replacePreviousTranscriptChars =
          this.replaceStreamingCommittedGroup(groupIndex, latest, span);
        this.setState({ interimTranscript: "" });
        this.options.onInterimResult?.("");
        this.streamingCurrentPreviewTranscript = "";
        this.options.onResult?.(
          latest,
          withSpeechContextMetadata(
            {
              ...metadata,
              replacePreviousTranscriptChars,
            },
            this.streamingContext,
          ),
        );
        return true;
      }
    }

    const committedAudioEnd =
      group?.audioEnd ?? this.streamingCommittedAudioEnd;
    if (
      span &&
      committedAudioEnd !== null &&
      span.start < committedAudioEnd - STREAMING_AUDIO_SPAN_EPSILON_SECONDS
    ) {
      const tail = getTranscriptAfterAudioTime(
        options.words,
        committedAudioEnd,
      );
      if (tail !== null) {
        latest = tail.trim();
      } else if (
        span.end <=
        committedAudioEnd + STREAMING_AUDIO_SPAN_EPSILON_SECONDS
      ) {
        latest = "";
      }
    }

    if (!latest) return false;

    this.setState({ interimTranscript: "" });
    this.options.onInterimResult?.("");
    this.streamingCommittedTranscript = appendSpeechTranscript(
      this.streamingCommittedTranscript,
      latest,
    );
    this.appendStreamingCommittedGroup(latest, span, groupStart);
    this.streamingCurrentPreviewTranscript = "";
    this.options.onResult?.(
      latest,
      withSpeechContextMetadata(metadata, this.streamingContext),
    );
    return true;
  }

  private async transcribeRecording(recording: BatchRecording): Promise<void> {
    recording.submitOnStop = false;
    const audio = new Blob(recording.chunks, { type: recording.mimeType });
    recording.chunks = [];
    releaseSpeechStream(recording.stream);

    try {
      const response =
        audio.size > 0
          ? await fetchJSON<TranscribeResponse>("/speech/transcribe", {
              method: "POST",
              body: JSON.stringify({
                backendId: this.backendId,
                mimeType: recording.mimeType,
                model:
                  this.backendId === "ya-parakeet" ||
                  this.backendId === "ya-nemo"
                    ? this.options.parakeetModel
                    : undefined,
                audioBase64: await blobToBase64(audio),
                context: recording.context,
              }),
            })
          : { text: "" };
      if (this.disposed) return;
      // A cancelled pending transcription must be a no-op even though the
      // backend request still completed.
      if (this.cancelledBatchTokens.delete(recording.token)) return;
      if (response.text) {
        const decision = decideBatchSpeechCommand(response.text);
        const metadata: SpeechTranscriptionResultMetadata = {
          transcriptionId: response.transcriptionId,
        };
        if (decision.recognizedCommand) {
          metadata.smartTurnCommand = decision.command;
        }
        this.options.onResult?.(
          decision.transcript,
          withSpeechContextMetadata(metadata, recording.context),
        );
      } else {
        const metadata = withSpeechContextMetadata(
          response.transcriptionId
            ? { transcriptionId: response.transcriptionId }
            : undefined,
          recording.context,
        );
        if (metadata) this.options.onResult?.("", metadata);
      }
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
    }
  }

  stop(): void {
    if (this.disposed) return;
    if (
      this.state.status === "starting" ||
      (this.state.status === "receiving" && this.state.isListening) ||
      this.state.status === "reconnecting"
    ) {
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
    if (this.options.serverStreaming) {
      this.setState({ status: "finalizing", isListening: false, error: null });
      this.streamingStopRequested = true;
      this.pendingSmartTurnCommand = null;
      this.pcmChunker?.flush();
      this.cleanupStreamingMedia();
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "stop" }));
      } else {
        this.ws?.close();
        this.ws = null;
      }
      return;
    }

    this.setState({ status: "processing", isListening: false });
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
    if (this.state.status === "processing") {
      // Batch: mark the in-flight transcription so its late result is discarded;
      // the backend request may still complete but stays inert.
      if (this.processingBatchToken !== null) {
        this.cancelledBatchTokens.add(this.processingBatchToken);
        this.processingBatchToken = null;
      }
      this.setState({
        status: "idle",
        isListening: false,
        interimTranscript: "",
        error: null,
      });
      this.options.onEnd?.();
      return;
    }
    if (
      this.options.serverStreaming &&
      this.state.status !== "idle" &&
      this.state.status !== "error"
    ) {
      // Streaming: drop the uncommitted preview / in-flight tail and ignore any
      // racing final (the token bump makes later socket messages inert), while
      // the is_final blocks already committed to the draft stay. This is cancel,
      // not the finalize/flush that stop() performs.
      this.startToken += 1;
      this.pendingSmartTurnCommand = null;
      this.pendingStreamingFinalPartials = [];
      this.streamingStopRequested = false;
      this.clearStreamingPreview();
      this.cleanupStreamingMedia();
      this.ws?.close();
      this.ws = null;
      this.setState({
        status: "idle",
        isListening: false,
        interimTranscript: "",
        error: null,
      });
      this.options.onEnd?.();
    }
  }

  private releaseActiveStream(): void {
    releaseSpeechStream(this.stream);
    this.stream = null;
  }

  private cleanupStreamingMedia(): void {
    this.clearAudioFlowWatchdog();
    this.processor?.disconnect();
    this.audioSource?.disconnect();
    this.silentGain?.disconnect();
    this.processor = null;
    this.audioSource = null;
    this.silentGain = null;
    this.pcmChunker = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.releaseActiveStream();
  }

  private cleanupMedia(submitOnStop: boolean): void {
    this.cleanupStreamingMedia();
    this.ws?.close();
    this.ws = null;
    this.streamingCommittedGroups = [];
    this.pendingStreamingFinalPartials = [];
    this.pendingSmartTurnCommand = null;
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
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.startToken += 1;
    this.processingBatchToken = null;
    this.cancelledBatchTokens.clear();
    this.cleanupMedia(false);
    this.setState({ ...INITIAL_SPEECH_STATE });
    this.subscribers.clear();
  }
}
