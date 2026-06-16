import { useCallback, useEffect, useRef, useState } from "react";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import type { ContextUsage } from "../types";
import { ContextUsageIndicator } from "./ContextUsageIndicator";

interface ContextThresholdQuickEditProps {
  usage?: ContextUsage;
  /** Session model id — the slider/migration key (e.g. "opus"). */
  model?: string;
  /** Model context window, for the token preview. */
  contextWindow?: number;
  size?: number;
}

const LONG_PRESS_MS = 450;

/**
 * Wraps the context-usage indicator with a long-press (touch) / right-click
 * (desktop) affordance that opens a one-control popover for *this model's*
 * "compact context early" threshold — a quick way to dial in (or off) the
 * preemptive-compaction point without opening Settings. It edits the SAME
 * `clientDefaults.compactAtContextPercent` map the Model Settings slider does
 * (a second access point, not a second mechanism). See task 029 /
 * topics/resume-compaction.md.
 */
export function ContextThresholdQuickEdit({
  usage,
  model,
  contextWindow,
  size = 16,
}: ContextThresholdQuickEditProps) {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canEdit = !!usage && !!model && model !== "default";
  const stored =
    (model
      ? settings?.clientDefaults?.compactAtContextPercent?.[model]
      : undefined) ?? 0;
  const [draft, setDraft] = useState(stored);
  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  const commit = useCallback(
    (pct: number) => {
      if (!model) return;
      const next: Record<string, number> = {
        ...settings?.clientDefaults?.compactAtContextPercent,
      };
      if (pct > 0 && pct < 100) next[model] = Math.round(pct);
      else delete next[model];
      void updateSetting("clientDefaults", {
        compactAtContextPercent: next,
      }).catch(() => {
        // surfaced via the hook's error state
      });
    },
    [model, settings?.clientDefaults?.compactAtContextPercent, updateSetting],
  );

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!usage) return null;

  const tokenPreview =
    contextWindow && draft > 0
      ? `${Math.round((contextWindow * draft) / 100 / 1024)}K`
      : null;

  // No editable model → just the plain indicator, no interaction wrapper.
  if (!canEdit) {
    return <ContextUsageIndicator usage={usage} size={size} />;
  }

  return (
    <span
      ref={wrapRef}
      className="context-threshold-quickedit"
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={t("compactThresholdQuickTitle")}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen((o) => !o);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setOpen((o) => !o);
      }}
      onTouchStart={() => {
        clearLongPress();
        longPressTimer.current = setTimeout(() => {
          longPressTimer.current = null;
          setOpen(true);
        }, LONG_PRESS_MS);
      }}
      onTouchEnd={clearLongPress}
      onTouchMove={clearLongPress}
    >
      <ContextUsageIndicator usage={usage} size={size} />
      {open && (
        <div className="context-threshold-popover" role="dialog">
          <div className="context-threshold-popover-title">
            {t("compactThresholdQuickTitle")}
          </div>
          <input
            type="range"
            min={0}
            max={99}
            step={1}
            value={draft}
            aria-label={t("compactThresholdQuickTitle")}
            onChange={(e) => setDraft(Number(e.target.value))}
            onPointerUp={() => commit(draft)}
            onKeyUp={() => commit(draft)}
          />
          <div className="context-threshold-popover-hint">
            {draft > 0
              ? t("compactThresholdQuickOn", {
                  percent: String(draft),
                  tokens: tokenPreview ?? "—",
                })
              : t("compactThresholdQuickOff")}
          </div>
        </div>
      )}
    </span>
  );
}
