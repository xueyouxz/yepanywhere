import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSpeechWaveformSamples } from "../lib/speechWaveform";

const WAVEFORM_HEIGHT = 36;
const WAVEFORM_MIDLINE = WAVEFORM_HEIGHT / 2;

function resamplePeaks(
  samples: readonly number[],
  targetCount: number,
): readonly number[] {
  if (targetCount <= 0) return [];
  return Array.from({ length: targetCount }, (_, index) => {
    const start = Math.floor((index * samples.length) / targetCount);
    const end = Math.max(
      start + 1,
      Math.floor(((index + 1) * samples.length) / targetCount),
    );
    let peak = 0;
    for (
      let sampleIndex = start;
      sampleIndex < Math.min(end, samples.length);
      sampleIndex += 1
    ) {
      peak = Math.max(peak, samples[sampleIndex] ?? 0);
    }
    return peak;
  });
}

function createWaveformPath(samples: readonly number[]): string {
  if (samples.length === 0) return "";
  const xAt = (index: number) =>
    samples.length === 1 ? 50 : (index * 100) / (samples.length - 1);
  const halfHeightAt = (sample: number) =>
    Math.max(1, sample * WAVEFORM_MIDLINE);
  const top = samples.map(
    (sample, index) =>
      `${xAt(index)} ${WAVEFORM_MIDLINE - halfHeightAt(sample)}`,
  );
  const bottom = samples
    .map(
      (sample, index) =>
        `${xAt(index)} ${WAVEFORM_MIDLINE + halfHeightAt(sample)}`,
    )
    .reverse();
  return `M ${top.join(" L ")} L ${bottom.join(" L ")} Z`;
}

export function SpeechWaveform() {
  const samples = useSpeechWaveformSamples();
  const waveformRef = useRef<SVGSVGElement>(null);
  const [widthPx, setWidthPx] = useState(0);

  useLayoutEffect(() => {
    const waveform = waveformRef.current;
    if (!waveform) return;
    const updateWidth = (width: number) => {
      setWidthPx(Math.max(0, width));
    };
    updateWidth(waveform.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(waveform);
    return () => observer.disconnect();
  }, []);

  const barCount = Math.max(1, Math.floor(widthPx));
  const visibleSamples = useMemo(
    () => resamplePeaks(samples, barCount),
    [barCount, samples],
  );
  const waveformPath = useMemo(
    () => createWaveformPath(visibleSamples),
    [visibleSamples],
  );

  return (
    <div
      className="composer-speech-waveform"
      data-composer-elastic="true"
      aria-hidden="true"
    >
      <svg
        ref={waveformRef}
        viewBox={`0 0 100 ${WAVEFORM_HEIGHT}`}
        preserveAspectRatio="none"
        focusable="false"
      >
        <title>Microphone waveform</title>
        <path className="composer-speech-waveform-shape" d={waveformPath} />
      </svg>
    </div>
  );
}
