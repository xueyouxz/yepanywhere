import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../i18n";
import type { PermissionMode } from "../types";

const MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

interface ModeSelectorProps {
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  disabled?: boolean;
  /** Whether permission mode changes are deferred until the next user turn. */
  changesApplyNextTurn?: boolean;
  /** Whether the session is currently held (soft pause) */
  isHeld?: boolean;
  /** Callback when hold state changes */
  onHoldChange?: (held: boolean) => void;
}

/**
 * Mode selector button that opens an anchored dropdown above the button.
 * Includes hold (soft pause) as a special first option.
 * Clicking outside the popup or selecting a mode closes it.
 */
export function ModeSelector({
  mode,
  onModeChange,
  disabled,
  changesApplyNextTurn = false,
  isHeld = false,
  onHoldChange,
}: ModeSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const handleButtonClick = () => {
    if (!disabled) {
      // Blur button to remove focus ring before sheet appears
      buttonRef.current?.blur();
      setIsOpen(true);
    }
  };

  const handleModeSelect = (
    selectedMode: PermissionMode,
    e?: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    e?.preventDefault();
    e?.stopPropagation();
    // If held, resume first
    if (isHeld && onHoldChange) {
      onHoldChange(false);
    }
    onModeChange(selectedMode);
    setIsOpen(false);
  };

  const handleHoldToggle = (e?: ReactMouseEvent<HTMLButtonElement>) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (onHoldChange) {
      onHoldChange(!isHeld);
    }
    setIsOpen(false);
  };

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, handleClose]);

  // Close on click outside.
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        sheetRef.current &&
        !sheetRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        handleClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, handleClose]);

  // Focus the sheet when opened for accessibility
  useEffect(() => {
    if (isOpen) {
      sheetRef.current?.focus();
    }
  }, [isOpen]);

  const modeLabels: Record<PermissionMode, string> = {
    default: t("modeDefaultLabel" as never),
    acceptEdits: t("modeAcceptEditsLabel" as never),
    plan: t("modePlanLabel" as never),
    bypassPermissions: t("modeBypassPermissionsLabel" as never),
  };

  // Display text: show "Hold" when held, otherwise show mode label
  const displayLabel = isHeld ? t("modeHold" as never) : modeLabels[mode];
  const displayDotClass = isHeld ? "mode-hold" : `mode-${mode}`;
  const buttonTitle = changesApplyNextTurn
    ? `${t("modeClickToSelect" as never)} - ${t("modeNextTurnHint" as never)}`
    : t("modeClickToSelect" as never);

  // Shared dropdown options content
  const optionsContent = (
    <>
      {/* Hold option - special first item */}
      {onHoldChange && (
        <button
          type="button"
          className={`mode-selector-option ${isHeld ? "selected" : ""}`}
          onClick={(e) => handleHoldToggle(e)}
          aria-pressed={isHeld}
        >
          <span className="mode-dot mode-hold" />
          <span className="mode-selector-label">
            {isHeld ? t("modeResume" as never) : t("modeHold" as never)}
          </span>
          <span className="mode-selector-description">
            {isHeld
              ? t("modeContinueExecution" as never)
              : t("modePauseExecution" as never)}
          </span>
          {isHeld && (
            <span className="mode-selector-check" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          )}
        </button>
      )}

      {/* Divider between hold and permission modes */}
      {onHoldChange && <div className="mode-selector-divider" />}

      {changesApplyNextTurn && (
        <div className="mode-selector-timing-note" role="status">
          {t("modeNextTurnHint" as never)}
        </div>
      )}

      {/* Permission mode options */}
      {MODE_ORDER.map((m) => (
        <button
          key={m}
          type="button"
          className={`mode-selector-option ${!isHeld && mode === m ? "selected" : ""}`}
          onClick={(e) => handleModeSelect(m, e)}
          aria-pressed={!isHeld && mode === m}
        >
          <span className={`mode-dot mode-${m}`} />
          <span className="mode-selector-label">{modeLabels[m]}</span>
          {!isHeld && mode === m && (
            <span className="mode-selector-check" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          )}
        </button>
      ))}
    </>
  );

  const dropdown =
    isOpen ? (
      <div
        ref={sheetRef}
        className="mode-selector-dropdown"
        tabIndex={-1}
        aria-label={t("modeSelectLabel" as never)}
      >
        <div className="mode-selector-options">{optionsContent}</div>
      </div>
    ) : null;

  return (
    <div className="mode-selector-container">
      <button
        ref={buttonRef}
        type="button"
        className={`mode-button ${isHeld ? "mode-button-held" : ""} ${
          changesApplyNextTurn ? "mode-button-next-turn" : ""
        }`}
        onClick={handleButtonClick}
        disabled={disabled}
        title={buttonTitle}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={`mode-dot ${displayDotClass}`} />
        <span className="mode-button-label">{displayLabel}</span>
        {changesApplyNextTurn && (
          <span className="mode-button-badge">
            {t("modeNextTurnBadge" as never)}
          </span>
        )}
      </button>
      {dropdown}
    </div>
  );
}
