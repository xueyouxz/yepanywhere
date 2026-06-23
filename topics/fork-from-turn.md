# Turn-notch actions (fork / copy / trim)

> Fork-from-turn already exists in the session view. This topic covers
> exposing it (plus copy and the existing scrollback-trim) from the
> scrollbar-aligned turn notches via a context menu, and making fork seed the
> new tab's compose box with the turn it forked before.

Topic: fork-from-turn

Status: built for the first UI/backend pass. The turn-notch context menu now
uses explicit **Fork before…** and **Fork after…** actions. **Fork after…** can
use the composer as summary instructions and create a *fork-after-summary*: a
fork whose later history is replaced by an LLM-generated summary. That summary
is produced by the generalized recap/summary facility (see [recaps](recaps.md)),
not pasted-together turns.

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
[synthetic-turn-injection](synthetic-turn-injection.md) (whether the single
summary user turn could instead be a sequence of synthetic user+agent turns,
per provider),
[settings-ui-placement](settings-ui-placement.md) (where the auto-open default
setting lives, and the default + live-override pattern it follows),
[transcript-display-objects](transcript-display-objects.md) (the durable
pseudo-turn the fork-send float should transition into — future work),
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

For **Fork after…**, the composer mode is only shown when the composer was empty
when the action was invoked. If the composer already has text, there is no mode:
YA immediately treats the current composer contents as summary instructions and
starts fork-after-summary. In the empty-composer case, the temporary mode changes
the placeholder, shows a small badge/caption, changes the send icon to the fork
action, and adds Cancel:

```text
Fork after selected turn
Keeps this request and the agent response to it; replaces later turns with an
optional generated summary.

[Cancel] [Fork with summary]
```

- **Cancel** returns the composer to normal and preserves the user's text.
- **Fork with summary** sends the composer text as instructions for generating
  the summary, creates the target fork at the selected completed-turn anchor, and
  submits the generated summary as the next user turn in that fork. Empty
  composer text means "use the default summary template," not "no summary."

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

1. Fork the full source session into a generator fork (byte-identical prefix;
   inherits source prompt-cache warmth while it lasts). The after-turn pointer,
   plus a human-readable boundary excerpt when available, tells the summary
   prompt which completed-turn prefix the target fork will retain. This is the
   high-fidelity strategy's fork, run through the shared helper side session
   ([side-session-config](side-session-config.md)).
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

The submitted summary displays as a normal user turn and is part of the target
fork's provider context. Content after the retained user turn can be collapsed in
the source outline, but the summary itself should not get a special transcript
role. Nice-to-have, low priority: YA may insert a non-context UI element
immediately before the summary showing the user's typed summary-amendment
instructions; that element is viewer state only and is not submitted to the
provider.

### Enhanced summary: computed prelude/postlude around the model body (planned)

Upgrade the submitted user turn from free prose to a **layered** structure. Only
the middle is model-generated; YA wraps it with a **fixed computed prelude and
postlude** it assembles deterministically (the model cannot reliably know the
target fork's session id, the anchor message id, or the source-active flag, so
those must be computed, not prompted). None of this needs provider changes — it
is all content in the one submitted turn, so it works on every provider that can
fork (why we are *not* splitting into multiple synthetic turns:
[synthetic-turn-injection](synthetic-turn-injection.md)).

Layout of the submitted turn:

```text
<title line>                 model — first line of the generated summary
<provenance header>          computed prelude (deterministic, at last moment)
<summary body>               model — the generated summary
<handoff close>              computed postlude — only if source-active: yes
```

This is two separable workstreams, and they commit independently: the **UX**
(fork-send progress/follow, below) is the priority and lands first; the
**summary-instruction template + computed prelude/postlude** here is a later,
distinct commit.

1. **Title line (model).** The summary's **first line** is a concise title
   (≤ ~120 chars, no trailing period) naming the task/state, used verbatim as
   the forked session's `title` (the `forkSession({ title })` option) and as the
   follow-hyperlink label (see fork-send section). The instruction template — the
   only model-facing template work, "if any" — asks the model to lead with this
   line; everything else here is computed, not prompted.

2. **Provenance header — computed prelude**, emitted immediately after the
   title. Compute it at the **last moment** — when summary generation completes
   and YA assembles the final turn — not at activation:
   - `forked-from: <source session id> @ <project cwd>`
   - `summary-ends-at: <anchor message id>` — the completed-turn boundary the
     target fork retains. Everything in the source *after* this id is the source
     branch's own divergence, not this branch's history.
   - `source-active: <yes|no>` — computed at summary completion. `yes` if the
     source was live or, crucially, if the user **entered a turn in the source
     during generation**. Sampling at the last moment (after the 30+ s wait, not
     at activation) is what catches that continued user interaction: a turn typed
     into the source while the summary was generating is strong evidence the
     source is the user's primary line, which the postlude honors by waiting for
     an explicit go.

