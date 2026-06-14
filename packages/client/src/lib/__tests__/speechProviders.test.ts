import { afterEach, describe, expect, it, vi } from "vitest";
import { YaServerProvider } from "../speechProviders/YaServerProvider";
import {
  DEFAULT_SPEECH_METHOD,
  getOrderedServerSpeechBackends,
  getPreferredSpeechMethod,
  getSpeechMethods,
  resolveSpeechMethod,
} from "../speechProviders/methods";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("speech provider method selection", () => {
  it("uses advertised server backends directly and orders preferred cloud STT first", () => {
    expect(
      getOrderedServerSpeechBackends([
        "ya-deepgram",
        "ya-whisper",
        "ya-grok",
        "ya-grok",
      ]),
    ).toEqual(["ya-grok", "ya-deepgram", "ya-whisper"]);
  });

  it("does not require client-side backend hardcodes to build selector options", () => {
    expect(
      getSpeechMethods(["ya-custom-stt"]).map((method) => method.id),
    ).toEqual(["ya-custom-stt", DEFAULT_SPEECH_METHOD]);
  });

  it("uses explicit labels for known STT backends", () => {
    expect(
      getSpeechMethods(["ya-deepgram", "ya-grok"])
        .slice(0, 2)
        .map((method) => method.label),
    ).toEqual(["Grok STT", "Deepgram STT"]);
  });

  it("prefers Grok over Deepgram when no explicit user method is stored", () => {
    expect(getPreferredSpeechMethod(["ya-deepgram", "ya-grok"])).toBe(
      "ya-grok",
    );
    expect(
      resolveSpeechMethod(
        DEFAULT_SPEECH_METHOD,
        ["ya-deepgram", "ya-grok"],
        false,
      ),
    ).toBe("ya-grok");
  });

  it("keeps explicit choices only while they are still available", () => {
    expect(
      resolveSpeechMethod("ya-deepgram", ["ya-grok", "ya-deepgram"], true),
    ).toBe("ya-deepgram");
    expect(resolveSpeechMethod(DEFAULT_SPEECH_METHOD, ["ya-grok"], true)).toBe(
      DEFAULT_SPEECH_METHOD,
    );
    expect(resolveSpeechMethod("ya-deepgram", ["ya-grok"], true)).toBe(
      DEFAULT_SPEECH_METHOD,
    );
  });
});

