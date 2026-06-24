import {
  DEFAULT_RECAP_AFTER_SECONDS,
  MAX_RECAP_AFTER_SECONDS,
  MIN_RECAP_AFTER_SECONDS,
  normalizeRecapAfterSeconds,
} from "@yep-anywhere/shared";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import { CommittedRangeInput } from "./ui/CommittedRangeInput";

interface RecapAfterSecondsControlProps {
  value?: number;
  disabled?: boolean;
  className?: string;
  onCommit: (value: number) => void | Promise<void>;
}

const RECAP_AFTER_SECONDS_SLIDER_MAX = 3000;

export function RecapAfterSecondsControl({
  value,
  disabled,
  className,
  onCommit,
}: RecapAfterSecondsControlProps) {
  const { t } = useI18n();
  const normalizedValue = useMemo(
    () => normalizeRecapAfterSeconds(value ?? DEFAULT_RECAP_AFTER_SECONDS),
    [value],
  );
  const [draftValue, setDraftValue] = useState(normalizedValue);
  const [draftText, setDraftText] = useState(String(normalizedValue));
  const lastCommittedRef = useRef<number | null>(null);

  useEffect(() => {
    setDraftValue(normalizedValue);
    setDraftText(String(normalizedValue));
    lastCommittedRef.current = null;
  }, [normalizedValue]);

  const commitValue = useCallback(
    (rawValue: number) => {
      const next = normalizeRecapAfterSeconds(rawValue);
      setDraftValue(next);
      setDraftText(String(next));
      if (next !== normalizedValue && lastCommittedRef.current !== next) {
        lastCommittedRef.current = next;
        void onCommit(next);
      }
    },
    [normalizedValue, onCommit],
  );

  const commitText = useCallback(() => {
    commitValue(Number(draftText));
  }, [commitValue, draftText]);

  const resetDraft = useCallback(() => {
    setDraftValue(normalizedValue);
    setDraftText(String(normalizedValue));
  }, [normalizedValue]);

  const updateSliderDraft = (rawValue: number) => {
    const next = normalizeRecapAfterSeconds(rawValue);
    setDraftText(String(next));
  };

  const updateTextDraft = (text: string) => {
    setDraftText(text);
    if (text.trim() === "") {
      return;
    }
    const parsed = Number(text);
    if (Number.isFinite(parsed)) {
      setDraftValue(normalizeRecapAfterSeconds(parsed));
    }
  };

  const commitSlider = (rawValue: number) => {
    commitValue(rawValue);
  };

  const handleTextBlur = () => {
    commitText();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitText();
    } else if (event.key === "Escape") {
      event.preventDefault();
      resetDraft();
    }
  };
  const sliderValue = Math.min(draftValue, RECAP_AFTER_SECONDS_SLIDER_MAX);

  return (
    <div
      className={
        className
          ? `recap-after-seconds-control ${className}`
          : "recap-after-seconds-control"
      }
    >
      <span className="recap-after-seconds-label">
        {t("recapAfterSecondsLabel")}
      </span>
      <span className="output-appearance-slider-row recap-after-seconds-row">
        <CommittedRangeInput
          min={MIN_RECAP_AFTER_SECONDS}
          max={RECAP_AFTER_SECONDS_SLIDER_MAX}
          step={1}
          value={sliderValue}
          disabled={disabled}
          aria-label={t("recapAfterSecondsAria")}
          onDraftChange={updateSliderDraft}
          onCommit={commitSlider}
        />
        <span className="output-appearance-number-wrap">
          <input
            type="number"
            className="settings-input-small output-appearance-number"
            min={MIN_RECAP_AFTER_SECONDS}
            max={MAX_RECAP_AFTER_SECONDS}
            step={1}
            value={draftText}
            disabled={disabled}
            aria-label={t("recapAfterSecondsAria")}
            onChange={(event) => updateTextDraft(event.currentTarget.value)}
            onBlur={handleTextBlur}
            onKeyDown={handleKeyDown}
          />
          <span className="output-appearance-unit">
            {t("recapAfterSecondsUnit")}
          </span>
        </span>
      </span>
    </div>
  );
}