3. **Handoff close — conditional computed postlude.** Emit the postlude **only
   when `source-active: yes`** (the user acted in the source during generation).
   In that case it instructs the receiver: do **not** take over autonomously —
   state that you are holding and **wait for an explicit "go" from the user**
   before resuming, because the live source is the user's primary line and two
   branches must not do the same work.

   When `source-active: no` (no user action during the summarize phase), there
   is **no postlude at all**. The summary body plus the fork itself imply
   continuation, so the receiver just takes over; no "intent to take over"
   boilerplate is added.

The source pointer is the dereference escape hatch for that decision: trust it
for *current* liveness (is the source still going?), not for this branch's
authorizations (the source may have diverged past the anchor). The postlude,
when present, supersedes the bare "Do not continue the task" line in the template
above, which was aimed at the *generator* fork; the close governs the *target*
fork's receiver.

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
- **Rename `generateRecap` → `generateSummary`**: the facility now emits both
  ≤40-word recaps and longer fork-after-summary handoffs, so "recap" (a
  GLOSSARY term) understates it; recap becomes a preset of the summary
  facility.

## Implemented

1. **Context menu on the notches.** `UserTurnNavigator` markers take
   `onContextMenu` (desktop right-click) and a ~450ms long-press (touch) that
   open a portaled menu (`.user-turn-nav-context-menu`) anchored with its right
   edge at the pointer, opening leftward (notches sit at the right edge).
   Items: **Jump**, **Fork before…** (`onForkBeforeAnchor`), **Fork after…**
   (`onForkAfterAnchor`), **Copy** (`onCopyAnchor`), **Show from**
   (`onTrimAnchor`). Plain click still jumps; the trim dot still trims. Dismiss:
   transparent overlay click, Escape, or selecting an item. New props are
   optional, so items render only when wired.
2. **Fork seeds the new composer.** `SessionPage.forkBeforeUserMessage` writes
   the selected turn's text to `localStorage["draft-message-" + newSessionId]`
   before navigating; the composer reads that key via `useDraftPersistence`.
   "Branch and retry this turn." `turnContentText()` extracts the text (shared
   with copy).
3. **Fork-after-summary.** `generateRecap` is refactored to provider
   `generateSummary` with side-session recap and fork strategies. Claude's fork
   strategy creates a throwaway full-source generator fork, submits the summary
   prompt there, then `/fork-summary` creates the target fork at the completed
   turn anchor and submits the generated summary as an ordinary user turn. The
   client exposes `api.forkSessionWithSummary`.
4. **Composer fork mode.** `SessionPage` invokes fork-after immediately when the
   composer already has summary instructions. If the composer is empty, it puts
   `MessageInput` into a temporary fork-summary mode: the placeholder/caption
   explain the action, the send icon changes, `Ctrl+Alt+Enter` defaults to the
   first completed user turn, and empty submit means the default summary
   template. Cancel exits the mode without discarding typed text.
5. **Copy** uses the full turn text, resolved in `SessionPage` (`copyUserMessage`
   → `onCopyUserMessage` → `onCopyAnchor`), not the truncated `marker.preview`.
   Silent (matches the existing copy-prompt action; no toast / i18n key added).

Wiring: `SessionPage` → `MessageList` (`onForkBeforeUserMessage`,
`onForkAfterUserMessage`, `onCopyUserMessage`, `onTrimBeforeUserMessage`) →
`UserTurnNavigator` (`onForkBeforeAnchor`, `onForkAfterAnchor`, `onCopyAnchor`,
`onTrimAnchor`). Fork stays gated by `supportsForkSession` (`SessionPage` passes
`undefined` otherwise, so the menu omits Fork).

## Fork-send: backgrounded progress and follow

**Status: implemented, except the durable pseudo-turn.** Shipped: the
backgrounded indicator (phase + elapsed), the auto-open attempt with a
title-labeled hyperlink fallback, the two cancels, the per-fork auto-open toggle
seeded from a persistent default, and the float's fade-out on a terminal event.
**Remaining next step:** the durable pseudo-turn (§ Float vs durable pseudo-turn).
The numbered design below is retained as the spec it was built to.

