export const DEFAULT_PARAKEET_SPEECH_MODEL = "nvidia/parakeet-tdt-0.6b-v3";

export type ParakeetModelBackendId = "ya-parakeet" | "ya-nemo";

export interface ParakeetSpeechModelPreset {
  value: string;
  label: string;
  supportedBackends: readonly ParakeetModelBackendId[];
}

export const PARAKEET_SPEECH_MODEL_PRESETS: ParakeetSpeechModelPreset[] = [
  {
    value: DEFAULT_PARAKEET_SPEECH_MODEL,
    label: "TDT 0.6B v3 multilingual",
    supportedBackends: ["ya-parakeet", "ya-nemo"],
  },
  {
    value: "nvidia/parakeet-ctc-1.1b",
    label: "CTC 1.1B English lowercase",
    supportedBackends: ["ya-parakeet", "ya-nemo"],
  },
  {
    value: "nvidia/parakeet-rnnt-1.1b",
    label: "RNNT 1.1B English lowercase",
    supportedBackends: ["ya-nemo"],
  },
];

const PARAKEET_MODEL_BACKEND_LABELS: Record<ParakeetModelBackendId, string> = {
  "ya-parakeet": "Transformers Parakeet",
  "ya-nemo": "NeMo Parakeet",
};

export function getParakeetModelBackendLabel(
  backendId: ParakeetModelBackendId,
): string {
  return PARAKEET_MODEL_BACKEND_LABELS[backendId];
}

export function getParakeetSpeechPreset(
  model: string,
): ParakeetSpeechModelPreset | undefined {
  return PARAKEET_SPEECH_MODEL_PRESETS.find((preset) => preset.value === model);
}

export function getParakeetSpeechPresetValue(model: string): string {
  return getParakeetSpeechPreset(model)?.value ?? "";
}

export function cleanParakeetSpeechModel(
  value: string | null | undefined,
): string {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_PARAKEET_SPEECH_MODEL;
}

export function isParakeetModelBackend(
  methodId: string,
): methodId is ParakeetModelBackendId {
  return methodId === "ya-parakeet" || methodId === "ya-nemo";
}

export function resolveParakeetModelBackend(
  modelValue: string,
  preferredBackend: string,
  availableBackends: readonly string[],
): ParakeetModelBackendId | null {
  const model = cleanParakeetSpeechModel(modelValue);
  const available = new Set<ParakeetModelBackendId>();
  for (const backend of availableBackends) {
    if (isParakeetModelBackend(backend)) {
      available.add(backend);
    }
  }
  if (isParakeetModelBackend(preferredBackend)) {
    available.add(preferredBackend);
  }

  const preset = getParakeetSpeechPreset(model);
  if (!preset) {
    return isParakeetModelBackend(preferredBackend)
      ? preferredBackend
      : (Array.from(available)[0] ?? null);
  }

  if (
    isParakeetModelBackend(preferredBackend) &&
    preset.supportedBackends.includes(preferredBackend)
  ) {
    return preferredBackend;
  }

  return (
    preset.supportedBackends.find((backend) => available.has(backend)) ?? null
  );
}

/**
 * Guard against pairing a Parakeet model with a backend that can't run it.
 * If `method` is a Parakeet backend that doesn't support `model` (e.g.
 * `rnnt-1.1b` is NeMo-only), route to a backend that does when one is
 * available — keeping the user's model. Non-Parakeet methods and
 * already-compatible pairs pass through unchanged. When no compatible backend
 * is available the original `method` is returned, so the request fails with a
 * clear model-load error rather than being silently sent somewhere that can't
 * run it.
 */
export function reconcileParakeetBackendForModel(
  method: string,
  model: string,
  availableBackends: readonly string[],
): string {
  if (!isParakeetModelBackend(method)) return method;
  const preset = getParakeetSpeechPreset(cleanParakeetSpeechModel(model));
  if (!preset || preset.supportedBackends.includes(method)) return method;
  return (
    resolveParakeetModelBackend(model, method, availableBackends) ?? method
  );
}

export function getCompatibleParakeetModelForBackend(
  modelValue: string,
  backendId: ParakeetModelBackendId,
): string {
  const model = cleanParakeetSpeechModel(modelValue);
  const preset = getParakeetSpeechPreset(model);
  if (!preset || preset.supportedBackends.includes(backendId)) {
    return model;
  }
  return (
    PARAKEET_SPEECH_MODEL_PRESETS.find((candidate) =>
      candidate.supportedBackends.includes(backendId),
    )?.value ?? DEFAULT_PARAKEET_SPEECH_MODEL
  );
}
