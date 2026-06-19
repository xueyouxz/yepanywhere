import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { getLogger } from "../logging/logger.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import { DEFAULT_SERVER_SETTINGS } from "../services/ServerSettingsService.js";
import {
  persistSpeechAudio,
  type SpeechStreamingTranscriptTraceEvent,
  type SpeechAudioRequestSource,
  type SpeechAudioRetentionResult,
  type SpeechTranscriptionContext,
} from "../services/voice/audioRetention.js";
import type { SpeechBackendRegistry } from "../services/voice/registry.js";
import {
  supportsStreaming,
  supportsPrewarm,
  type SpeechStreamSession,
  type SpeechStreamDone,
  type SpeechStreamPartial,
  type TranscribeOptions,
  type SpeechWordTimestamp,
} from "../services/voice/SpeechBackend.js";

const logger = getLogger();
const DEFAULT_MIME_TYPE = "audio/webm;codecs=opus";
const MAX_SMART_TURN_TIMEOUT_MS = 10000;
const XAI_REALTIME_CLIENT_SECRET_URL =
  "https://api.x.ai/v1/realtime/client_secrets";

// biome-ignore lint/suspicious/noExplicitAny: third-party WS upgrade type
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface SpeechSessionDeps {
  speechBackendRegistry: SpeechBackendRegistry;
  dataDir?: string;
  serverSettingsService?: ServerSettingsService;
  xaiSttApiKey?: string;
  shareXaiSttApiKeyWithClients?: boolean;
}

export interface SpeechRouteDeps extends SpeechSessionDeps {
  upgradeWebSocket: UpgradeWebSocketFn;
}

interface StartMsg {
  type: "start";
  backendId?: string;
  mimeType?: string;
  context?: unknown;
  streaming?: boolean;
  sampleRate?: number;
  encoding?: string;
  smartTurn?: SpeechSmartTurnStartOptions;
}
interface StopMsg {
  type: "stop";
}
type ClientMsg = StartMsg | StopMsg;

export interface SpeechServerMsg {
  type: "ready" | "interim" | "final" | "error";
  text?: string;
  message?: string;
  transcriptionId?: string;
  isFinal?: boolean;
  speechFinal?: boolean;
  start?: number;
  duration?: number;
  words?: SpeechWordTimestamp[];
}

export type SpeechWsData =
  | string
  | ArrayBuffer
  | SharedArrayBuffer
  | Buffer
  | Blob
  | Uint8Array;

interface TranscribeBody {
  backendId?: unknown;
  model?: unknown;
  mimeType?: unknown;
  audioBase64?: unknown;
  prompt?: unknown;
  keyterms?: unknown;
  context?: unknown;
}

interface PrewarmBody {
  backendId?: unknown;
  model?: unknown;
}

interface XaiClientSecretResponse {
  value?: string;
  client_secret?: string | { value?: string };
  expires_at?: string;
}

interface SpeechSmartTurnStartOptions {
  enabled: boolean;
  threshold?: number;
  timeoutMs?: number;
}

function send(ws: WSContext, msg: SpeechServerMsg): void {
  ws.send(JSON.stringify(msg));
}

function parseXaiClientSecret(data: XaiClientSecretResponse): {
  value: string;
  expiresAt?: string;
} | null {
  const value =
    typeof data.value === "string"
      ? data.value
      : typeof data.client_secret === "string"
        ? data.client_secret
        : data.client_secret?.value;
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return data.expires_at
    ? { value: trimmed, expiresAt: data.expires_at }
    : { value: trimmed };
}

async function createXaiClientSecret(apiKey: string): Promise<{
  value: string;
  expiresAt?: string;
}> {
  const response = await fetch(XAI_REALTIME_CLIENT_SECRET_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `xAI client secret request failed (HTTP ${response.status}): ${text.slice(
        0,
        500,
      )}`,
    );
  }
  let data: XaiClientSecretResponse;
  try {
    data = JSON.parse(text) as XaiClientSecretResponse;
  } catch {
    throw new Error("xAI client secret request returned non-JSON");
  }
  const secret = parseXaiClientSecret(data);
  if (!secret) {
    throw new Error("xAI client secret response did not include a secret");
  }
  return secret;
}

type StreamingTranscriptTraceKind =
  | "update"
  | "final"
  | "speech-final"
  | "done";

function formatStreamingTranscriptTraceLine(
  kind: StreamingTranscriptTraceKind,
  text: string,
): string {
  return `${kind}\t${text.replaceAll("\r", "\\r").replaceAll("\n", "\\n")}`;
}

