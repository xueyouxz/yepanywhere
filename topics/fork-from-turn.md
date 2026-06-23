# Turn-notch actions (fork / copy / trim)

> Fork-from-turn already exists in the session view. This topic covers
> exposing it (plus copy and the existing scrollback-trim) from the
> scrollbar-aligned turn notches via a context menu, and making fork seed the
> new tab's compose box with the turn it forked before.

Topic: fork-from-turn

Status: partly built. The turn-notch context menu (jump / fork / copy /
hide-previous) and fork compose-prefill are implemented. The next design step
is to replace the single fork entry with explicit **Fork before…** and **Fork
after…** actions, where **Fork after…** can use the composer as summary
instructions and create a *fork-after-summary*: a fork whose later history is
replaced by an LLM-generated summary. That summary is produced by the
generalized recap/summary facility (see [recaps](recaps.md)), not pasted-together
turns. This design is **decided** — committed to build, with the timing chosen
later — not a speculative sketch.

See also:
[session-context-actions](session-context-actions.md) (fork-capability ground
truth, the per-turn "fork from here" decision this elaborates, and the handoff
decision revised by fork-after-summary),
[recaps](recaps.md) (the LLM-summary facility this generalizes, and its
shared-helper-vs-fork strategy split),
[side-session-config](side-session-config.md) (the shared helper side session
and its bounded lifecycle),
[provider-context-economics](provider-context-economics.md) (the cost of the
fork + generation step),
[session-hovercard-recent-activity](session-hovercard-recent-activity.md) (the
sibling mobile context-menu / dismiss discussion),
[provider-agnostic-btw-asides](provider-agnostic-btw-asides.md) (the other fork
consumer),
[scrollback-view-stability](scrollback-view-stability.md) (the client transcript
window the trim dot controls).

## What already exists (do not rebuild)

- **Fork from a turn.** `SessionPage.forkBeforeUserMessage(messageId)` forks the
  session from just *before* a user message: it finds the prior user/assistant
  message as the anchor and calls `api.forkSession(projectId, sessionId,
  { upToMessageId: anchor })`, then navigates to the new session. Gated by
  `currentProviderInfo.supportsForkSession`. Surfaced per-turn through
  `MessageList` `onForkBeforeUserMessage` → `RenderItemComponent`
  `onForkBeforeUserPrompt` / `onForkBefore`.
- **Scrollbar turn notches.** `UserTurnNavigator` renders, per user turn, a jump
  marker (`handleAnchorClick`) **and** a trim dot (`onTrimAnchor(markerId)` —
  "load client transcript from this turn", i.e. drop earlier scrollback).
- **Compose drafts** are plain `localStorage[\`draft-message-${sessionId}\`]`
  (SessionPage builds that key; `useDraftPersistence(key)` reads it directly —
  no install-id indirection for the session composer).

## Proposal: fork before / fork after / fork-after-summary

Replace the current notch-menu **Fork from here** entry; no legacy label needs
to be preserved. The right-scroll turn marker context menu should stay narrow:

```text
Jump
Fork before…
Fork after…
Copy
Show from
```

The ellipsis means the action enters a fork composer mode or uses existing
composer text as instructions; it is not a wide modal opened from the notch.
**Show from** renames the currently implemented **Hide previous** (`onTrimAnchor`):
both load the client transcript from this turn, but "show from here" names the
result rather than what is hidden, and avoids overloading "before" already used
by **Fork before…**.

### Anchor meanings

- **Fork before…** anchors before the selected user request. This is the retry
  path: discard the selected request's original assistant response and continue
  differently from that point.
- **Fork after…** anchors at the completed turn boundary for the selected user
  request: keep the user request and all assistant/tool output responding to it,
  then replace later history. In transcript terms, the anchor is the last
  active-branch message before the next user turn. If there is no later user
  turn, the anchor is the completed current tail once the session is idle.

Both map onto the inclusive `forkSession({ upToMessageId })` primitive — the
slice keeps up to and including that UUID (`providers/types.ts`) — so **Fork
before…** sets `upToMessageId` to the last message *before* the selected user
turn, and **Fork after…** sets it to that last active-branch message *of* the
turn.

Canonical description, reused verbatim as the **Fork after…** menu tooltip and,
when the composer is empty, the fork-mode instruction badge: "Keep this request
and the agent's response to it, then replace everything after with an
LLM-generated summary that follows your instructions."

