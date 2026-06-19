export type SpeechWaveformRenderer = (
  samples: Float32Array,
  sampleCount: number,
) => void;

const EMPTY_SAMPLES = new Float32Array(0);
const MAX_FRAME_RATE = 60;
const MIN_FRAME_INTERVAL_MS = 1000 / MAX_FRAME_RATE;
const FRAME_INTERVAL_TOLERANCE_MS = 0.5;

let latestSamples = EMPTY_SAMPLES;
let latestSampleCount = 0;
let samplesPending = false;
let renderer: SpeechWaveformRenderer | null = null;
let animationFrameId: number | null = null;
let lastRenderedAt = Number.NEGATIVE_INFINITY;

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function cancelPendingFrame(): void {
  if (animationFrameId === null || typeof cancelAnimationFrame === "undefined") {
    animationFrameId = null;
    return;
  }
  cancelAnimationFrame(animationFrameId);
  animationFrameId = null;
}

function scheduleFrame(): void {
  if (
    animationFrameId !== null ||
    renderer === null ||
    !samplesPending ||
    !isDocumentVisible() ||
    typeof requestAnimationFrame === "undefined"
  ) {
    return;
  }
  animationFrameId = requestAnimationFrame(renderFrame);
}

function renderFrame(timestamp: number): void {
  animationFrameId = null;
  if (renderer === null || !samplesPending || !isDocumentVisible()) return;
  if (
    timestamp - lastRenderedAt + FRAME_INTERVAL_TOLERANCE_MS <
    MIN_FRAME_INTERVAL_MS
  ) {
    scheduleFrame();
    return;
  }

  samplesPending = false;
  lastRenderedAt = timestamp;
  renderer(latestSamples, latestSampleCount);
  // Audio may publish again while a renderer is doing other synchronous work.
  // Keep a single-frame queue rather than allowing a render backlog.
  scheduleFrame();
}

function handleVisibilityChange(): void {
  if (isDocumentVisible()) {
    scheduleFrame();
  } else {
    cancelPendingFrame();
  }
}

export function publishSpeechWaveformSamples(samples: Float32Array): void {
  if (samples.length === 0) return;
  if (latestSamples.length < samples.length) {
    latestSamples = new Float32Array(samples.length);
  }
  latestSamples.set(samples);
  latestSampleCount = samples.length;
  samplesPending = true;
  scheduleFrame();
}

export function clearSpeechWaveform(): void {
  latestSampleCount = 0;
  samplesPending = true;
  scheduleFrame();
}

export function attachSpeechWaveformRenderer(
  nextRenderer: SpeechWaveformRenderer,
): () => void {
  renderer = nextRenderer;
  lastRenderedAt = Number.NEGATIVE_INFINITY;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  scheduleFrame();
  return () => {
    if (renderer !== nextRenderer) return;
    renderer = null;
    cancelPendingFrame();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
