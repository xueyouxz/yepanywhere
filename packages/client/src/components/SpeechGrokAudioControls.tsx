import { useId } from "react";
import type {
  GrokSpeechAudioSettings,
  GrokSpeechAudioUplinkMode,
} from "../lib/speechProviders/SpeechProvider";

interface SpeechGrokAudioControlsProps {
  settings: GrokSpeechAudioSettings;
  onChange: (settings: GrokSpeechAudioSettings) => void;
  compact?: boolean;
  disabled?: boolean;
}

const UPLINK_OPTIONS: Array<{
  value: GrokSpeechAudioUplinkMode;
  label: string;
  description: string;
}> = [
  {
    value: "pcm16",
    label: "PCM16",
    description: "Send raw 16 kHz PCM16 from browser to YA.",
  },
  {
    value: "browser-compressed",
    label: "Batch",
    description: "Use the browser's compressed non-streaming upload.",
  },
];

function cleanSettings(
  settings: Partial<GrokSpeechAudioSettings>,
): GrokSpeechAudioSettings {
  return {
    uplinkMode:
      settings.uplinkMode === "browser-compressed"
        ? "browser-compressed"
        : "pcm16",
  };
}

export function SpeechGrokAudioControls({
  settings,
  onChange,
  compact = false,
  disabled = false,
}: SpeechGrokAudioControlsProps) {
  const id = useId();
  const clean = cleanSettings(settings);
  const body = (
    <div className="speech-grok-audio-body">
      <div className="speech-grok-audio-options">
        {UPLINK_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="speech-grok-audio-option"
            title={option.description}
          >
            <input
              type="radio"
              name={`${id}-grok-stt-audio`}
              value={option.value}
              checked={clean.uplinkMode === option.value}
              disabled={disabled}
              onChange={() => onChange({ uplinkMode: option.value })}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <p className="speech-smart-turn-caption">
        {clean.uplinkMode === "pcm16"
          ? "Lossless browser-to-YA uplink. Enables Grok streaming and Smart Turn."
          : "Compressed browser-to-YA upload for non-streaming Grok batch transcription."}
      </p>
    </div>
  );

  if (compact) {
    return (
      <details className="speech-smart-turn speech-grok-audio speech-smart-turn--compact">
        <summary title="Grok STT browser-to-YA audio format">Audio</summary>
        <div className="speech-smart-turn-popover">{body}</div>
      </details>
    );
  }

  return (
    <div className="speech-smart-turn speech-grok-audio">
      <div className="speech-smart-turn-toggle">
        <span>Grok STT audio</span>
      </div>
      {body}
    </div>
  );
}
