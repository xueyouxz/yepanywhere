# Session Hover Card: Recent Activity

> The session hover card (the tooltip-like pane that replaces the row's
> `title=` tooltip) shows the **opening user request** today. This adds the
> **most recent regular agent turn** as a second excerpt so a glance answers
> "where did this land?", and fires the same card on the all-sessions page
> and its search box — not just the sidebar. Records the content/layout/data
> proposals considered and the choices currently opted into.

Topic: session-hovercard-recent-activity

See also:
[ui-architecture](ui-architecture.md) (share the card and its data at the
render boundary; one component, all surfaces),
[sidebar-session-ordering](sidebar-session-ordering.md) (the rows this card
annotates),
[session-liveness](session-liveness.md) (`activity` = `in-turn` /
`waiting-input`, which gates the phase-2 live tail),
[provider-abstraction](provider-abstraction.md) (per-provider readers must each
populate the new snippet; absence degrades gracefully),
[recaps](recaps.md) (the away-summary that overrides the excerpt when it is the
freshest agent line).

## Goal

Hovering a session row should let the supervisor read, without opening the
session, both ends of the conversation:

- **What it's about** — the opening user request (already shown).
- **Where it is now** — the most recent regular agent turn (new).

"Regular agent turn" = the last assistant message with visible prose. Skip
pure tool-call turns, thinking-only turns, and `<synthetic>` error turns; if
the latest turn *ends* on a tool call with no trailing prose, fall back to the
prior text block or a short tool label (see Content below).

## What exists today

- **The pane** — `packages/client/src/components/SessionHoverCard.tsx`.
  Portaled, `position: fixed`, `pointer-events: none`, self-positioning from
  the row geometry + cursor x (below the row / right of cursor, flipping above
  when it would not fit). A column flexbox:
  - `.session-hovercard__turn` — the opening request, styled like a user
    message, `white-space: pre-wrap`, line-clamped via an inline
    `-webkit-line-clamp` (`maxLines`) computed from available vertical space.
  - `.session-hovercard__meta` — a `flex-wrap` row of chips: provider+model
    badge, project, age (`5m ago (est. 2d)`), status badge.
- **Width** — `.session-hovercard { width: max-content; max-width: min(700px,
  92vw) }`, and `.session-hovercard--wide { max-width: min(880px, 96vw) }` when
  neither below nor above fits and the card trades reading width for fewer
  lines (`placement.loosened`). CSS at `packages/client/src/styles/index.css`
  ~13309. **Consequence that drives the layout below:** the card already sizes
  to its widest child's longest line, i.e. the opening request sets the width;
  any second block wraps within that same width for free.
- **Body source** — `SessionListItem.tsx`:
  `hoverPrompt = (initialPrompt || fullTitle || displayTitle || "").trim()`
  (the *first* user turn). No agent-turn text reaches the client today.
- **Firing surface** — gated to the sidebar only:
  `showCompactPreview = mode === "compact" && !!provider`
  (`SessionListItem.tsx:398`). The all-sessions page
  (`GlobalSessionsPage.tsx:977,1051`) renders `mode="card"`, so the card is
  off there; its search box filters the same rows, so "all-sessions + search"
  is one surface.
- **Data cost is near-zero server-side.** `reader.ts:getSessionSummaryFromDir`
  already reads the whole jsonl, builds the DAG, and holds the active-branch
  `conversationMessages` in memory; it already scans assistant messages
  backwards for model (`extractModel`) and context usage (`extractContextUsage`).
  A backward scan for the last regular agent text is a sibling of those,
  cached in the session index alongside `fullTitle`.

## Decisions (currently opted)

