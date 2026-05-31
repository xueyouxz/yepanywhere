import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/index.js";
import { createSpeechRoutes } from "../../src/routes/speech.js";
import { DUMMY_TRANSCRIPT } from "../../src/services/voice/dummyBackend.js";
import { initSpeechBackendRegistry } from "../../src/services/voice/registry.js";
import { SpeechBackendRegistry } from "../../src/services/voice/registry.js";
import type {
  SpeechStreamHandlers,
  SpeechStreamOptions,
  SpeechStreamSession,
  StreamingSpeechBackend,
  TranscribeOptions,
} from "../../src/services/voice/SpeechBackend.js";

async function createSpeechApp(
  dataDir?: string,
  speechBackendRegistry?: SpeechBackendRegistry,
) {
  const app = new Hono();
  const { upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const registry =
    speechBackendRegistry ??
    (await initSpeechBackendRegistry({
      voiceInputEnabled: true,
      voiceBackends: ["ya-dummy"],
    }));
  app.route(
    "/api/speech",
    createSpeechRoutes({
      speechBackendRegistry: registry,
      upgradeWebSocket,
      dataDir,
    }),
  );
  return { app, wss };
}

class StreamingTestBackend implements StreamingSpeechBackend {
  readonly id = "ya-streaming-test";
  readonly label = "Streaming test";
  readonly capabilities = { streaming: true } as const;
  readonly chunks: Buffer[] = [];
  options: SpeechStreamOptions | null = null;

  async validate(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async transcribe(
    _audio: Buffer,
    _options?: TranscribeOptions,
  ): Promise<string> {
    throw new Error("batch transcription should not be used");
  }

  async stream(
    options: SpeechStreamOptions,
    handlers: SpeechStreamHandlers = {},
  ): Promise<SpeechStreamSession> {
    this.options = options;
    return {
      sendAudio: (audio) => {
        this.chunks.push(audio);
      },
      finish: async () => {
        handlers.onPartial?.({ text: "hel", isFinal: false });
        handlers.onPartial?.({ text: "hello", isFinal: true });
        handlers.onPartial?.({
          text: "hello world",
          isFinal: true,
          speechFinal: true,
        });
        return { text: "hello world" };
      },
      close: () => {},
    };
  }
}

describe("speech routes", () => {
  let server: ReturnType<typeof serve> | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    server?.close();
    server = null;
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("transcribes batch audio through the HTTP endpoint", async () => {
    const { app } = await createSpeechApp();

    const res = await app.request("/api/speech/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backendId: "ya-dummy",
        mimeType: "audio/webm",
        audioBase64: Buffer.from("audio").toString("base64"),
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: DUMMY_TRANSCRIPT,
      transcriptionId: expect.any(String),
    });
  });

  it("retains batch audio with transcript and session context metadata", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ya-speech-"));
    tempDirs.push(dataDir);
    const { app } = await createSpeechApp(dataDir);

    const res = await app.request("/api/speech/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backendId: "ya-dummy",
        mimeType: "audio/webm;codecs=opus",
        audioBase64: Buffer.from("audio").toString("base64"),
        context: {
          projectId: "project-1",
          sessionId: "session-1",
          clientTurnId: "turn-1",
        },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    const dayDirs = await fs.readdir(path.join(dataDir, "speech-audio"));
    expect(dayDirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dayDirs).toHaveLength(1);
    const retainedDir = path.join(dataDir, "speech-audio", dayDirs[0] ?? "");
    const files = await fs.readdir(retainedDir);
    expect(files).toContain(`${json.transcriptionId}.webm`);
    expect(files).toContain(`${json.transcriptionId}.json`);

    const metadata = JSON.parse(
      await fs.readFile(
        path.join(retainedDir, `${json.transcriptionId}.json`),
        "utf8",
      ),
    ) as {
      transcript?: string;
      context?: {
        projectId?: string;
        sessionId?: string;
        clientTurnId?: string;
      };
    };
    expect(metadata.transcript).toBe(DUMMY_TRANSCRIPT);
    expect(metadata.context).toEqual({
      projectId: "project-1",
      sessionId: "session-1",
      clientTurnId: "turn-1",
    });
  });

  it("transcribes buffered WebSocket audio through the dummy backend", async () => {
    const { app, wss } = await createSpeechApp();
    let serverPort = 0;
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      serverPort = info.port;
    });
    attachUnifiedUpgradeHandler(server, {
      frontendProxy: undefined,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
      app,
      wss,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ws = await connectWebSocket(
      `ws://127.0.0.1:${serverPort}/api/speech/ws`,
    );
    try {
      expect(await ws.nextJson()).toEqual({ type: "ready" });

      ws.send(
        JSON.stringify({
          type: "start",
          backendId: "ya-dummy",
          mimeType: "audio/webm",
        }),
      );
      ws.send(Buffer.from("fake audio bytes"));
      ws.send(JSON.stringify({ type: "stop" }));

      expect(await ws.nextJson()).toEqual({
        type: "final",
        text: DUMMY_TRANSCRIPT,
        transcriptionId: expect.any(String),
      });
    } finally {
      ws.close();
    }
  });

  it("streams WebSocket audio when the backend advertises streaming", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ya-speech-"));
    tempDirs.push(dataDir);
    const registry = new SpeechBackendRegistry();
    const backend = new StreamingTestBackend();
    await registry.register(backend);
    const { app, wss } = await createSpeechApp(dataDir, registry);
    let serverPort = 0;
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      serverPort = info.port;
    });
    attachUnifiedUpgradeHandler(server, {
      frontendProxy: undefined,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
      app,
      wss,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ws = await connectWebSocket(
      `ws://127.0.0.1:${serverPort}/api/speech/ws`,
    );
    try {
      expect(await ws.nextJson()).toEqual({ type: "ready" });

      ws.send(
        JSON.stringify({
          type: "start",
          backendId: backend.id,
          mimeType: "audio/pcm;rate=24000;encoding=s16le",
          streaming: true,
          sampleRate: 24000,
          encoding: "pcm",
        }),
      );
      ws.send(Buffer.from("pcm"));
      ws.send(JSON.stringify({ type: "stop" }));

      expect(await ws.nextJson()).toEqual({
        type: "interim",
        text: "hel",
        isFinal: false,
      });
      expect(await ws.nextJson()).toEqual({
        type: "interim",
        text: "hello",
        isFinal: true,
      });
      expect(await ws.nextJson()).toEqual({
        type: "interim",
        text: "hello world",
        isFinal: true,
        speechFinal: true,
      });
      const final = (await ws.nextJson()) as { transcriptionId: string };
      expect(final).toEqual({
        type: "final",
        text: "hello world",
        transcriptionId: expect.any(String),
      });
      expect(backend.options?.sampleRate).toBe(24000);
      const metadataPath = await findRetainedMetadata(
        dataDir,
        final.transcriptionId,
      );
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
        streamingTranscriptTrace?: string[];
        streamingTranscriptTraceText?: string;
      };
      expect(metadata.streamingTranscriptTrace).toEqual([
        "update\thel",
        "final\thello",
        "speech-final\thello world",
        "done\thello world",
      ]);
      expect(metadata.streamingTranscriptTraceText).toBe(
        "update\thel\nfinal\thello\nspeech-final\thello world\ndone\thello world",
      );
    } finally {
      ws.close();
    }
  });
});

