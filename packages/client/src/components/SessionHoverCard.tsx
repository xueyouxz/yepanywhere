import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderName } from "@yep-anywhere/shared";
import type { AgentActivity } from "../hooks/useFileActivity";
import type { PendingInputType, SessionStatus } from "../types";
import { ProviderBadge } from "./ProviderBadge";
import { SessionStatusBadge } from "./StatusBadge";

// Rough metrics for sizing the line clamp to available space in a single
// measure pass (we read scrollHeight once; see useLayoutEffect below). These
// are deliberately approximate sums of the CSS padding/gap/line-height, not
// per-child DOM measurements: a second measure pass would add a reflow and
// yields nothing under jsdom (no layout). Retune if the card's CSS changes.
const LINE_HEIGHT_PX = 19;
const META_RESERVE_PX = 34;
const PADDING_RESERVE_PX = 20;
// Room held back from the opening-request clamp for the reply block (its lines
// + divider/padding) so the most recent agent turn stays visible instead of the
// request greedily eating the card. Only reserved when a reply is present, so
// the no-reply case renders exactly as before.
const REPLY_RESERVE_PX = 38;
// Single source of truth for the card's max height: applied via the inline
// `maxHeight` style below, so CSS must not also set max-height (it would
// duplicate this). This is the value the Appearance "max height" control drives.
const MAX_CARD_HEIGHT_PX = 112;
const MAX_PROMPT_LINES = 3;
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
 * Hover card for compact sidebar rows: the full first user turn at hover-card
 * size, line-clamped to the room in whichever direction fits, plus a
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
    const spaceBelow = Math.max(
      0,
      window.innerHeight - rowBottom - GAP_PX - MARGIN_PX,
    );
    const spaceAbove = Math.max(0, rowTop - GAP_PX - MARGIN_PX);
    const targetHeight = Math.min(naturalHeight, MAX_CARD_HEIGHT_PX);
    const spaceBelowCapped = Math.min(spaceBelow, MAX_CARD_HEIGHT_PX);
    const spaceAboveCapped = Math.min(spaceAbove, MAX_CARD_HEIGHT_PX);

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
      maxHeight = Math.min(
        Math.max(spaceBelow, spaceAbove),
        MAX_CARD_HEIGHT_PX,
      );
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
    ? Math.min(
        MAX_PROMPT_LINES,
        Math.max(
          1,
          Math.floor(
            (placement.maxHeight -
              META_RESERVE_PX -
              PADDING_RESERVE_PX -
              (lastAgentText ? REPLY_RESERVE_PX : 0)) /
              LINE_HEIGHT_PX,
          ),
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