| Dimension | Opted choice |
|---|---|
| Content | **Last ~3 lines** of the last regular agent turn, light-stripped; **tool-call fallback** label when the turn ends with no trailing prose. |
| Source | **Persisted assistant→user text excerpt** from the session index. Not the live thinking/tool tail (that is phase 2). |
| Layout slot | A dedicated block **below the badge/meta line** (`__turn` → `__meta` → `__reply`). Deliberate "nice separation"; slightly unconventional vs. putting it directly under the request. |
| Width | **Same treatment as the request.** The card is `max-content`; the request already forces the width, the reply wraps in it. `--wide` (880px) applies to both. No special narrowing, no one-line-beside-badges. |
| Vertical budget | **Equal small caps**, not greedy. Cap the now-greedy opening body (≈4–5 lines) and clamp the reply (≈3 lines); the reply must not exceed the opening request's allocation. |
| Surfaces | Sidebar (compact) already fires. **Also fire in card mode** so all-sessions + search get it. |
| Providers | **Excerpt is provider-independent** via the on-demand refresh (normalized `Message[]`). Claude additionally populates it in the cheap summary/live path; other providers populate on focus/hover. Recaps stay Claude-only. |
| Freshness | **Rides the existing live `session-updated` event** (same channel that already updates title/messageCount/contextUsage), not a mouseover-repoll. |

## Proposals considered

### Content version (what text)

1. **Last N lines of the last agent turn** — *opted*. Agents put the
   actionable payload ("Done X — want me to Y?") at the *end*, so last-N beats
   first-N for "where did this land?". ~3 lines.
2. First N lines — never dangles at the top, but usually catches preamble /
   task-restatement; less informative for agent turns.
3. Head + tail elision — first line · `…` · last 2 lines; captures topic +
   conclusion for long turns, slightly more logic.
4. **Trailing-question / tool-aware** — prefer the final paragraph/question;
   if the turn ends on a tool call (still working), fall back to the prior text
   block or a label (`⚙ editing reader.ts`). *Folded into the opted choice as
   the fallback*, since the data is right there and it covers the
   "mid-task, no closing prose" case the others render blank.
5. Last exchange (last user line + last agent N lines) — shows start→now in one
   block; rejected as redundant with the opening-request body the card already
   carries.

### Source (where the text comes from)

- **Persisted excerpt from the index** — *opted*. Free (already parsed),
  cached, available offline in the list. Answers "what did it tell me",
  correct for idle/done sessions.
- **Live bottom-of-session tail** (recent thinking, `Running Bash…`, streaming
  partial) — *phase 2*. Answers "what's it doing right now", correct for
  running sessions, but **not in the list data**: `GlobalSessionItem` carries
  only `activity`/`status`/`pendingInputType`, no live text. Mirroring the
  session view means streaming a running process's tail into the hover (new
  plumbing) plus honoring the thinking-display gate. The existing status badge
  already covers "running / awaiting input" for v1.

### Layout slot (where the block sits)

- **Below the badge line** (`__turn` → `__meta` → `__reply`) — *opted*. Clean
  separation between "the request + its metadata" and "the latest reply".
  Slightly unconventional (recent content usually sits adjacent to the title),
  judged defensible for the separation it buys.
- Between request and badges (`__turn` → `__reply` → `__meta`) — conventional
  "reply under the prompt" reading order; rejected for weaker separation.
- Inline, one line to the right of the badges (next to `(est Xh)`) — rejected:
  prose in the `flex-wrap` chip row wraps among badges, and a single ellipsised
  line throws away the multi-line payload. (Width is *not* the objection — see
  below — placement among chips is.)

### Width

- **Same as the request** — *opted*. Card is `max-content`, so the opening
  request already drives card width; the reply is another column child and
  wraps within that width at no cost. `pre-wrap` + the existing `--wide`
  loosening apply to both blocks uniformly.

### Vertical budget

- **Equal small caps** — *opted*. Today `__turn` greedily consumes available
  height (`maxLines` from space). Split the budget: cap the opening body
  (≈4–5 lines) and clamp the reply (≈3 lines), remainder unused so the tooltip
  does not grow tall. The recent block must not exceed the opening request's
  allocation. The actual change is *capping the now-greedy opening body* — that
  is what currently starves a second block.

## Implementation sketch (v1)

Server:

- Add `lastAgentText?: string` to `SessionSummary`
  (`packages/server/src/supervisor/types.ts:69`), populated in
  `reader.ts:getSessionSummaryFromDir` by a backward scan over
  `conversationMessages` for the last assistant message with prose (sibling of
  `extractModel`). **Cap at the server** (~500 chars / ~6 lines) so the index
  stays small and content is fixed; the client clamps further. Cached by the
  session index (mtime/size) like `fullTitle`.
