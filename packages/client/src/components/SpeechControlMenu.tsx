import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FilterOption } from "./FilterDropdown";
import { SpeechSmartTurnControls } from "./SpeechSmartTurnControls";
import { useSpeechCaptureSettings } from "../hooks/useSpeechCaptureSettings";
import type { SpeechMethodId } from "../lib/speechProviders/methods";
import type { SpeechSmartTurnSettings } from "../lib/speechProviders/SpeechProvider";

interface SpeechControlMenuProps {
  trigger: ReactNode;
  showMethodSelector: boolean;
  methodOptions: FilterOption<SpeechMethodId>[];
  selectedMethod: SpeechMethodId;
  onMethodChange: (selected: string[]) => void;
  smartTurnSettings?: SpeechSmartTurnSettings;
  onSmartTurnSettingsChange?: (settings: SpeechSmartTurnSettings) => void;
  smartTurnDisabled?: boolean;
  onPointerNearTrigger?: () => void;
}

const LONG_PRESS_MS = 500;
const POINTER_NEAR_MARGIN_PX = 32;

function getMediaDevices(): MediaDevices | null {
  return typeof navigator !== "undefined" ? navigator.mediaDevices : null;
}

function audioInputLabel(device: MediaDeviceInfo, index: number): string {
  return device.label || `Microphone ${index + 1}`;
}

export function SpeechControlMenu({
  trigger,
  showMethodSelector,
  methodOptions,
  selectedMethod,
  onMethodChange,
  smartTurnSettings,
  onSmartTurnSettingsChange,
  smartTurnDisabled = false,
  onPointerNearTrigger,
}: SpeechControlMenuProps) {
  const micDeviceSelectId = useId();
  const { micDeviceId, setMicDeviceId } = useSpeechCaptureSettings();
  const [open, setOpen] = useState(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceError, setMicDeviceError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressOpenedRef = useRef(false);
  const pointerNearRef = useRef(false);
  const selectedMethodLabel = useMemo(
    () =>
      methodOptions.find((option) => option.value === selectedMethod)?.label ??
      selectedMethod,
    [methodOptions, selectedMethod],
  );
  const showSmartTurnControls =
    !!smartTurnSettings && !!onSmartTurnSettingsChange;
  const showMicDeviceControls = selectedMethod !== "browser-native";
  const hasOptions =
    showMethodSelector ||
    showMicDeviceControls ||
    showSmartTurnControls;
  const selectedMicDeviceUnavailable =
    !!micDeviceId &&
    !micDevices.some((device) => device.deviceId === micDeviceId);

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

  const refreshMicDevices = useCallback(async () => {
    const mediaDevices = getMediaDevices();
    if (typeof mediaDevices?.enumerateDevices !== "function") {
      setMicDevices([]);
      setMicDeviceError("Microphone list unavailable");
      return;
    }

    try {
      const devices = await mediaDevices.enumerateDevices();
      setMicDevices(
        devices.filter(
          (device) => device.kind === "audioinput" && device.deviceId,
        ),
      );
      setMicDeviceError(null);
    } catch {
      setMicDevices([]);
      setMicDeviceError("Microphone list unavailable");
    }
  }, []);

  useEffect(() => {
    if (!open || !showMicDeviceControls) return;
    void refreshMicDevices();

    const mediaDevices = getMediaDevices();
    if (typeof mediaDevices?.addEventListener !== "function") return;
    mediaDevices.addEventListener("devicechange", refreshMicDevices);
    return () =>
      mediaDevices.removeEventListener?.("devicechange", refreshMicDevices);
  }, [open, refreshMicDevices, showMicDeviceControls]);

  useEffect(() => {
    if (!onPointerNearTrigger) return;

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      if (event.pointerType && event.pointerType !== "mouse") return;
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const near =
        event.clientX >= rect.left - POINTER_NEAR_MARGIN_PX &&
        event.clientX <= rect.right + POINTER_NEAR_MARGIN_PX &&
        event.clientY >= rect.top - POINTER_NEAR_MARGIN_PX &&
        event.clientY <= rect.bottom + POINTER_NEAR_MARGIN_PX;
      if (!near) {
        pointerNearRef.current = false;
        return;
      }
      if (pointerNearRef.current) return;
      pointerNearRef.current = true;
      onPointerNearTrigger();
    };

    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [onPointerNearTrigger]);

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
          {showSmartTurnControls && (
            <section className="speech-options-section">
              <SpeechSmartTurnControls
                settings={smartTurnSettings}
                onChange={onSmartTurnSettingsChange}
                disabled={smartTurnDisabled}
              />
            </section>
          )}
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
                          <span
                            className="speech-method-description"
                            title={option.description}
                          >
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
          {showMicDeviceControls && (
            <section className="speech-options-section">
              <label
                className="speech-options-section-title"
                htmlFor={micDeviceSelectId}
              >
                Microphone
              </label>
              <select
                id={micDeviceSelectId}
                className="speech-mic-device-select"
                value={micDeviceId ?? ""}
                onChange={(event) =>
                  setMicDeviceId(event.currentTarget.value || null)
                }
                onFocus={() => void refreshMicDevices()}
              >
                <option value="">System default</option>
                {selectedMicDeviceUnavailable && micDeviceId && (
                  <option value={micDeviceId}>
                    Selected microphone unavailable
                  </option>
                )}
                {micDevices.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {audioInputLabel(device, index)}
                  </option>
                ))}
              </select>
              {micDeviceError && (
                <div className="speech-mic-device-error">{micDeviceError}</div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
