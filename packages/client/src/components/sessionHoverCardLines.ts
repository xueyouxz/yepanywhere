// Approximate per-line layout reserves for estimating how many opening-request
// lines fit in a hover card of a given available height. These mirror the
// card's CSS padding/gap/line-height; they are deliberately approximate (the
// card sizes its clamp in a single measure pass — a second per-child DOM
// measure would add a reflow and yields nothing under jsdom). The Appearance
// height preview and the card itself share this estimate so they cannot drift.
// Retune if the card's CSS changes.
const LINE_HEIGHT_PX = 19;
const META_RESERVE_PX = 34;
const PADDING_RESERVE_PX = 20;
// Held back for the reply block (its line + divider/padding); only reserved when
// a reply is present, so the no-reply case is unaffected.
const REPLY_RESERVE_PX = 38;

/**
 * Estimate how many opening-request lines the card shows at availableHeightPx.
 * hasReply reserves room for the most-recent-agent-turn block below the
 * request. Bounded only by the available height (always at least 1) — there is
 * no fixed line cap, so a taller card shows a proportionally longer request.
 */
export function estimateHoverCardPromptLines(
  availableHeightPx: number,
  hasReply: boolean,
): number {
  return Math.max(
    1,
    Math.floor(
      (availableHeightPx -
        META_RESERVE_PX -
        PADDING_RESERVE_PX -
        (hasReply ? REPLY_RESERVE_PX : 0)) /
        LINE_HEIGHT_PX,
    ),
  );
}
