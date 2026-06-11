import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FilterOption } from "./FilterDropdown";
import { SpeechGrokAudioControls } from "./SpeechGrokAudioControls";
import { SpeechSmartTurnControls } from "./SpeechSmartTurnControls";
import type { SpeechMethodId } from "../lib/speechProviders/methods";
import type {
  GrokSpeechAudioSettings,
  SpeechSmartTurnSettings,
} from "../lib/speechProviders/SpeechProvider";

interface SpeechControlMenuProps {
  trigger: ReactNode;
  showMethodSelector: boolean;
  methodOptions: FilterOption<SpeechMethodId>[];
  selectedMethod: SpeechMethodId;
  onMethodChange: (selected: string[]) => void;
  smartTurnSettings?: SpeechSmartTurnSettings;
  onSmartTurnSettingsChange?: (settings: SpeechSmartTurnSettings) => void;
  smartTurnDisabled?: boolean;
  grokAudioSettings?: GrokSpeechAudioSettings;
  onGrokAudioSettingsChange?: (settings: GrokSpeechAudioSettings) => void;
}

const LONG_PRESS_MS = 500;

export function SpeechControlMenu({
  trigger,
  showMethodSelector,
  methodOptions,
  selectedMethod,
  onMethodChange,
  smartTurnSettings,
  onSmartTurnSettingsChange,
  smartTurnDisabled = false,
  grokAudioSettings,
  onGrokAudioSettingsChange,
}: SpeechControlMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressOpenedRef = useRef(false);
  const selectedMethodLabel = useMemo(
    () =>
      methodOptions.find((option) => option.value === selectedMethod)?.label ??
      selectedMethod,
    [methodOptions, selectedMethod],
  );
  const showGrokAudioControls =
    selectedMethod === "ya-grok" &&
    !!grokAudioSettings &&
    !!onGrokAudioSettingsChange;
  const showSmartTurnControls =
    !!smartTurnSettings && !!onSmartTurnSettingsChange;
  const hasOptions =
    showMethodSelector || showGrokAudioControls || showSmartTurnControls;

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!hasOptions) {
      setOpen(false);
    }
  }, [hasOptions]);

  useEffect(() => {
    return clearLongPress;
  }, [clearLongPress]);

  useEffect(() => {
    if (!open) return;

    const handleDocumentPointerDown = (event: globalThis.PointerEvent) => {
      const root = rootRef.current;
      if (root?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    return () =>
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      );
  }, [open]);

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!hasOptions || panelRef.current?.contains(event.target as Node)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearLongPress();
    longPressOpenedRef.current = false;
    setOpen((current) => !current);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!hasOptions || event.button !== 0) {
      return;
    }

    clearLongPress();
    longPressOpenedRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressOpenedRef.current = true;
      longPressTimerRef.current = null;
      setOpen(true);
    }, LONG_PRESS_MS);
  };

  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!hasOptions || panelRef.current?.contains(event.target as Node)) {
      return;
    }

    if (longPressOpenedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      longPressOpenedRef.current = false;
      return;
    }

    if (open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: This non-interactive wrapper captures long-press/context gestures for the nested speech trigger and popup.
    <div
      ref={rootRef}
      role="presentation"
      className={`speech-control-menu${open ? " is-open" : ""}`}
      onClickCapture={handleClickCapture}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
    >
      {trigger}
      {open && hasOptions && (
        <div
          ref={panelRef}
          className="speech-options-panel"
          role="dialog"
          aria-label="Speech options"
        >
          <div className="speech-options-header">
            <div className="speech-options-title-block">
              <span className="speech-options-title">Speech</span>
              <span className="speech-options-subtitle">
                {selectedMethodLabel}
              </span>
            </div>
            <button
              type="button"
              className="speech-options-close"
              onClick={() => setOpen(false)}
              aria-label="Close speech options"
              title="Close speech options"
            >
              x
            </button>
          </div>
          {showMethodSelector && (
            <section className="speech-options-section">
              <div className="speech-options-section-title">STT backend</div>
              <div
                className="speech-method-options"
                role="radiogroup"
                aria-label="STT backend"
              >
                {methodOptions.map((option) => {
                  const selected = option.value === selectedMethod;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`speech-method-option${
                        selected ? " selected" : ""
                      }`}
                      role="radio"
                      aria-checked={selected}
                      onClick={() => onMethodChange([option.value])}
                    >
                      <span className="speech-method-radio" aria-hidden="true">
                        {selected && (
                          <span className="speech-method-radio-dot" />
                        )}
                      </span>
                      <span className="speech-method-copy">
                        <span className="speech-method-label">
                          {option.label}
                        </span>
                        {option.description && (
                          <span className="speech-method-description">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          {showGrokAudioControls && (
            <section className="speech-options-section">
              <SpeechGrokAudioControls
                settings={grokAudioSettings}
                onChange={onGrokAudioSettingsChange}
                disabled={smartTurnDisabled}
              />
            </section>
          )}
          {showSmartTurnControls && (
            <section className="speech-options-section">
              <SpeechSmartTurnControls
                settings={smartTurnSettings}
                onChange={onSmartTurnSettingsChange}
                disabled={smartTurnDisabled}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