- Thread it into `GlobalSessionItem` on both sides
  (`packages/server/src/routes/global-sessions.ts:68` and the
  `allSessions.push` at ~424; client mirror at
  `packages/client/src/api/client.ts:86`, plus the WS-event builder in
  `packages/client/src/hooks/useGlobalSessions.ts`).
- Other providers' readers (`codex-reader`, `gemini-reader`, `opencode-reader`,
  `grok-reader`) populate it as they're touched; absent → no reply line.

Client:

- Pass `lastAgentText` from `SessionListItem` to `SessionHoverCard` as a new
  optional prop; render `.session-hovercard__reply` below `__meta`.
- Apply the tool-call fallback (label the trailing tool when no trailing prose).
- Split the line budget between `__turn` and `__reply`.
- Drop the `mode === "compact"` gate on `showCompactPreview` (or widen it to
  card mode) so all-sessions + search rows fire the card.

## Freshness: how the excerpt stays current

The list is **not** poll-on-visible. `useGlobalSessions` fetches once on mount
(and on filter change / WS reconnect via `onReconnect: fetch`), then YA keeps it
live through pushed events from `useFileActivity`: `session-status`,
`process-state`, `session-created`, `session-metadata-changed`, `session-seen`,
and `session-updated`. The last already updates `title` / `messageCount` /
`updatedAt` / `contextUsage` / `model` in place.

`lastAgentText` is therefore wired onto that **same live channel** rather than a
bespoke refresh:

- Server builds `SessionUpdatedEvent` from a freshly re-read `SessionSummary`
  (`Supervisor.emitReconciledSessionUpdate`, and the two
  `ExternalSessionTracker` emit sites), which now carries `lastAgentText`. The
  event object is forwarded whole to clients (`subscriptions.ts`: `emit(type,
  event)` — no field-picking), so no serializer drops it.
- The event's existing triggers (messageCount / contextUsage / title / model
  changed) fire on essentially every agent turn, so the excerpt refreshes with
  them. Emit-payload-only: the change-detection set was left untouched (a new
  agent turn reliably moves messageCount/contextUsage).
- Client `handleSessionUpdated` applies `event.lastAgentText` to the row.

This makes the hover excerpt exactly as live as the context-usage chip already
is — which is why a mouseover-exit repoll or a sidebar-visible recompute was
**not** added: those would be a parallel mechanism for a freshness path that
already exists. Reconnect already triggers a full refetch.

**Latency floor.** The remaining lag is not a YA poll interval. For sessions YA
runs (owned), updates come off the live SDK stream. For sessions an external TUI
runs (the lag the user sees), YA learns of changes by watching the JSONL file:
the global `FileWatcher` over the Claude projects dir uses `debounceMs: 200` and
`periodicRescanMs: 0` (only Codex enables a periodic rescan), so the YA-side
floor is ~200 ms after a write. The dominant, variable delay is how often the
CLI flushes its JSONL — the writer's cadence, which YA cannot shorten. Initial
post-create reconciliations fire at 1 s and 3 s (`INITIAL_RECONCILE_DELAYS_MS`)
to catch the SDK's async first writes; there is no steady-state periodic poll
for Claude.

## Recaps override the excerpt when they are the freshest line

A Claude **recap** (away-summary; see [recaps.md](recaps.md)) is a better "where
is it now?" line than the raw last turn — but recaps are live-only, owned +
running, generated on an away-return, and never persisted (not in the JSONL, not
in YA metadata). So rather than a separate field + client-side recency compare,
the recap is **folded into `lastAgentText`** at emission:

- `Supervisor.requestRecap` emits a partial `session-updated` event with
  `lastAgentText = <recap text>` when `Process` reports a recap was emitted
  (`requestRecap`/`generateAndEmitRecap` now return the text). It rides the live
  path already built; the client applies it in place (no flicker).
- No new field, no persistence: a recap is, at emission, newer than any prior
  turn, so it is unconditionally the current line. The **next real turn**
  overwrites `lastAgentText` from the JSONL via the normal summary read, so the
  recap naturally expires — matching "show the recap only if there is no later
  activity."