function toStreamingPartialTraceEvent(
  event: SpeechStreamPartial,
): SpeechStreamingTranscriptTraceEvent {
  return {
    kind: getPartialTraceKind(event),
    text: event.text,
    isFinal: event.isFinal,
    speechFinal: event.speechFinal,
    start: event.start,
    duration: event.duration,
    words: event.words,
  };
}

function toStreamingDoneTraceEvent(
  done: SpeechStreamDone,
): SpeechStreamingTranscriptTraceEvent {
  return {
    kind: "done",
    text: done.text,
    duration: done.duration,
  };
}

function getPartialTraceKind(event: {
  isFinal?: boolean;
  speechFinal?: boolean;
}): StreamingTranscriptTraceKind {
  if (event.speechFinal) return "speech-final";
  if (event.isFinal) return "final";
  return "update";
}

function joinStreamingSpeechFinals(texts: string[]): string {
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseSmartTurnStartOptions(
  value: unknown,
): SpeechSmartTurnStartOptions | undefined {
  if (!isRecord(value) || value.enabled !== true) return undefined;
  const threshold =
    typeof value.threshold === "number" && Number.isFinite(value.threshold)
      ? clampNumber(value.threshold, 0, 1)
      : undefined;
  const timeoutMs =
    typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs)
      ? Math.round(clampNumber(value.timeoutMs, 0, MAX_SMART_TURN_TIMEOUT_MS))
      : undefined;
  return { enabled: true, threshold, timeoutMs };
}

function parseClientMsg(value: unknown): ClientMsg | null {
  if (!isRecord(value)) return null;
  if (value.type === "start") {
    return {
      type: "start",
      backendId:
        typeof value.backendId === "string" ? value.backendId : undefined,
      mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
      context: value.context,
      streaming: value.streaming === true,
      sampleRate:
        typeof value.sampleRate === "number" ? value.sampleRate : undefined,
      encoding: typeof value.encoding === "string" ? value.encoding : undefined,
      smartTurn: parseSmartTurnStartOptions(value.smartTurn),
    };
  }
  if (value.type === "stop") {
    return { type: "stop" };
  }
  return null;
}

async function normalizeWsData(
  data: unknown,
): Promise<{ text: string | null; buffer: Buffer | null }> {
  if (typeof data === "string") {
    return { text: data, buffer: null };
  }
  const isSharedArrayBuffer =
    typeof SharedArrayBuffer !== "undefined" &&
    data instanceof SharedArrayBuffer;
  if (
    data instanceof ArrayBuffer ||
    isSharedArrayBuffer ||
    Buffer.isBuffer(data)
  ) {
    const buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data as ArrayBuffer);
    return { text: buffer.toString("utf8"), buffer };
  }
  if (data instanceof Blob) {
    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return { text: buffer.toString("utf8"), buffer };
  }
  return { text: null, buffer: null };
}