describe("YA server speech provider", () => {
  it("reports support for the capture path selected by streaming capability", () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
    vi.stubGlobal("AudioContext", class FakeAudioContext {});
    vi.stubGlobal("WebSocket", class FakeWebSocket {});
    vi.stubGlobal("MediaRecorder", undefined);

    expect(new YaServerProvider("ya-dummy", "").isSupported).toBe(false);
    expect(
      new YaServerProvider("ya-grok", "", { serverStreaming: true })
        .isSupported,
    ).toBe(true);
  });

  it("cancels a pending start before microphone permission resolves", async () => {
    const media = deferred<MediaStream>();
    const getUserMedia = vi.fn(() => media.promise);
    const stopTrack = vi.fn();
    const recorderStart = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal(
      "MediaRecorder",
      class FakeMediaRecorder {
        static isTypeSupported() {
          return true;
        }

        state: RecordingState = "inactive";
        onstop: (() => void) | null = null;

        start() {
          recorderStart();
          this.state = "recording";
        }

        stop() {
          this.state = "inactive";
          this.onstop?.();
        }
      },
    );

    const onEnd = vi.fn();
    const onError = vi.fn();
    const onResult = vi.fn();
    const provider = new YaServerProvider("ya-dummy", "", {
      onEnd,
      onError,
      onResult,
    });

    provider.start();
    expect(provider.getState().status).toBe("starting");

    provider.stop();
    expect(provider.getState().status).toBe("idle");
    expect(onEnd).toHaveBeenCalledTimes(1);

    media.resolve(fakeStream);
    await Promise.resolve();
    await Promise.resolve();

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(recorderStart).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(provider.getState().status).toBe("idle");
  });

  it("commits utterance-final streaming partials as transcript deltas", async () => {
    const stopTrack = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    const onResult = vi.fn();
    const onInterimResult = vi.fn();
    const onEnd = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];

      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};

      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);

      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }

      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            // Simulate the audio clock delivering a frame so the provider
            // sees capture go live and transitions to "listening".
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }

      createGain() {
        return {
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      onResult,
      onInterimResult,
      onEnd,
    });
    provider.start();

    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    ws.receive({ type: "interim", text: "hel", isFinal: false });
    expect(onInterimResult).toHaveBeenLastCalledWith("hel");
    expect(onResult).not.toHaveBeenCalled();

    ws.receive({ type: "interim", text: "hello", isFinal: true });
    expect(onInterimResult).toHaveBeenLastCalledWith("hello");
    expect(onResult).not.toHaveBeenCalled();

    ws.receive({ type: "interim", text: "world", isFinal: false });
    expect(onInterimResult).toHaveBeenLastCalledWith("hello world");

    ws.receive({
      type: "interim",
      text: "hello world",
      isFinal: true,
      speechFinal: true,
    });
    expect(onResult).toHaveBeenLastCalledWith("hello world", undefined);

    ws.receive({
      type: "final",
      text: "hello world",
      transcriptionId: "transcription-1",
    });
    expect(onResult).toHaveBeenLastCalledWith("", {
      transcriptionId: "transcription-1",
    });
    expect(onEnd).toHaveBeenCalledTimes(1);

    provider.dispose();
  });

  it("uses the fuller preview when Smart Turn speech-final regresses", async () => {
    const stopTrack = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    const onResult = vi.fn();
    const onInterimResult = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];

      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            // Simulate the audio clock delivering a frame so the provider
            // sees capture go live and transitions to "listening".
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      smartTurn: { enabled: true, threshold: 0.9, timeoutMs: 3000 },
      onResult,
      onInterimResult,
    });
    provider.start();

    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    ws.receive({
      type: "interim",
      text: "testing speech to text",
      isFinal: false,
    });
    expect(onInterimResult).toHaveBeenLastCalledWith("testing speech to text");

    ws.receive({
      type: "interim",
      text: "To",
      isFinal: true,
      speechFinal: true,
    });

    expect(onResult).toHaveBeenLastCalledWith(
      "testing speech to text",
      undefined,
    );
    expect(JSON.parse(ws.send.mock.calls.at(-1)?.[0] as string)).toEqual({
      type: "stop",
    });

    ws.receive({
      type: "final",
      text: "",
      transcriptionId: "transcription-regressed-final",
    });
    expect(onResult).toHaveBeenLastCalledWith("", {
      transcriptionId: "transcription-regressed-final",
      smartTurnCommand: "send",
    });

    provider.dispose();
  });

  it("commits the current streaming preview on stop and ignores stop-flush partials", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const onResult = vi.fn();
    const onInterimResult = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];

      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            // Simulate the audio clock delivering a frame so the provider
            // sees capture go live and transitions to "listening".
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      onResult,
      onInterimResult,
    });
    provider.start();

    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    ws.receive({
      type: "interim",
      text: "does not delete the content",
      isFinal: false,
    });
    provider.stop();
    expect(onResult).toHaveBeenLastCalledWith(
      "does not delete the content",
      undefined,
    );

    ws.receive({
      type: "interim",
      text: "There's",
      isFinal: true,
      speechFinal: true,
    });
    expect(onResult).toHaveBeenCalledTimes(1);

    ws.receive({
      type: "final",
      text: "",
      transcriptionId: "transcription-2",
    });
    expect(onResult).toHaveBeenLastCalledWith("", {
      transcriptionId: "transcription-2",
    });

    provider.dispose();
  });

  it("applies Smart Turn commands from paused final words", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const onResult = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];

      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            // Simulate the audio clock delivering a frame so the provider
            // sees capture go live and transitions to "listening".
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      smartTurn: { enabled: true, threshold: 0.7, timeoutMs: 3000 },
      onResult,
    });
    provider.start();

    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(ws.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "start",
      backendId: "ya-grok",
      smartTurn: {
        enabled: true,
        threshold: 0.7,
        timeoutMs: 3000,
      },
    });

    ws.receive({
      type: "interim",
      text: "hello send",
      isFinal: true,
      speechFinal: true,
      words: [
        { word: "hello", start: 0, duration: 0.2 },
        { word: "send", start: 0.9, duration: 0.2 },
      ],
    });

    expect(onResult).toHaveBeenLastCalledWith("hello", undefined);
    expect(JSON.parse(ws.send.mock.calls.at(-1)?.[0] as string)).toEqual({
      type: "stop",
    });

    ws.receive({
      type: "final",
      text: "",
      transcriptionId: "transcription-smart-turn",
    });
    expect(onResult).toHaveBeenLastCalledWith("", {
      transcriptionId: "transcription-smart-turn",
      smartTurnCommand: "send",
    });

    provider.dispose();
  });

  it("never shows listening and errors when no audio frame ever arrives", async () => {
    vi.useFakeTimers();
    try {
      const fakeStream = {
        getTracks: () => [{ stop: vi.fn() }],
      } as unknown as MediaStream;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: vi.fn(async () => fakeStream) },
      });
      const onError = vi.fn();
      const onEnd = vi.fn();
      const onResult = vi.fn();

      class FakeWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 3;
        static readonly instances: FakeWebSocket[] = [];
        binaryType: BinaryType = "blob";
        readyState = FakeWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        send = vi.fn();
        constructor(readonly url: string) {
          FakeWebSocket.instances.push(this);
        }
        open() {
          this.readyState = FakeWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        }
        close() {
          this.readyState = FakeWebSocket.CLOSED;
          this.onclose?.(new CloseEvent("close"));
        }
      }

      // A context that resumes but whose processor never fires a callback:
      // capture is dead even though state reports "running".
      class FakeAudioContext {
        readonly state = "suspended";
        readonly sampleRate = 48_000;
        readonly destination = {};
        resume = vi.fn(async () => undefined);
        close = vi.fn(async () => undefined);
        createMediaStreamSource() {
          return { connect: vi.fn(), disconnect: vi.fn() };
        }
        createScriptProcessor() {
          return {
            connect: vi.fn(),
            disconnect: vi.fn(),
            onaudioprocess: null,
          };
        }
        createGain() {
          return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
        }
      }

      vi.stubGlobal("WebSocket", FakeWebSocket);
      vi.stubGlobal("AudioContext", FakeAudioContext);

      let lastState: { status: string; isListening: boolean } | undefined;
      const provider = new YaServerProvider("ya-grok", "", {
        serverStreaming: true,
        onResult,
        onError,
        onEnd,
      });
      provider.subscribe((state) => {
        lastState = state;
      });
      provider.start();
      await vi.advanceTimersByTimeAsync(0);
      FakeWebSocket.instances[0]?.open();
      await vi.advanceTimersByTimeAsync(0);

      // The pipeline is wired but no frame has arrived: still not listening.
      expect(lastState?.isListening).toBe(false);
      expect(lastState?.status).not.toBe("listening");
      expect(onError).not.toHaveBeenCalled();

      // The audio-flow watchdog must surface a visible error.
      await vi.advanceTimersByTimeAsync(3500);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(onResult).not.toHaveBeenCalled();
      expect(lastState?.status).toBe("error");

      provider.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams 16 kHz PCM16 in 100ms chunks and flushes partial stop audio", async () => {
    const fakeTrack = {
      readyState: "live",
      stop: vi.fn(),
      getSettings: () => ({
        sampleRate: 16_000,
        sampleSize: 16,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    } as unknown as MediaStreamTrack;
    const fakeStream = {
      getTracks: () => [fakeTrack],
      getAudioTracks: () => [fakeTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    let processorNode:
      | {
          onaudioprocess:
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void);
        }
      | undefined;
    const audioContextOptions: AudioContextOptions[] = [];
    const scriptProcessorArgs: Array<[number, number, number]> = [];
    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 16_000;
      readonly destination = {};
      constructor(options?: AudioContextOptions) {
        if (options) audioContextOptions.push(options);
      }
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor(
        bufferSize: number,
        inputChannels: number,
        outputChannels: number,
      ) {
        scriptProcessorArgs.push([bufferSize, inputChannels, outputChannels]);
        processorNode = {
          onaudioprocess: null,
        };
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
          get onaudioprocess() {
            return processorNode?.onaudioprocess ?? null;
          },
          set onaudioprocess(
            callback:
              | null
              | ((event: {
                  inputBuffer: { getChannelData: () => Float32Array };
                }) => void),
          ) {
            if (processorNode) processorNode.onaudioprocess = callback;
          },
        };
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
    });
    provider.start();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(audioContextOptions[0]).toMatchObject({
      latencyHint: "interactive",
      sampleRate: 16_000,
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 16_000 },
        sampleSize: { ideal: 16 },
      }),
    });
    expect(scriptProcessorArgs).toEqual([[1024, 1, 1]]);

    const callback = processorNode?.onaudioprocess;
    expect(callback).toBeTypeOf("function");
    const input = new Float32Array(1024).fill(0.25);
    const fireFrame = () =>
      callback?.({ inputBuffer: { getChannelData: () => input } });

    fireFrame();
    expect(
      ws.send.mock.calls.filter(([payload]) => payload instanceof Int16Array),
    ).toHaveLength(0);

    fireFrame();
    const binaryCalls = ws.send.mock.calls.filter(
      ([payload]) => payload instanceof Int16Array,
    );
    expect(binaryCalls).toHaveLength(1);
    expect(binaryCalls[0]?.[0]).toBeInstanceOf(Int16Array);
    expect((binaryCalls[0]?.[0] as Int16Array).length).toBe(1600);
    expect((binaryCalls[0]?.[0] as Int16Array).byteLength).toBe(3200);

    provider.stop();
    const afterStopBinaryCalls = ws.send.mock.calls.filter(
      ([payload]) => payload instanceof Int16Array,
    );
    expect(afterStopBinaryCalls).toHaveLength(2);
    expect((afterStopBinaryCalls[1]?.[0] as Int16Array).length).toBe(448);

    provider.dispose();
  });

  it("keeps a warm streaming mic open across dictations until dispose", async () => {
    let stopped = false;
    const stopTrack = vi.fn(() => {
      stopped = true;
    });
    const fakeTrack = {
      get readyState() {
        return stopped ? "ended" : "live";
      },
      stop: stopTrack,
    } as unknown as MediaStreamTrack;
    const fakeStream = {
      getTracks: () => [fakeTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      keepMicWarm: true,
    });
    const waitForListening = async () => {
      for (let i = 0; i < 10 && provider.getState().status !== "listening"; i += 1) {
        await Promise.resolve();
      }
    };

    provider.start();
    await Promise.resolve();
    FakeWebSocket.instances[0]?.open();
    await waitForListening();
    expect(provider.getState().status).toBe("listening");

    provider.stop();
    expect(stopTrack).not.toHaveBeenCalled();
    FakeWebSocket.instances[0]?.receive({ type: "final", text: "" });
    expect(provider.getState().status).toBe("idle");

    provider.start();
    await Promise.resolve();
    FakeWebSocket.instances[1]?.open();
    await waitForListening();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(provider.getState().status).toBe("listening");

    provider.dispose();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("stops a pending warm mic pre-open if disposed before it resolves", async () => {
    const media = deferred<MediaStream>();
    const stopTrack = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(() => media.promise);
    const query = vi.fn(async () => ({ state: "granted" }));

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query },
    });
    vi.stubGlobal("WebSocket", class FakeWebSocket {});
    vi.stubGlobal("AudioContext", class FakeAudioContext {});

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      keepMicWarm: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(query).toHaveBeenCalledWith({ name: "microphone" });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    provider.dispose();
    media.resolve(fakeStream);
    await Promise.resolve();
    await Promise.resolve();

    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("stops the streaming mic on stop when warm mic is disabled", async () => {
    const stopTrack = vi.fn();
    const fakeStream = {
      getTracks: () => [{ readyState: "live", stop: stopTrack }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
    });

    provider.start();
    await Promise.resolve();
    FakeWebSocket.instances[0]?.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.getState().status).toBe("listening");

    provider.stop();

    expect(stopTrack).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("salvages the preview when the stream errors mid-session", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const onResult = vi.fn();
    const onError = vi.fn();
    const onEnd = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      onResult,
      onError,
      onEnd,
    });
    provider.start();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    ws.receive({ type: "interim", text: "hello world", isFinal: false });
    // Upstream gives up while the user paused: the words must not be lost.
    ws.receive({ type: "error", message: "xAI STT streaming timed out" });

    expect(onResult).toHaveBeenLastCalledWith("hello world", undefined);
    expect(onError).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);

    provider.dispose();
  });

  it("surfaces a mid-session error when there is nothing to salvage", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const onResult = vi.fn();
    const onError = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      onResult,
      onError,
    });
    provider.start();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    ws.receive({ type: "error", message: "xAI STT streaming timed out" });

    expect(onError).toHaveBeenCalledWith("xAI STT streaming timed out");
    expect(onResult).not.toHaveBeenCalled();

    provider.dispose();
  });
});