- **Immediate path only, and that is correct.** A recap requested mid-turn is
  *deferred* until the turn completes; that completing turn emits a fresher real
  `lastAgentText`, which should win over a recap. So the deferred-recap flush is
  deliberately not wired to override the excerpt.
- Native recaps (`recapMode: "native"`) yield no text to YA (provider-owned, not
  delivered via the SDK), so only YA-synthesized (side-session) recaps fold in —
  consistent with "not routinely generated unless the session is open."

### On-demand refresh of idle previews (focus / hover)

Idle (owner `none`) sessions get no live `session-updated` events, so their
excerpt can be stale — blank for sessions whose index cache predates this
feature, or simply behind whatever was cached. They are refreshed **on demand**
when the user expresses interest:

- **Provider-independent by construction.** The shared extractor
  `extractLastAgentExcerpt(messages)` (`sessions/agent-excerpt.ts`) operates on
  the uniform `Message[]` that every provider's reader yields through
  `normalizeSession`, so one implementation covers Claude, Codex, Gemini,
  OpenCode, Grok (and pi via whichever reader serves it).
- **Endpoint** `POST …/sessions/:id/refresh-preview` is hybrid for cost:
  Claude uses the *fast* `ClaudeSessionReader.getLastAgentExcerpt` (reverse-scan
  of raw JSONL lines, no full parse/DAG); every other provider goes through
  `loadRestartSourceSession` (cross-provider resolve + `getSession` +
  `normalizeSession`) and the shared extractor. Either way, when text is found
  it emits a `session-updated` carrying `lastAgentText`. The result arrives at
  the client through the live path (not the HTTP response), so the row/hover
  updates **in place — no flicker, no whole-list refetch**.
- The extraction helpers (`formatAgentExcerpt`, `assistantContentParts`) live in
  `sessions/agent-excerpt.ts` and are shared by the Claude summary path
  (`reader.ts`), the Claude fast scan, and the normalized path, so all three
  produce identical output.
- **Triggers:** opening a non-running session (`useSession` `handleLoadComplete`
  when `owner === "none"`) and hovering a non-running row (`SessionListItem`,
  debounced, once per row). Owned/external sessions are skipped — they already
  update live, and refreshing them could clobber a fresh recap with the JSONL's
  last turn.

This deliberately does not persist (no index write), so it does not survive
reyep; the cold-cache excerpt repopulates on the next focus/hover or when the
file next changes. That matches the accepted "old sessions blank until touched"
tradeoff.

## Mobile preview access via the row menu (proposal — not built)

Hover does not exist on touch devices, so the recent-activity preview is
currently **unreachable on mobile**. The session row's `…` (overflow/hamburger)
menu is the only affordance that opens on tap, so it is the place to surface the
preview. Proposal, for discussion after the current work lands:

- **Narrow the menu** so a preview can sit beside it: shorten "Copy prompt" →
  "Copy" and "Mark as unread" → "→ unread" (an arrow glyph suggesting the
  action, replacing the circle). Reduce the menu's horizontal padding and font
  size.
- **Place the preview to the left of the menu** (a tap-opened variant of the
  hover card), so the same recent-activity content is reachable without a mouse.
- **Alternative layout:** lay the menu items out in two columns and put the
  preview full-width above or below the menu, choosing above vs. below from the
  `…` button's position on screen (same below/above flip logic the hover card
  already uses).

Open sub-questions: whether the tap-preview reuses `SessionHoverCard` (it is
already portal/fixed and self-positioning) or a menu-embedded variant; and how
the narrower menu interacts with existing `SessionMenu` items beyond Copy/unread.

## Open questions / phase 2

- **Live tail** for running sessions (thinking/tool/streaming) — needs live
  process text in the list; honor the thinking-display setting. Decide whether
  it *replaces* the persisted excerpt while `activity === "in-turn"` or sits as
  a third state.
- **Markdown handling** — opted to light-strip syntax + collapse blank lines
  rather than render markdown in a tooltip; confirm the strip is good enough on
  code-heavy turns.
- **Per-provider parity** — the snippet's notion of "regular agent turn" must
  hold across providers whose readers structure assistant content differently.