function parseWsControlMessage(text: string | null): ClientMsg | null {
  const trimmed = text?.trim();
  if (!trimmed?.startsWith("{")) return null;
  try {
    return parseClientMsg(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

async function transcribe(
  registry: SpeechBackendRegistry,
  backendId: string,
  audio: Buffer,
  options: TranscribeOptions,
): Promise<string> {
  const backend = registry.getBackend(backendId);
  if (!backend) {
    throw new Error(`Backend not available: ${backendId}`);
  }
  if (audio.length === 0) {
    return "";
  }
  return backend.transcribe(audio, options);
}

function cleanContextString(
  value: unknown,
  maxLength = 300,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function cleanOptionalString(
  value: unknown,
  maxLength = 300,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function parseTranscriptionContext(
  value: unknown,
): SpeechTranscriptionContext | undefined {
  if (!isRecord(value)) return undefined;
  const context = {
    projectId: cleanContextString(value.projectId),
    sessionId: cleanContextString(value.sessionId),
    clientTurnId: cleanContextString(value.clientTurnId, 120),
    draftKey: cleanContextString(value.draftKey, 300),
    speechTargetId: cleanContextString(value.speechTargetId, 120),
  };
  const clean = Object.fromEntries(
    Object.entries(context).filter(([, entry]) => entry !== undefined),
  ) as SpeechTranscriptionContext;
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function getRetentionSettings(deps: SpeechSessionDeps) {
  return (
    deps.serverSettingsService?.getSetting("speechAudioRetention") ??
    DEFAULT_SERVER_SETTINGS.speechAudioRetention
  );
}

/**
 * Remember the model a local STT backend just used successfully, so the next
 * startup preflights it (skipping a cold model-swap when the user switches to
 * that backend). Persists only on change; a no-op without a settings service or
 * an explicit model. See topics/pluggable-speech-recognition.md.
 */
async function recordLastLocalSpeechModel(
  deps: SpeechSessionDeps,
  backendId: string,
  model: string | undefined,
): Promise<void> {
  const settings = deps.serverSettingsService;
  if (!settings || !model) return;
  const current = settings.getSetting("lastLocalSpeechModels") ?? {};
  if (current[backendId] === model) return;
  await settings.updateSettings({
    lastLocalSpeechModels: { ...current, [backendId]: model },
  });
}

async function transcribeWithAudit(
  deps: SpeechSessionDeps,
  input: {
    source: SpeechAudioRequestSource;
    backendId: string;
    audio: Buffer;
    options: TranscribeOptions;
    context?: SpeechTranscriptionContext;
  },
): Promise<{ text: string; retention: SpeechAudioRetentionResult }> {
  const requestId = randomUUID();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const logContext = {
    component: "speech",
    requestId,
    source: input.source,
    backendId: input.backendId,
    mimeType: input.options.mimeType ?? DEFAULT_MIME_TYPE,
    model: input.options.model,
    audioBytes: input.audio.length,
    hasPrompt: !!input.options.prompt,
    keytermCount: input.options.keyterms?.length ?? 0,
    context: input.context,
  };

  logger.info(logContext, "Speech transcription started");

  try {
    const text = await transcribe(
      deps.speechBackendRegistry,
      input.backendId,
      input.audio,
      input.options,
    );
    void recordLastLocalSpeechModel(deps, input.backendId, input.options.model);
    const completedAtMs = Date.now();
    const completedAt = new Date(completedAtMs).toISOString();
    const retention = await persistSpeechAudio({
      dataDir: deps.dataDir,
      settings: getRetentionSettings(deps),
      requestId,
      source: input.source,
      backendId: input.backendId,
      model: input.options.model,
      mimeType: input.options.mimeType ?? DEFAULT_MIME_TYPE,
      audio: input.audio,
      transcript: text,
      startedAt,
      completedAt,
      durationMs: completedAtMs - startedAtMs,
      context: input.context,
    });

    logger.info(
      {
        ...logContext,
        durationMs: completedAtMs - startedAtMs,
        transcriptChars: text.length,
        transcriptionId: retention.transcriptionId,
        retention: {
          stored: retention.stored,
          reason: retention.reason,
          audioPath: retention.audioPath,
          metadataPath: retention.metadataPath,
          prunedFiles: retention.prunedFiles,
          prunedBytes: retention.prunedBytes,
          pruneError: retention.pruneError,
        },
      },
      "Speech transcription completed",
    );

    return { text, retention };
  } catch (err: unknown) {
    const durationMs = Date.now() - startedAtMs;
    logger.error(
      {
        ...logContext,
        durationMs,
        err,
      },
      "Speech transcription failed",
    );
    throw err;
  }
}

async function persistStreamingTranscription(
  deps: SpeechSessionDeps,
  input: {
    requestId: string;
    backendId: string;
    audio: Buffer;
    mimeType: string;
    transcript: string;
    streamingTranscriptTrace?: string[];
    streamingTranscriptEvents?: SpeechStreamingTranscriptTraceEvent[];
    startedAt: string;
    startedAtMs: number;
    context?: SpeechTranscriptionContext;
  },
): Promise<SpeechAudioRetentionResult> {
  const completedAtMs = Date.now();
  const completedAt = new Date(completedAtMs).toISOString();
  const retention = await persistSpeechAudio({
    dataDir: deps.dataDir,
    settings: getRetentionSettings(deps),
    requestId: input.requestId,
    source: "ws",
    backendId: input.backendId,
    mimeType: input.mimeType,
    audio: input.audio,
    transcript: input.transcript,
    streamingTranscriptTrace: input.streamingTranscriptTrace,
    streamingTranscriptEvents: input.streamingTranscriptEvents,
    startedAt: input.startedAt,
    completedAt,
    durationMs: completedAtMs - input.startedAtMs,
    context: input.context,
  });

  logger.info(
    {
      component: "speech",
      requestId: input.requestId,
      source: "ws",
      mode: "stream",
      backendId: input.backendId,
      mimeType: input.mimeType,
      audioBytes: input.audio.length,
      context: input.context,
      durationMs: completedAtMs - input.startedAtMs,
      transcriptChars: input.transcript.length,
      streamingTranscriptTraceEvents:
        input.streamingTranscriptTrace?.length ?? 0,
      streamingTranscriptRawEvents:
        input.streamingTranscriptEvents?.length ?? 0,
      transcriptionId: retention.transcriptionId,
      retention: {
        stored: retention.stored,
        reason: retention.reason,
        audioPath: retention.audioPath,
        metadataPath: retention.metadataPath,
        prunedFiles: retention.prunedFiles,
        prunedBytes: retention.prunedBytes,
        pruneError: retention.pruneError,
      },
    },
    "Speech streaming transcription completed",
  );

  return retention;
}

function parseTranscribeBody(value: unknown):
  | {
      ok: true;
      backendId: string;
      audio: Buffer;
      options: TranscribeOptions;
      context?: SpeechTranscriptionContext;
    }
  | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "Expected JSON object" };
  }
  const body = value as TranscribeBody;
  if (typeof body.backendId !== "string" || body.backendId.length === 0) {
    return { ok: false, message: "backendId is required" };
  }
  if (typeof body.audioBase64 !== "string") {
    return { ok: false, message: "audioBase64 is required" };
  }
  const audio = Buffer.from(body.audioBase64, "base64");
  const keyterms = Array.isArray(body.keyterms)
    ? body.keyterms.filter((term): term is string => typeof term === "string")
    : undefined;
  return {
    ok: true,
    backendId: body.backendId,
    audio,
    context: parseTranscriptionContext(body.context),
    options: {
      mimeType:
        typeof body.mimeType === "string" ? body.mimeType : DEFAULT_MIME_TYPE,
      model: cleanOptionalString(body.model, 200),
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      keyterms,
    },
  };
}

function parsePrewarmBody(
  value: unknown,
):
  | { ok: true; backendId: string; options: TranscribeOptions }
  | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "Expected JSON object" };
  }
  const body = value as PrewarmBody;
  if (typeof body.backendId !== "string" || body.backendId.length === 0) {
    return { ok: false, message: "backendId is required" };
  }
  return {
    ok: true,
    backendId: body.backendId,
    options: {
      model: cleanOptionalString(body.model, 200),
    },
  };
}

