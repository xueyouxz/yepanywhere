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
    expect(getSpeechMethods(["ya-custom-stt"]).map((method) => method.id)).toEqual(
      ["ya-custom-stt", DEFAULT_SPEECH_METHOD],
    );
  });

  it("uses explicit labels for known STT backends", () => {
    expect(
      getSpeechMethods(["ya-deepgram", "ya-grok"])
        .slice(0, 2)
        .map((method) => method.label),
    ).toEqual(["Grok STT", "Deepgram STT"]);
  });

  it("prefers Grok over Deepgram when no explicit user method is stored", () => {
    expect(getPreferredSpeechMethod(["ya-deepgram", "ya-grok"])).toBe("ya-grok");
    expect(
      resolveSpeechMethod(
        DEFAULT_SPEECH_METHOD,
        ["ya-deepgram", "ya-grok"],
        false,
      ),
    ).toBe("ya-grok");
  });

  it("keeps explicit choices only while they are still available", () => {
    expect(resolveSpeechMethod("ya-deepgram", ["ya-grok", "ya-deepgram"], true)).toBe(
      "ya-deepgram",
    );
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
    vi.stubGlobal(
      "AudioContext",
      class FakeAudioContext {},
    );
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

  it("commits final streaming partials as transcript deltas", async () => {
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
        return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
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
    expect(onInterimResult).toHaveBeenLastCalledWith("");
    expect(onResult).toHaveBeenLastCalledWith("hello", undefined);

    ws.receive({ type: "interim", text: "hello world", isFinal: false });
    expect(onInterimResult).toHaveBeenLastCalledWith("world");

    ws.receive({
      type: "interim",
      text: "hello world",
      isFinal: true,
      speechFinal: true,
    });
    expect(onResult).toHaveBeenLastCalledWith("world", undefined);

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
});
