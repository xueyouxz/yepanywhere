import { useSyncExternalStore } from "react";

const SILENCE_DB = -80;
const CLIP_PEAK = 0.8;
const EMPTY_SAMPLES = Object.freeze([0]);
const listeners = new Set<() => void>();
let snapshot: readonly number[] = EMPTY_SAMPLES;
let lastPublishedAt = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

export function publishSpeechWaveformSamples(samples: Float32Array): void {
  const now =
    typeof performance === "undefined" ? Date.now() : performance.now();
  if (now - lastPublishedAt < 40 || samples.length === 0) return;
  lastPublishedAt = now;

  const normalizedSamples = Array.from(samples, (sample) => {
    const peak = Math.abs(sample);
    if (peak <= 0) return 0;
    // Map raw peak amplitude through a bounded logarithmic scale. Quiet speech
    // stays legible, while peaks at 80% amplitude and above visibly saturate.
    const clippedPeak = Math.min(CLIP_PEAK, peak);
    const decibels = 20 * Math.log10(clippedPeak);
    const clipDecibels = 20 * Math.log10(CLIP_PEAK);
    return Math.min(
      1,
      Math.max(0, (decibels - SILENCE_DB) / (clipDecibels - SILENCE_DB)),
    );
  });
  snapshot = Object.freeze(normalizedSamples);
  emit();
}

export function clearSpeechWaveform(): void {
  lastPublishedAt = 0;
  if (snapshot === EMPTY_SAMPLES) return;
  snapshot = EMPTY_SAMPLES;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): readonly number[] {
  return snapshot;
}

export function useSpeechWaveformSamples(): readonly number[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