interface TestWebSocket {
  send(data: string | Buffer): void;
  close(): void;
  nextJson(): Promise<unknown>;
}

async function findRetainedMetadata(
  dataDir: string,
  transcriptionId: string,
): Promise<string> {
  const dayDirs = await fs.readdir(path.join(dataDir, "speech-audio"));
  for (const dayDir of dayDirs) {
    const metadataPath = path.join(
      dataDir,
      "speech-audio",
      dayDir,
      `${transcriptionId}.json`,
    );
    try {
      await fs.access(metadataPath);
      return metadataPath;
    } catch {
      // Continue scanning date shards.
    }
  }
  throw new Error(`Retained metadata not found: ${transcriptionId}`);
}

function connectWebSocket(url: string): Promise<TestWebSocket> {
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  const ws = new WebSocket(url);

  ws.on("message", (data) => {
    const parsed = JSON.parse(data.toString()) as unknown;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(parsed);
      return;
    }
    messages.push(parsed);
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket connection timeout")),
      5000,
    );
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve({
        send(data: string | Buffer) {
          ws.send(data);
        },
        close() {
          ws.close();
        },
        nextJson() {
          return new Promise<unknown>((resolveNext, rejectNext) => {
            const message = messages.shift();
            if (message !== undefined) {
              resolveNext(message);
              return;
            }
            const messageTimeout = setTimeout(
              () => rejectNext(new Error("Timed out waiting for message")),
              5000,
            );
            waiters.push((value) => {
              clearTimeout(messageTimeout);
              resolveNext(value);
            });
          });
        },
      });
    });
    ws.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
