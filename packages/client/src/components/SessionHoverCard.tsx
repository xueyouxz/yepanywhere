import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderName } from "@yep-anywhere/shared";
import type { AgentActivity } from "../hooks/useFileActivity";
import type { PendingInputType, SessionStatus } from "../types";
import { DEFAULT_HOVERCARD_MAX_HEIGHT_PX } from "../hooks/useHoverCardAppearance";
import { parseCommandTurn } from "../lib/commandTurn";
import { estimateHoverCardPromptLines } from "./sessionHoverCardLines";
import { ProviderBadge } from "./ProviderBadge";
import { SessionStatusBadge } from "./StatusBadge";

const GAP_PX = 4;
const MARGIN_PX = 8;
const CURSOR_OFFSET_PX = 14;

interface SessionHoverCardProps {
  /** Stable id used by the owning row to recognize pointer transfers. */
  hoverCardId: string;
  /** Viewport-fixed row geometry + cursor x; the card picks below/above. */
  anchor: { rowTop: number; rowBottom: number; cursorX: number };
  /** The full first user turn, shown turn-styled and line-clamped to fit. */
  prompt: string;
  /**
   * Capped excerpt of the most recent regular agent turn (already trimmed to
   * its last lines server-side; "⚙ <tool>" when the latest turns are
   * tool-only). Rendered as a reply block below the meta row; omitted when
   * absent.
   */
  lastAgentText?: string;
  provider: ProviderName;
  model?: string;
  projectName?: string;
  /** Preformatted age line, e.g. "5m ago (est. 2d)"; omitted when null. */
  ageLabel: string | null;
  /** Called when the pointer leaves the card after selecting/reading it. */
  onMouseLeave?: () => void;
  status?: SessionStatus;
  pendingInputType?: PendingInputType;
  hasUnread?: boolean;
  activity?: AgentActivity;
  /**
   * Card max height in px, from the hover-card appearance setting. The single
   * source for the cap — applied via the inline `maxHeight` style below, so CSS
   * must not also set max-height.
   */
  maxHeightPx?: number;
}

interface Placement {
  top: number;
  left: number;
  maxHeight: number;
  /** Neither direction fully fits — widen so fewer lines are clipped. */
  loosened: boolean;
}

/**
 * Hover card for compact sidebar rows: the full first user turn at hover-card
 * size, line-clamped to the room in whichever direction fits, plus a
 * status line (provider+model badge, project, age, status). Portaled + fixed
 * so it never clips in the scrolling sidebar. It remains pointer-selectable so
 * copied text comes from the visible card, not from page content behind it.
 * Prefers below the row + right of the cursor, flipping above when the content
 * is too tall to fit below.
 */
export function SessionHoverCard({
  hoverCardId,
  anchor,
  prompt,
  lastAgentText,
  provider,
  model,
  projectName,
  ageLabel,
  onMouseLeave,
  status,
  pendingInputType,
  hasUnread,
  activity,
  maxHeightPx = DEFAULT_HOVERCARD_MAX_HEIGHT_PX,
}: SessionHoverCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // Measure the unclamped content (rendered hidden), then choose a placement
  // before paint. useLayoutEffect runs synchronously pre-paint, so no flicker.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { rowTop, rowBottom, cursorX } = anchor;
    const naturalHeight = el.scrollHeight;
    const width = el.offsetWidth;
    const spaceBelow = Math.max(
      0,
      window.innerHeight - rowBottom - GAP_PX - MARGIN_PX,
    );
    const spaceAbove = Math.max(0, rowTop - GAP_PX - MARGIN_PX);
    const targetHeight = Math.min(naturalHeight, maxHeightPx);
    const spaceBelowCapped = Math.min(spaceBelow, maxHeightPx);
    const spaceAboveCapped = Math.min(spaceAbove, maxHeightPx);

    let below: boolean;
    let maxHeight: number;
    let loosened = false;
    if (targetHeight <= spaceBelowCapped) {
      below = true;
      maxHeight = spaceBelowCapped;
    } else if (targetHeight <= spaceAboveCapped) {
      below = false;
      maxHeight = spaceAboveCapped;
    } else {
      below = spaceBelow >= spaceAbove;
      maxHeight = Math.min(Math.max(spaceBelow, spaceAbove), maxHeightPx);
      loosened = true;
    }

    const usedHeight = Math.min(naturalHeight, maxHeight);
    const top = below ? rowBottom + GAP_PX : rowTop - GAP_PX - usedHeight;
    const left = Math.min(
      Math.max(cursorX + CURSOR_OFFSET_PX, MARGIN_PX),
      window.innerWidth - width - MARGIN_PX,
    );
    setPlacement({ top: Math.max(MARGIN_PX, top), left, maxHeight, loosened });
  }, [
    anchor,
    prompt,
    lastAgentText,
    model,
    projectName,
    ageLabel,
    status,
    maxHeightPx,
  ]);

  const maxLines = placement
    ? estimateHoverCardPromptLines(placement.maxHeight, !!lastAgentText)
    : undefined;

  // Slash-command turns arrive wrapped in <command-name>…</command-name> tags;
  // show the command itself rather than the raw markup.
  const command = prompt ? parseCommandTurn(prompt) : null;

  return createPortal(
    <div
      ref={ref}
      data-session-hovercard-id={hoverCardId}
      className={`session-hovercard${
        placement?.loosened ? " session-hovercard--wide" : ""
      }`}
      onMouseLeave={onMouseLeave}
      style={
        placement
          ? {
              top: placement.top,
              left: placement.left,
              maxHeight: placement.maxHeight,
            }
          : { top: 0, left: 0, visibility: "hidden" }
      }
      role="tooltip"
    >
      {prompt && (
        <div
          className="session-hovercard__turn"
          style={maxLines ? { WebkitLineClamp: maxLines } : undefined}
        >
          {command ? (
            <span className="session-hovercard__command">
              {command.command}
              {command.args ? ` ${command.args}` : ""}
            </span>
          ) : (
            prompt
          )}
        </div>
      )}
      <div className="session-hovercard__meta">
        <ProviderBadge provider={provider} model={model} />
        {projectName && (
          <span className="session-hovercard__project">{projectName}</span>
        )}
        {ageLabel && <span className="session-hovercard__age">{ageLabel}</span>}
        {status && (
          <SessionStatusBadge
            status={status}
            pendingInputType={pendingInputType}
            hasUnread={hasUnread}
            activity={activity}
          />
        )}
      </div>
      {lastAgentText && (
        <div className="session-hovercard__reply">
          <span className="session-hovercard__reply-marker" aria-hidden="true">
            ↳
          </span>
          <span className="session-hovercard__reply-text">{lastAgentText}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