export interface SpeechWebSocketSession {
  handleMessage(data: SpeechWsData): void;
  close(): void;
}

export function createSpeechWebSocketSession(
  deps: SpeechSessionDeps,
  sendMessage: (msg: SpeechServerMsg) => void,
): SpeechWebSocketSession {
  const chunks: Buffer[] = [];
  let mimeType = DEFAULT_MIME_TYPE;
  let backendId: string | null = null;
  let context: SpeechTranscriptionContext | undefined;
  let streamSession: SpeechStreamSession | null = null;
  let streamSessionPromise: Promise<SpeechStreamSession> | null = null;
  let pendingAudio: Buffer[] = [];
  let streamRequestId: string | null = null;
  let streamStartedAt = "";
  let streamStartedAtMs = 0;
  let streamingTranscriptTrace: string[] = [];
  let streamingTranscriptEvents: SpeechStreamingTranscriptTraceEvent[] = [];
  let streamingSpeechFinalTexts: string[] = [];
  let streamingStopRequested = false;
  let messageChain = Promise.resolve();

  const processMessage = async (data: SpeechWsData): Promise<void> => {
    const normalized = await normalizeWsData(data);
    const msg = parseWsControlMessage(normalized.text);

    if (!msg) {
      if (normalized.buffer) {
        chunks.push(normalized.buffer);
        if (streamSession) {
          streamSession.sendAudio(normalized.buffer);
        } else if (streamSessionPromise) {
          pendingAudio.push(normalized.buffer);
        }
      } else {
        logger.warn("Unparseable speech WS frame");
      }
      return;
    }

    if (msg.type === "start") {
      chunks.length = 0;
      backendId = msg.backendId ?? null;
      mimeType = msg.mimeType ?? DEFAULT_MIME_TYPE;
      context = parseTranscriptionContext(msg.context);
      streamSession?.close();
      streamSession = null;
      streamSessionPromise = null;
      pendingAudio = [];
      streamRequestId = null;
      streamingTranscriptTrace = [];
      streamingTranscriptEvents = [];
      streamingSpeechFinalTexts = [];
      streamingStopRequested = false;

      if (msg.streaming && backendId) {
        const backend = deps.speechBackendRegistry.getBackend(backendId);
        if (!backend) {
          sendMessage({ type: "error", message: "No backend selected" });
          return;
        }
        if (!supportsStreaming(backend)) {
          sendMessage({
            type: "error",
            message: `Backend does not support streaming: ${backendId}`,
          });
          return;
        }
        const sampleRate = msg.sampleRate ?? 16_000;
        const encoding = msg.encoding === "pcm" ? "pcm" : null;
        if (!encoding) {
          sendMessage({
            type: "error",
            message: "Streaming speech requires pcm encoding",
          });
          return;
        }
        const smartTurn =
          backend.capabilities.smartTurn === true ? msg.smartTurn : undefined;

        streamRequestId = randomUUID();
        streamStartedAtMs = Date.now();
        streamStartedAt = new Date(streamStartedAtMs).toISOString();
        logger.info(
          {
            component: "speech",
            requestId: streamRequestId,
            source: "ws",
            mode: "stream",
            backendId,
            mimeType,
            sampleRate,
            encoding,
            smartTurn:
              smartTurn?.enabled === true
                ? {
                    threshold: smartTurn.threshold ?? null,
                    timeoutMs: smartTurn.timeoutMs ?? null,
                  }
                : null,
            context,
          },
          "Speech streaming transcription started",
        );

        const requestId = streamRequestId;
        const isCurrent = (): boolean => streamRequestId === requestId;
        streamSessionPromise = backend
          .stream(
            {
              mimeType,
              sampleRate,
              encoding,
              interimResults: true,
              endpointingMs: 250,
              language: "en",
              smartTurnThreshold: smartTurn?.threshold,
              smartTurnTimeoutMs: smartTurn?.timeoutMs,
            },
            {
              onPartial: (event) => {
                if (!isCurrent()) return;
                streamingTranscriptTrace.push(
                  formatStreamingTranscriptTraceLine(
                    getPartialTraceKind(event),
                    event.text,
                  ),
                );
                streamingTranscriptEvents.push(
                  toStreamingPartialTraceEvent(event),
                );
                if (event.speechFinal) {
                  streamingSpeechFinalTexts.push(event.text);
                }
                sendMessage({
                  type: "interim",
                  text: event.text,
                  isFinal: event.isFinal,
                  speechFinal: event.speechFinal,
                  start: event.start,
                  duration: event.duration,
                  words: event.words,
                });
              },
              onError: (err) => {
                if (!isCurrent() || streamingStopRequested) return;
                const message =
                  err instanceof Error ? err.message : String(err);
                logger.warn(
                  {
                    component: "speech",
                    requestId,
                    source: "ws",
                    mode: "stream",
                    backendId,
                  },
                  `Speech streaming failed mid-session: ${message}`,
                );
                sendMessage({ type: "error", message });
              },
            },
          )
          .then((session) => {
            if (!isCurrent()) {
              session.close();
              return session;
            }
            streamSession = session;
            for (const buffered of pendingAudio) {
              session.sendAudio(buffered);
            }
            pendingAudio = [];
            return session;
          });
        streamSessionPromise.catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            {
              component: "speech",
              requestId,
              source: "ws",
              mode: "stream",
              backendId,
              err,
            },
            "Speech streaming session failed to open",
          );
          if (!isCurrent()) return;
          streamSessionPromise = null;
          pendingAudio = [];
          if (!streamingStopRequested) {
            sendMessage({ type: "error", message });
          }
        });
      }
      return;
    }

    const audio = Buffer.concat(chunks);
    chunks.length = 0;

    if (!backendId) {
      sendMessage({ type: "error", message: "No backend selected" });
      return;
    }

    if (streamSessionPromise && streamRequestId) {
      try {
        streamingStopRequested = true;
        const session = await streamSessionPromise;
        const done = await session.finish();
        streamingTranscriptTrace.push(
          formatStreamingTranscriptTraceLine("done", done.text),
        );
        streamingTranscriptEvents.push(toStreamingDoneTraceEvent(done));
        const transcript =
          done.text.trim() ||
          joinStreamingSpeechFinals(streamingSpeechFinalTexts);
        const retention = await persistStreamingTranscription(deps, {
          requestId: streamRequestId,
          backendId,
          audio,
          mimeType,
          transcript,
          streamingTranscriptTrace,
          streamingTranscriptEvents,
          startedAt: streamStartedAt,
          startedAtMs: streamStartedAtMs,
          context,
        });
        sendMessage({
          type: "final",
          text: transcript,
          transcriptionId: retention.transcriptionId,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          {
            component: "speech",
            requestId: streamRequestId,
            source: "ws",
            mode: "stream",
            backendId,
            audioBytes: audio.length,
            context,
            err,
          },
          "Speech streaming transcription failed",
        );
        sendMessage({ type: "error", message });
      } finally {
        streamSession = null;
        streamSessionPromise = null;
        pendingAudio = [];
        streamRequestId = null;
        streamingTranscriptTrace = [];
        streamingTranscriptEvents = [];
        streamingSpeechFinalTexts = [];
        streamingStopRequested = false;
      }
      return;
    }

    try {
      const { text, retention } = await transcribeWithAudit(deps, {
        source: "ws",
        backendId,
        audio,
        options: { mimeType },
        context,
      });
      sendMessage({
        type: "final",
        text,
        transcriptionId: retention.transcriptionId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendMessage({ type: "error", message });
    }
  };

  return {
    handleMessage(data: SpeechWsData) {
      messageChain = messageChain
        .then(() => processMessage(data))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            { component: "speech", err },
            "Speech WS message handling failed",
          );
          sendMessage({ type: "error", message });
        });
    },
    close() {
      streamSession?.close();
      streamSessionPromise?.then((session) => session.close()).catch(() => {});
      streamSession = null;
      streamSessionPromise = null;
      pendingAudio = [];
      streamingTranscriptTrace = [];
      streamingTranscriptEvents = [];
      streamingSpeechFinalTexts = [];
      streamingStopRequested = false;
      chunks.length = 0;
    },
  };
}

