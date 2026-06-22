import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderName } from "@yep-anywhere/shared";
import type { AgentActivity } from "../hooks/useFileActivity";
import type { PendingInputType, SessionStatus } from "../types";
import { ProviderBadge } from "./ProviderBadge";
import { SessionStatusBadge } from "./StatusBadge";

// Rough metrics for sizing the line clamp to available space without a second
// measure pass: a font-size-sm line, plus the always-shown meta row (which may
// wrap) and panel padding/gap.
const LINE_HEIGHT_PX = 19;
const META_RESERVE_PX = 48;
const PADDING_RESERVE_PX = 24;
// Room held back from the opening-request clamp for the reply block (its lines
// + divider/padding) so the most recent agent turn stays visible instead of the
// request greedily eating the card. Only reserved when a reply is present, so
// the no-reply case renders exactly as before.
const REPLY_RESERVE_PX = 84;
const GAP_PX = 4;
const MARGIN_PX = 8;
const CURSOR_OFFSET_PX = 14;

interface SessionHoverCardProps {
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
  status?: SessionStatus;
  pendingInputType?: PendingInputType;
  hasUnread?: boolean;
  activity?: AgentActivity;
}

interface Placement {
  top: number;
  left: number;
  maxHeight: number;
  /** Neither direction fully fits — widen so fewer lines are clipped. */
  loosened: boolean;
}

/**
 * Replacement tooltip for compact sidebar rows: the full first user turn at
 * tooltip size, line-clamped to the room in whichever direction fits, plus a
 * status line (provider+model badge, project, age, status). Portaled + fixed
 * and pointer-events:none so it never clips in the scrolling sidebar nor blocks
 * the row's menu trigger. Prefers below the row + right of the cursor, flipping
 * above when the content is too tall to fit below.
 */
export function SessionHoverCard({
  anchor,
  prompt,
  lastAgentText,
  provider,
  model,
  projectName,
  ageLabel,
  status,
  pendingInputType,
  hasUnread,
  activity,
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
    const spaceBelow = window.innerHeight - rowBottom - GAP_PX - MARGIN_PX;
    const spaceAbove = rowTop - GAP_PX - MARGIN_PX;

    let below: boolean;
    let maxHeight: number;
    let loosened = false;
    if (naturalHeight <= spaceBelow) {
      below = true;
      maxHeight = spaceBelow;
    } else if (naturalHeight <= spaceAbove) {
      below = false;
      maxHeight = spaceAbove;
    } else {
      below = spaceBelow >= spaceAbove;
      maxHeight = Math.max(spaceBelow, spaceAbove);
      loosened = true;
    }

    const usedHeight = Math.min(naturalHeight, maxHeight);
    const top = below ? rowBottom + GAP_PX : rowTop - GAP_PX - usedHeight;
    const left = Math.min(
      Math.max(cursorX + CURSOR_OFFSET_PX, MARGIN_PX),
      window.innerWidth - width - MARGIN_PX,
    );
    setPlacement({ top: Math.max(MARGIN_PX, top), left, maxHeight, loosened });
  }, [anchor, prompt, lastAgentText, model, projectName, ageLabel, status]);

  const maxLines = placement
    ? Math.max(
        1,
        Math.floor(
          (placement.maxHeight -
            META_RESERVE_PX -
            PADDING_RESERVE_PX -
            (lastAgentText ? REPLY_RESERVE_PX : 0)) /
            LINE_HEIGHT_PX,
        ),
      )
    : undefined;

  return createPortal(
    <div
      ref={ref}
      className={`session-hovercard${
        placement?.loosened ? " session-hovercard--wide" : ""
      }`}
      style={
        placement
          ? {
              top: placement.top,
              left: placement.left,
              maxHeight: placement.maxHeight,
            }
          : { top: 0, left: 0, visibility: "hidden" }
      }
      role="presentation"
    >
      {prompt && (
        <div
          className="session-hovercard__turn"
          style={maxLines ? { WebkitLineClamp: maxLines } : undefined}
        >
          {prompt}
        </div>
      )}
      <div className="session-hovercard__meta">
        <ProviderBadge provider={provider} model={model} />
        {projectName && (
          <span className="session-hovercard__project">{projectName}</span>
        )}
        {ageLabel && (
          <span className="session-hovercard__age">{ageLabel}</span>
        )}
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
