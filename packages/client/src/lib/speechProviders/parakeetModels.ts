export const DEFAULT_PARAKEET_SPEECH_MODEL = "nvidia/parakeet-tdt-0.6b-v3";

export interface ParakeetSpeechModelPreset {
  value: string;
  label: string;
}

export const PARAKEET_SPEECH_MODEL_PRESETS: ParakeetSpeechModelPreset[] = [
  {
    value: DEFAULT_PARAKEET_SPEECH_MODEL,
    label: "TDT 0.6B v3 multilingual",
  },
  {
    value: "nvidia/parakeet-ctc-1.1b",
    label: "CTC 1.1B English lowercase",
  },
];

export function getParakeetSpeechPresetValue(model: string): string {
  return PARAKEET_SPEECH_MODEL_PRESETS.some((preset) => preset.value === model)
    ? model
    : "";
}

export function cleanParakeetSpeechModel(
  value: string | null | undefined,
): string {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_PARAKEET_SPEECH_MODEL;
}