export function createSpeechRoutes(deps: SpeechRouteDeps): Hono {
  const routes = new Hono();

  const rejectCredentialGet = (c: Context) => {
    c.header("Allow", "POST");
    return c.json(
      { error: "Use POST for speech credential broker routes" },
      405,
    );
  };

  routes.get("/xai-client-key", rejectCredentialGet);

  routes.post("/xai-client-key", (c) => {
    if (deps.shareXaiSttApiKeyWithClients !== true) {
      return c.json({ error: "Server xAI STT key borrowing is disabled" }, 403);
    }
    if (!deps.xaiSttApiKey) {
      return c.json({ error: "Server xAI STT key is not configured" }, 404);
    }
    return c.json({ apiKey: deps.xaiSttApiKey });
  });

  routes.get("/xai-client-secret", rejectCredentialGet);

  routes.post("/xai-client-secret", async (c) => {
    if (!deps.xaiSttApiKey) {
      return c.json({ error: "Server xAI STT key is not configured" }, 404);
    }
    try {
      const secret = await createXaiClientSecret(deps.xaiSttApiKey);
      return c.json({
        clientSecret: secret.value,
        ...(secret.expiresAt ? { expiresAt: secret.expiresAt } : {}),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  routes.post("/transcribe", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = parseTranscribeBody(rawBody);
    if (!parsed.ok) {
      return c.json({ error: parsed.message }, 400);
    }

    try {
      const { text, retention } = await transcribeWithAudit(deps, {
        source: "http",
        backendId: parsed.backendId,
        audio: parsed.audio,
        options: parsed.options,
        context: parsed.context,
      });
      return c.json({ text, transcriptionId: retention.transcriptionId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  routes.post("/prewarm", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = parsePrewarmBody(rawBody);
    if (!parsed.ok) {
      return c.json({ error: parsed.message }, 400);
    }

    const backend = deps.speechBackendRegistry.getBackend(parsed.backendId);
    if (!backend) {
      return c.json(
        { error: `Backend not available: ${parsed.backendId}` },
        404,
      );
    }
    if (!supportsPrewarm(backend)) {
      return c.json(
        { error: `Backend does not support prewarm: ${parsed.backendId}` },
        400,
      );
    }

    logger.info(
      {
        component: "speech",
        backendId: parsed.backendId,
        model: parsed.options.model,
      },
      "Speech backend prewarm requested",
    );

    void backend
      .prewarm(parsed.options)
      .then(() => {
        logger.info(
          {
            component: "speech",
            backendId: parsed.backendId,
            model: parsed.options.model,
          },
          "Speech backend prewarm completed",
        );
        void recordLastLocalSpeechModel(
          deps,
          parsed.backendId,
          parsed.options.model,
        );
      })
      .catch((err: unknown) => {
        logger.warn(
          {
            component: "speech",
            backendId: parsed.backendId,
            model: parsed.options.model,
            err,
          },
          "Speech backend prewarm failed",
        );
      });

    return c.json({ ok: true });
  });

  routes.get(
    "/ws",
    deps.upgradeWebSocket((_c: Context) => {
      const chunks: Buffer[] = [];
      let mimeType = DEFAULT_MIME_TYPE;
      let backendId: string | null = null;
      let context: SpeechTranscriptionContext | undefined;
      let streamSession: SpeechStreamSession | null = null;
      // The upstream handshake (e.g. xAI returning transcript.created) can take
      // a noticeable moment. We establish it concurrently rather than awaiting
      // inside the serialized message chain, so incoming audio is never blocked
      // behind it. Frames that arrive before the session is ready buffer here
      // and flush in order the instant it resolves — otherwise a slow handshake
      // produced a dead window where early speech was lost and no live partials
      // were emitted.
      let streamSessionPromise: Promise<SpeechStreamSession> | null = null;
      let pendingAudio: Buffer[] = [];
      let streamRequestId: string | null = null;
      let streamStartedAt = "";
      let streamStartedAtMs = 0;
      let streamingTranscriptTrace: string[] = [];
      let streamingTranscriptEvents: SpeechStreamingTranscriptTraceEvent[] = [];
      let streamingSpeechFinalTexts: string[] = [];
      let streamingStopRequested = false;
      let messageChain = Promise.resolve();

      const processMessage = async (
        data: SpeechWsData,
        ws: WSContext,
      ): Promise<void> => {
        const normalized = await normalizeWsData(data);
        const msg = parseWsControlMessage(normalized.text);

        if (!msg) {
          if (normalized.buffer) {
            chunks.push(normalized.buffer);
            if (streamSession) {
              streamSession.sendAudio(normalized.buffer);
            } else if (streamSessionPromise) {
              // Session still handshaking: buffer in order, flushed on resolve.
              pendingAudio.push(normalized.buffer);
            }
          } else {
            logger.warn("Unparseable speech WS frame");
          }
          return;
        }

        if (msg.type === "start") {
          chunks.length = 0;
          backendId = msg.backendId ?? null;
          mimeType = msg.mimeType ?? DEFAULT_MIME_TYPE;
          context = parseTranscriptionContext(msg.context);
          streamSession?.close();
          streamSession = null;
          streamSessionPromise = null;
          pendingAudio = [];
          streamRequestId = null;
          streamingTranscriptTrace = [];
          streamingTranscriptEvents = [];
          streamingSpeechFinalTexts = [];
          streamingStopRequested = false;

          if (msg.streaming && backendId) {
            const backend = deps.speechBackendRegistry.getBackend(backendId);
            if (!backend) {
              send(ws, { type: "error", message: "No backend selected" });
              return;
            }
            if (!supportsStreaming(backend)) {
              send(ws, {
                type: "error",
                message: `Backend does not support streaming: ${backendId}`,
              });
              return;
            }
            const sampleRate = msg.sampleRate ?? 16_000;
            const encoding = msg.encoding === "pcm" ? "pcm" : null;
            if (!encoding) {
              send(ws, {
                type: "error",
                message: "Streaming speech requires pcm encoding",
              });
              return;
            }
            const smartTurn =
              backend.capabilities.smartTurn === true
                ? msg.smartTurn
                : undefined;

            streamRequestId = randomUUID();
            streamStartedAtMs = Date.now();
            streamStartedAt = new Date(streamStartedAtMs).toISOString();
            logger.info(
              {
                component: "speech",
                requestId: streamRequestId,
                source: "ws",
                mode: "stream",
                backendId,
                mimeType,
                sampleRate,
                encoding,
                smartTurn:
                  smartTurn?.enabled === true
                    ? {
                        threshold: smartTurn.threshold ?? null,
                        timeoutMs: smartTurn.timeoutMs ?? null,
                      }
                    : null,
                context,
              },
              "Speech streaming transcription started",
            );

            // Establish the backend session without blocking the WS message
            // chain: the xAI handshake can take seconds, and awaiting it here
            // would stall every audio frame behind it (head-of-line blocking),
            // dropping the first seconds of speech. Instead, buffer incoming
            // frames in `pendingAudio` and flush them in order once the session
            // resolves.
            // Tie every continuation to this request id. A new `start` can
            // arrive before the handshake resolves; without this guard a late
            // resolution would assign `streamSession`, flush the *new*
            // request's buffered frames into the *old* session, and leak the
            // superseded upstream socket.
            const requestId = streamRequestId;
            const isCurrent = (): boolean => streamRequestId === requestId;
            streamSessionPromise = backend
              .stream(
                {
                  mimeType,
                  sampleRate,
                  encoding,
                  interimResults: true,
                  endpointingMs: 250,
                  language: "en",
                  smartTurnThreshold: smartTurn?.threshold,
                  smartTurnTimeoutMs: smartTurn?.timeoutMs,
                },
                {
                  onPartial: (event) => {
                    if (!isCurrent()) return;
                    streamingTranscriptTrace.push(
                      formatStreamingTranscriptTraceLine(
                        getPartialTraceKind(event),
                        event.text,
                      ),
                    );
                    streamingTranscriptEvents.push(
                      toStreamingPartialTraceEvent(event),
                    );
                    if (event.speechFinal) {
                      streamingSpeechFinalTexts.push(event.text);
                    }
                    send(ws, {
                      type: "interim",
                      text: event.text,
                      isFinal: event.isFinal,
                      speechFinal: event.speechFinal,
                      start: event.start,
                      duration: event.duration,
                      words: event.words,
                    });
                  },
                  onError: (err) => {
                    if (!isCurrent() || streamingStopRequested) return;
                    const message =
                      err instanceof Error ? err.message : String(err);
                    logger.warn(
                      {
                        component: "speech",
                        requestId,
                        source: "ws",
                        mode: "stream",
                        backendId,
                      },
                      `Speech streaming failed mid-session: ${message}`,
                    );
                    send(ws, { type: "error", message });
                  },
                },
              )
              .then((session) => {
                if (!isCurrent()) {
                  // Superseded by a newer start (or a stop/close): do not touch
                  // current buffers; just close this orphaned session.
                  session.close();
                  return session;
                }
                streamSession = session;
                for (const buffered of pendingAudio) {
                  session.sendAudio(buffered);
                }
                pendingAudio = [];
                return session;
              });
            streamSessionPromise.catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              logger.error(
                {
                  component: "speech",
                  requestId,
                  source: "ws",
                  mode: "stream",
                  backendId,
                  err,
                },
                "Speech streaming session failed to open",
              );
              if (!isCurrent()) return;
              streamSessionPromise = null;
              pendingAudio = [];
              if (!streamingStopRequested) {
                send(ws, { type: "error", message });
              }
            });
          }
          return;
        }

        const audio = Buffer.concat(chunks);
        chunks.length = 0;

        if (!backendId) {
          send(ws, { type: "error", message: "No backend selected" });
          return;
        }

        if (streamSessionPromise && streamRequestId) {
          try {
            streamingStopRequested = true;
            // The session may still be handshaking; wait for it (and the
            // in-order flush of any buffered frames) before finishing.
            const session = await streamSessionPromise;
            const done = await session.finish();
            streamingTranscriptTrace.push(
              formatStreamingTranscriptTraceLine("done", done.text),
            );
            streamingTranscriptEvents.push(toStreamingDoneTraceEvent(done));
            const transcript =
              done.text.trim() ||
              joinStreamingSpeechFinals(streamingSpeechFinalTexts);
            const retention = await persistStreamingTranscription(deps, {
              requestId: streamRequestId,
              backendId,
              audio,
              mimeType,
              transcript,
              streamingTranscriptTrace,
              streamingTranscriptEvents,
              startedAt: streamStartedAt,
              startedAtMs: streamStartedAtMs,
              context,
            });
            send(ws, {
              type: "final",
              text: transcript,
              transcriptionId: retention.transcriptionId,
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(
              {
                component: "speech",
                requestId: streamRequestId,
                source: "ws",
                mode: "stream",
                backendId,
                audioBytes: audio.length,
                context,
                err,
              },
              "Speech streaming transcription failed",
            );
            send(ws, { type: "error", message });
          } finally {
            streamSession = null;
            streamSessionPromise = null;
            pendingAudio = [];
            streamRequestId = null;
            streamingTranscriptTrace = [];
            streamingTranscriptEvents = [];
            streamingSpeechFinalTexts = [];
            streamingStopRequested = false;
          }
          return;
        }

        try {
          const { text, retention } = await transcribeWithAudit(deps, {
            source: "ws",
            backendId,
            audio,
            options: { mimeType },
            context,
          });
          send(ws, {
            type: "final",
            text,
            transcriptionId: retention.transcriptionId,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          send(ws, { type: "error", message });
        }
      };

      return {
        onOpen(_evt: Event, ws: WSContext) {
          send(ws, { type: "ready" });
        },

        onMessage(evt: MessageEvent, ws: WSContext) {
          messageChain = messageChain
            .then(() => processMessage(evt.data as SpeechWsData, ws))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              logger.error(
                { component: "speech", err },
                "Speech WS message handling failed",
              );
              send(ws, { type: "error", message });
            });
        },

        onClose() {
          streamSession?.close();
          // A still-handshaking session must be closed once it resolves, or it
          // leaks an open xAI socket after the client disconnects.
          streamSessionPromise
            ?.then((session) => session.close())
            .catch(() => {});
          streamSession = null;
          streamSessionPromise = null;
          pendingAudio = [];
          streamingTranscriptTrace = [];
          streamingTranscriptEvents = [];
          streamingSpeechFinalTexts = [];
          streamingStopRequested = false;
          chunks.length = 0;
        },
      } satisfies WSEvents;
    }),
  );

  return routes;
}
