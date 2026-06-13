import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { getSlashCommandMenuParts } from "../lib/slashCommands";

interface SlashCommandButtonProps {
  /** Available slash commands (without the "/" prefix) */
  commands: string[];
  /** Callback when a command is selected */
  onSelectCommand: (command: string) => void;
  /** Whether the button should be disabled */
  disabled?: boolean;
}

/**
 * Button that shows available slash commands in a dropdown menu.
 * Selecting a command inserts "/{command}" into the message input.
 */
export function SlashCommandButton({
  commands,
  onSelectCommand,
  disabled,
}: SlashCommandButtonProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{
    bottom: number;
    left: number;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close menu on Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Close on resize so stale position doesn't persist
  useEffect(() => {
    if (!isOpen) return;
    const handleResize = () => setIsOpen(false);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isOpen]);

  const handleToggle = useCallback(() => {
    if (!isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPos({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
      });
    }
    setIsOpen((prev) => !prev);
  }, [isOpen]);

  const handleCommandClick = useCallback(
    (command: string) => {
      onSelectCommand(`/${command}`);
      setIsOpen(false);
    },
    [onSelectCommand],
  );

  // Don't render if no commands available
  if (commands.length === 0) {
    return null;
  }

  return (
    <div className="slash-command-container">
      <button
        ref={buttonRef}
        type="button"
        className={`slash-command-button ${isOpen ? "active" : ""}`}
        onClick={handleToggle}
        disabled={disabled}
        title={t("slashCommandsLabel")}
        aria-label={t("slashCommandsShow")}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <span className="slash-icon">/</span>
      </button>
      {isOpen &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className="slash-command-menu"
            style={{
              position: "fixed",
              bottom: menuPos.bottom,
              left: menuPos.left,
            }}
            role="menu"
            aria-label={t("slashCommandsLabel")}
          >
            {commands.map((command) => (
              <SlashCommandMenuItem
                key={command}
                command={command}
                onSelect={handleCommandClick}
              />
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

function SlashCommandMenuItem({
  command,
  onSelect,
}: {
  command: string;
  onSelect: (command: string) => void;
}) {
  const parts = getSlashCommandMenuParts(command);
  return (
    <button
      type="button"
      className="slash-command-item"
      onClick={() => onSelect(command)}
      role="menuitem"
      aria-label={parts.label}
    >
      {parts.shortcut && (
        <strong className="slash-command-shortcut">{parts.shortcut}</strong>
      )}
      <span>{parts.rest}</span>
    </button>
  );
}