The default for summary replacement is **Fork after…**, not **Fork before…**.
That preserves the original agent boot/orientation work: instruction-file load,
initial repository reads, planning, and any derived state already present in the
assistant/tool output responding to the initial request. Forking immediately
after the first raw user message risks making the successor repeat that work or
start before the evidence that the original agent used.

If the selected response is still being written, **Fork after…** must not
silently degrade to the pre-response anchor. Either wait for the assistant turn
to complete and then fork, or show a visible pending state with Cancel.

### Composer fork mode

Selecting **Fork before…** or **Fork after…** activates a visible composer mode.
If the composer already contains text, YA treats that text as summary
instructions. If the composer is empty, the mode changes the placeholder so the
user can enter summary instructions.

For **Fork after…**, the composer mode needs these actions:

```text
Fork after selected turn
Keeps this request and the agent response to it; replaces later turns with an
optional generated summary.

[Cancel] [No summary] [Fork with summary]
```

- **Cancel** returns the composer to normal and preserves the user's text.
- **No summary** creates a normal fork at the selected completed-turn anchor.
- **Fork with summary** sends the composer text as instructions for generating
  the summary, creates the target fork at the selected completed-turn anchor, and
  submits the generated summary as the next user turn in that fork.

For **Fork before…**, the mode can share the same footer actions, but **No
summary** is the ordinary retry fork. A summary option is allowed but is less
central; its generated text would explain how to retry or modify the discarded
turn, not summarize a retained prefix.

### Keyboard shortcut

Add a composer shortcut for the fast path, tentatively `Ctrl+Alt+Enter`:

```text
Ctrl+Alt+Enter: fork after the initial turn with summary instructions
```

The shortcut uses the same composer fork mode and semantics as the context-menu
path, with the default anchor set to the completed first user turn — the first
user request plus the assistant/tool output that handled it. If the composer has
text, the shortcut sends it as summary instructions. If the composer is empty,
it activates the visible fork mode so the user can type instructions or choose
**No summary**.

The shortcut must be listed in the session keyboard-shortcuts popover. It must
not change normal Enter / Ctrl+Enter send behavior, and it must not send the
composer text to the current session.

### Summary generation flow

The summary is produced by the **generalized recap/summary facility** (the
refactored `generateRecap`; see [recaps](recaps.md)). Recaps already define two
execution strategies — a shared helper side session for the cheap recent-text
recap, and *forking the main session/original model for higher fidelity*
(`recaps.md`). Fork-after-summary is exactly that high-fidelity fork strategy,
extended with an after-turn pointer and free-text summary instructions applied to
the **whole** retained-to-discarded context, not just recent assistant text.

The current source session must not be polluted by a "summarize yourself" turn,
and a fork (not a resume) is what makes that possible: the SDK `query()` exposes
no `skipTranscript`, so a `resume:`-based one-turn summary would append a visible
turn to the *source* transcript (`recaps.md`). Generation therefore runs on a
throwaway fork — only that fork's jsonl receives the instruction turn:

1. Fork the source session at the after-turn pointer into a generator fork (full
   context, byte-identical prefix; inherits source prompt-cache warmth while it
   lasts). This is the high-fidelity strategy's fork, run through the shared
   helper side session ([side-session-config](side-session-config.md)).
2. Submit the YA template plus the composer instructions to the generator fork.
3. Capture the assistant's generated summary.
4. Create the *target* fork at the selected **Fork after…** anchor.
5. Submit the generated summary as the next user turn in the target fork and
   navigate there.

The generator fork is implementation scaffolding, not the user's target branch.
Its lifecycle is required by the no-`skipTranscript` limitation above, not
incidental: it must be cancellable, bounded by the helper-session lifecycle
rules, and either auto-archived or clearly marked so it does not clutter normal
session lists.

### Summary template contract

The generated prompt should make the retained prefix explicit so the summary
does not repeat work already present in the fork:

```text
Summarize the useful state after the retained fork boundary for a peer-agent
handoff. The target fork already includes the original request and the
assistant/tool work through the selected completed turn. Do not repeat setup,
instruction loading, initial repository orientation, or investigation already
present in that retained prefix.

The summary will be submitted as the next user turn in the target fork. Preserve
decisions, constraints, current state, changed files, verification evidence,
open risks, and the next useful action. Do not continue the task.

Additional user instructions:
<composer text, if any>
```

