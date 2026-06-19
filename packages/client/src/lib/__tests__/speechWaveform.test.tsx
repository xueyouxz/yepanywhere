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
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces audio updates into paint-paced canvas frames", () => {
    let nextFrameId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    });
    const cancelAnimationFrame = vi.fn((id: number) => {
      frames.delete(id);
    });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const context = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      fillStyle: "",
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.spyOn(
      HTMLCanvasElement.prototype,
      "getBoundingClientRect",
    ).mockReturnValue({
      bottom: 36,
      height: 36,
      left: 0,
      right: 120,
      top: 0,
      width: 120,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const { container } = render(<SpeechWaveform />);
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();

    act(() => {
      publishSpeechWaveformSamples(Float32Array.from([0.1, -0.2]));
      publishSpeechWaveformSamples(Float32Array.from([0.4, -0.8]));
      publishSpeechWaveformSamples(Float32Array.from([0.8, -0.8]));
    });

    // Audio callbacks only replace the latest pending buffer. Until the browser
    // offers a paint, no normalization, resampling, path generation, or draw
    // occurs, and no second animation frame is queued.
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
    expect(context.fill).not.toHaveBeenCalled();

    const renderNextFrame = (timestamp: number) => {
      const [id, callback] = frames.entries().next().value as [
        number,
        FrameRequestCallback,
      ];
      frames.delete(id);
      act(() => callback(timestamp));
    };

    renderNextFrame(0);
    expect(context.fill).toHaveBeenCalledTimes(1);
    // 120 CSS-pixel columns form 120 shared-edge trapezoids.
    expect(context.lineTo).toHaveBeenCalledTimes(241);
    expect(context.moveTo).toHaveBeenCalledWith(0, 0);
    expect(context.lineTo).toHaveBeenCalledWith(120, 36);

    act(() => {
      publishSpeechWaveformSamples(Float32Array.from([0.8, -0.8]));
    });
    expect(frames).toHaveLength(1);

    // A high-refresh display may offer another paint too soon. YA skips the
    // draw and keeps one pending frame rather than exceeding 60 fps.
    renderNextFrame(8);
    expect(context.fill).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);

    renderNextFrame(17);
    expect(context.fill).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(0);
  });

  it("does not queue paints while the document is hidden", () => {
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    render(<SpeechWaveform />);
    act(() => {
      publishSpeechWaveformSamples(Float32Array.from([0.8]));
    });

    expect(requestAnimationFrame).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