**Original symptom (the bug this fixed).** The generation step is a full LLM turn over
the *entire* forked context — 30+ s, worse with a cold prompt cache (per
[provider-context-economics](provider-context-economics.md)) — but it is wired
as a blocking composer submit. The only feedback is the **greyed-out send
button**: no phase, no elapsed time, no ETA, no cancel, and the parent composer
is locked the whole time. The user cannot tell working from hung, so 30 s of
dead UI reads as a freeze. This generalizes the existing "show a visible pending
state with Cancel" rule (§ Anchor meanings, written for the response-still-being-
written case) to the generation wait, which was the unhandled case.

**Fix: make fork-send a backgrounded async job with its own persistent
indicator,** freeing the composer immediately.

1. **On activation,** dismiss the composer fork-mode apparatus at once
   (placeholder / badge / Cancel) and return the composer to normal — the typed
   instructions were already consumed as the summary prompt. Replace it with a
   **persistent "Forking…" indicator**: a non-context viewer-only element (it
   must not become a real provider turn in the parent transcript; same class as
   the typed-instructions element noted above), pinned at the transcript tail or
   as a small float. It shows phase ("Generating summary…") and elapsed time.

2. **On ready** (target fork created, summary submitted), **open the forked
   session in a new tab** when the auto-open preference is on — a server-scoped
   per-install default (default-off per [vanilla-defaults](vanilla-defaults.md);
   see [settings-ui-placement](settings-ui-placement.md)) with a per-fork
   override toggle on the indicator. Because generation typically takes 30+ s,
   the open is deferred to completion, not attempted up front.

3. **Auto-open fallback.** If the new tab cannot open (popup blocking, or a
   user "don't auto-open" preference), the indicator stays and surfaces a
   **hyperlink** the user clicks to follow at their choice. The hyperlink label
   is the **title line** (summary first line). Even when auto-open succeeds, the
   indicator may persist briefly as `Forked: <title> ↗` so the user has a way
   back.

   Lifecycle: `Forking… (Cancel)` → `Forked: <title>` (auto-opened, or a
   click-to-open link). One indicator per in-flight fork; concurrent forks are
   allowed if cheap, but a single-at-a-time MVP is acceptable.

**Two distinct cancels — do not conflate.**

- **Pre-send Cancel** (the existing composer fork-mode Cancel): the fork has not
  been sent, no summary has been generated. It simply drops the request and
  returns the composer to normal, preserving typed text. Cheap, no provider
  cost incurred.
- **In-flight Cancel** (on the progress indicator): the generator fork is
  already running an LLM turn. This aborts that in-flight generation (the
  generator fork is required to be cancellable per § Summary generation flow)
  and tears down the indicator. It must be clearly scoped to "stop this running
  fork," visually distinct from the pre-send drop, and should note that the
  generation turn already partially billed.

### Float vs durable pseudo-turn

The follow indicator has two intended forms, and the preferred end state is the
second:

- **Transient float** near the composer for immediate attention while
  generating. On a terminal event (`(tab opened)` or `(clicked)`) it
  **animates/fades out** — it must not linger as a permanent pinned float, which
  would be annoying.
- **Durable pseudo-turn** placed in the session outline at the end as of
  creation time. The float should **transition into** this object rather than
  just vanishing. It is a [transcript display object](transcript-display-objects.md)
  — a saved display-only item with a placement, **not** a real turn (never in
  model context). It **scrolls with content** (scrolls off with continued use,
  by design), **updates in place** to `(tab opened)` when auto-open is detected,
  and **marks `(clicked)`** when followed — but the object and its link **stay in
  any case**. Persistence (ideally server-side, surviving device migration and a
  YA restart) is future work; see the linked topic.

The follow link's label is the **title line** (summary first line), shared by the
float, the pseudo-turn, and the forked session title.

**Implemented: the transient float.** It fades out on a terminal event
(`(tab opened)` lingers briefly then fades; a link click fades), with the `×`
kept only for the error state. The per-fork auto-open toggle and its persistent
default ship alongside.

**Remaining next step — the durable pseudo-turn.** The float currently just fades
and is gone; it does **not** yet transition into a durable
[transcript display object](transcript-display-objects.md) placed in the session
outline. That object — scroll-with-content placement, in-place `(tab opened)` /
`(clicked)` updates with the link staying, and server-side persistence surviving
device migration and a YA restart — is the next phase and is not built.

## Open questions / follow-ups

- Long-pressing a right-edge notch is a small touch target; may want a larger
  hit area or to surface the menu from the wider preview label on touch.
- Whether to share one context-menu component with the hovercard topic's mobile
  row-`…` menu proposal (shared dismiss rules).
- Copy has no visible confirmation (silent); add a toast if desired.