The submitted summary should be visibly distinguished from an ordinary
user-authored request in YA, e.g. as a collapsed or labeled **fork-after-summary**
block, even if the provider receives it as a user-role message.

### Capability and default posture

Show these actions only where YA has a real prefix-fork primitive. Claude is the
validated provider today. Do not emulate a button named fork with a template
handoff on providers that cannot actually fork; that would hide a different cost
and context shape behind the same label.

Cost: fork-after-summary pays for one generation turn over the forked context
plus the two forks; the generation reprocesses uncached input when the source
prompt cache has gone cold. Per [provider-context-economics](provider-context-economics.md),
surface that price rather than hide it behind the button.

This is an advanced explicit action. Normal composer send behavior remains
verbatim and unchanged; the feature is invoked only by the notch context menu or
the documented shortcut.

## Design decisions

- **Generate through the generalized recap/summary facility's fork strategy**
  (vs. a bespoke summary subsystem, and vs. a non-persisted query over a
  serialized transcript): one LLM-summary facility serves recap,
  fork-after-summary, and the planned handoff option. Full-context fidelity plus
  prompt-cache warmth need a real fork — the SDK `query()` has no
  `skipTranscript`, so a resume would pollute the source, and a serialized
  one-shot query would drop native message structure and cache warmth.
- **Two execution strategies under one facade** (vs. always-fork): recap stays
  the cheap recent-text helper-side-session query; fork-after-summary uses the
  fork strategy. Always-fork would make every on-return recap pay a fork +
  process spawn. (The split already exists in [recaps](recaps.md).)
- **Reintroduce agent LLM summarization as an explicit opt-in** (vs. the dropped
  agent-summarization posture in [session-context-actions](session-context-actions.md)):
  that posture held when no working LLM-summary path existed and template +
  source-session-id sufficed. Now that fork-after-summary builds a working one,
  the same summary-instruction control is offered as an option on standard
  handoff too; default stays template + pointer, the LLM summary is opt-in.
  This revises that doc's handoff decision.
- **Rename `generateRecap` → `generateSummary`** (recommendation): the facility
  now emits both ≤40-word recaps and longer fork-after-summary handoffs, so
  "recap" (a GLOSSARY term) understates it; recap becomes a preset of the
  summary facility.

## Implemented

1. **Context menu on the notches.** `UserTurnNavigator` markers take
   `onContextMenu` (desktop right-click) and a ~450ms long-press (touch) that
   open a portaled menu (`.user-turn-nav-context-menu`) anchored with its right
   edge at the pointer, opening leftward (notches sit at the right edge).
   Items: **Jump to turn**, **Fork from here** (`onForkAnchor`), **Copy turn**
   (`onCopyAnchor`), **Hide previous** (`onTrimAnchor`). Plain click still jumps;
   the trim dot still trims. Dismiss: transparent overlay click, Escape, or
   selecting an item. New props are optional, so items render only when wired.
2. **Fork seeds the new composer.** `SessionPage.forkBeforeUserMessage` writes
   the selected turn's text to `localStorage["draft-message-" + newSessionId]`
   before navigating; the composer reads that key via `useDraftPersistence`.
   "Branch and retry this turn." `turnContentText()` extracts the text (shared
   with copy).
3. **Copy** uses the full turn text, resolved in `SessionPage` (`copyUserMessage`
   → `onCopyUserMessage` → `onCopyAnchor`), not the truncated `marker.preview`.
   Silent (matches the existing copy-prompt action; no toast / i18n key added).

Wiring: `SessionPage` → `MessageList` (`onForkBeforeUserMessage`,
`onCopyUserMessage`, `onTrimBeforeUserMessage`) → `UserTurnNavigator`
(`onForkAnchor`, `onCopyAnchor`, `onTrimAnchor`). Fork stays gated by
`supportsForkSession` (`SessionPage` passes `undefined` otherwise, so the menu
omits Fork).

## Open questions / follow-ups

- Long-pressing a right-edge notch is a small touch target; may want a larger
  hit area or to surface the menu from the wider preview label on touch.
- Whether to share one context-menu component with the hovercard topic's mobile
  row-`…` menu proposal (shared dismiss rules).
- Copy has no visible confirmation (silent); add a toast if desired.
