import type { AttachmentUploadQuality } from "../hooks/useAttachmentUploadQuality";

interface AttachmentQualityToggleProps {
  quality: AttachmentUploadQuality;
  onChange: (quality: AttachmentUploadQuality) => void;
  disabled?: boolean;
}

export function AttachmentQualityToggle({
  quality,
  onChange,
  disabled,
}: AttachmentQualityToggleProps) {
  return (
    <div
      className="attachment-quality-toggle"
      role="group"
      aria-label="Attachment upload quality"
    >
      <button
        type="button"
        className={`attachment-quality-option ${quality === "sd" ? "active" : ""}`}
        onClick={() => onChange("sd")}
        disabled={disabled}
        aria-pressed={quality === "sd"}
        title="Standard detail"
      >
        SD
      </button>
      <button
        type="button"
        className={`attachment-quality-option ${quality === "hd" ? "active" : ""}`}
        onClick={() => onChange("hd")}
        disabled={disabled}
        aria-pressed={quality === "hd"}
        title="High detail"
      >
        HD
      </button>
    </div>
  );
}
