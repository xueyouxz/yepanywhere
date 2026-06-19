import { useLayoutEffect, useRef } from "react";
import { attachSpeechWaveformRenderer } from "../lib/speechWaveform";

const SILENCE_DB = -80;
const CLIP_PEAK = 0.8;
const CLIP_DB = 20 * Math.log10(CLIP_PEAK);

function normalizedAmplitude(peak: number): number {
  if (peak <= 0) return 0;
  const decibels = 20 * Math.log10(Math.min(CLIP_PEAK, peak));
  return Math.min(
    1,
    Math.max(0, (decibels - SILENCE_DB) / (CLIP_DB - SILENCE_DB)),
  );
}

function peakForColumn(
  samples: Float32Array,
  sampleCount: number,
  column: number,
  columnCount: number,
): number {
  if (sampleCount === 0) return 0;
  const start = Math.floor((column * sampleCount) / columnCount);
  const end = Math.max(
    start + 1,
    Math.floor(((column + 1) * sampleCount) / columnCount),
  );
  let peak = 0;
  for (let index = start; index < Math.min(end, sampleCount); index += 1) {
    peak = Math.max(peak, Math.abs(samples[index] ?? 0));
  }
  return normalizedAmplitude(peak);
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  samples: Float32Array,
  sampleCount: number,
  halfHeights: Float32Array,
  width: number,
  height: number,
  color: string,
): void {
  if (width === 0 || height === 0) return;

  const deviceScale = Math.max(1, window.devicePixelRatio || 1);
  const backingWidth = Math.max(1, Math.round(width * deviceScale));
  const backingHeight = Math.max(1, Math.round(height * deviceScale));
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    context.fillStyle = color;
  }
  context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
  context.clearRect(0, 0, width, height);
  if (sampleCount === 0) return;

  const columnCount = Math.max(1, Math.ceil(width));
  const midpoint = height / 2;
  for (let column = 0; column <= columnCount; column += 1) {
    const sampleColumn = Math.min(column, columnCount - 1);
    halfHeights[column] = Math.max(
      1,
      peakForColumn(samples, sampleCount, sampleColumn, columnCount) * midpoint,
    );
  }

  context.beginPath();
  context.moveTo(0, midpoint - (halfHeights[0] ?? 1));
  for (let column = 1; column <= columnCount; column += 1) {
    const x = Math.min(width, column);
    context.lineTo(x, midpoint - (halfHeights[column] ?? 1));
  }
  for (let column = columnCount; column >= 0; column -= 1) {
    const x = Math.min(width, column);
    context.lineTo(x, midpoint + (halfHeights[column] ?? 1));
  }
  context.closePath();
  context.fill();
}

export function SpeechWaveform() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let halfHeights = new Float32Array(0);
    const color = getComputedStyle(canvas).color;
    context.fillStyle = color;
    const detachRenderer = attachSpeechWaveformRenderer(
      (samples, sampleCount) => {
        const bounds = canvas.getBoundingClientRect();
        const width = Math.max(0, bounds.width);
        const height = Math.max(0, bounds.height);
        const requiredColumns = Math.max(1, Math.ceil(width)) + 1;
        if (halfHeights.length < requiredColumns) {
          halfHeights = new Float32Array(requiredColumns);
        }
        drawWaveform(
          canvas,
          context,
          samples,
          sampleCount,
          halfHeights,
          width,
          height,
          color,
        );
      },
    );
    return detachRenderer;
  }, []);

  return (
    <div
      className="composer-speech-waveform"
      data-composer-elastic="true"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
