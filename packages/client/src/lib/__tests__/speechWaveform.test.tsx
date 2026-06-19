// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechWaveform } from "../../components/SpeechWaveform";
import {
  clearSpeechWaveform,
  publishSpeechWaveformSamples,
} from "../speechWaveform";

describe("speech waveform", () => {
  afterEach(() => {
    cleanup();
    clearSpeechWaveform();
    vi.restoreAllMocks();
  });

  it("renders a width-dependent filled envelope clipped to full height", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    vi.spyOn(performance, "now").mockReturnValue(100);
    const { container } = render(<SpeechWaveform />);

    act(() => {
      resizeCallback?.(
        [{ contentRect: { width: 120 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    act(() => {
      publishSpeechWaveformSamples(
        Float32Array.from({ length: 320 }, (_, index) =>
          index % 2 === 0 ? 0.8 : -0.8,
        ),
      );
    });

    const shape = container.querySelector(".composer-speech-waveform-shape");
    const path = shape?.getAttribute("d") ?? "";
    expect(path.match(/ L /g)).toHaveLength(239);
    expect(path).toContain("M 0 0");
    expect(path).toContain("36");
    expect(container.querySelector("rect")).toBeNull();
  });
});
