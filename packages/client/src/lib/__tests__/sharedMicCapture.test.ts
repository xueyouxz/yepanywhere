// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { startSpeechWaveformMonitor } from "../speechProviders/sharedMicCapture";

describe("speech waveform monitor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards microphone samples and disconnects its silent audio graph", () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const processor = {
      onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const gain = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const closeContext = vi.fn(async () => undefined);

    class FakeAudioContext {
      destination = {};
      createMediaStreamSource = vi.fn(() => source);
      createScriptProcessor = vi.fn(() => processor);
      createGain = vi.fn(() => gain);
      resume = vi.fn(async () => undefined);
      close = closeContext;
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const onSamples = vi.fn();
    const stop = startSpeechWaveformMonitor({} as MediaStream, onSamples);
    const samples = Float32Array.from([0.1, -0.2]);

    processor.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => samples,
      },
    } as unknown as AudioProcessingEvent);

    expect(onSamples).toHaveBeenCalledWith(samples);
    stop();
    expect(processor.onaudioprocess).toBeNull();
    expect(processor.disconnect).toHaveBeenCalled();
    expect(source.disconnect).toHaveBeenCalled();
    expect(gain.disconnect).toHaveBeenCalled();
    expect(closeContext).toHaveBeenCalled();
  });

  it("does not break capture when the optional audio monitor cannot start", () => {
    vi.stubGlobal(
      "AudioContext",
      class FailingAudioContext {
        constructor() {
          throw new Error("audio context limit reached");
        }
      },
    );

    expect(() =>
      startSpeechWaveformMonitor({} as MediaStream, vi.fn()),
    ).not.toThrow();
  });
});
