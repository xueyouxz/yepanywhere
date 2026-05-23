# Provider-Agnostic /btw Asides

This topic covers YA-owned `/btw` side sessions: short side requests that
should run beside a parent session without being treated as active-turn
steering, patient queueing, or provider-native slash-command pass-through.

## Contracts

- `/btw` is a YA routing command. It starts or focuses an aside session when
  YA has an explicit capability path for the provider; unsupported providers
  should not silently receive `/btw` as ordinary prompt text.
- Parent and aside sessions are separate work streams. The parent agent should
  not see aside prompts or results unless the user explicitly injects them.
- Result injection is a separate user action. It may insert into the composer,
  steer an active parent turn, or queue into the parent only through the normal
  parent-session delivery controls.
- Focused aside mode changes composer routing, not parent ownership. Parent
  liveness, queue state, and ongoing output must remain visible enough that the
  user can tell which work stream is active.
- Aside capability is provider-specific but the product model is
  provider-neutral: provider-fork, storage clone, native subagent, or
  resume-with-summary paths must all satisfy the same parent/child contract.

## Invariants

- `/btw` must not be a synonym for `turn/steer`, deferred queue, or patient
  queue. Those are separate delivery intents.
- A child aside must persist a parent link, and parent views must be able to
  hydrate visible child-aside state after reload.
- UI affordances should show routing state before submission. If the composer
  is focused on an aside, the user should not have to infer that from a
  truncated title or hidden URL parameter.
- Completed or hidden asides remain findable in the parent timeline or aside
  list; they should not disappear solely because the child process ended.
- Provider-specific context cloning must be bounded and explicit. If a provider
  cannot fork cheaply, YA should expose that as a capability gap rather than
  replaying unbounded parent context by accident.

## Representative Change Types

- Adding provider capability flags or fork/clone orchestration.
- Changing `/btw` slash parsing, keyboard shortcuts, or composer routing.
- Changing aside parent/child persistence or hydration.
- Changing aside card/timeline rendering and focused-aside controls.
- Adding result insertion, steering, or queue-to-parent actions.

## Tests That Should Fail On Contract Regressions

- `/btw` on an unsupported provider does not silently enter the parent prompt.
- A focused aside routes composer sends to the child until explicitly exited.
- Parent-result injection requires an explicit user action.
- Reloading the parent session restores visible linked aside state.
- Patient queue and `/btw` launch paths remain distinct.

## Next Step: Normal Turn Renderer Adapter

Replace the current string-slice aside transcript model with a message-object
adapter into the normal session turn renderer. `/btw` panes and Mother inline
cards should pass child-session messages through the same user prompt,
assistant text, markdown, tool-call, and copy/selection controls that ordinary
session turns use, with only layout density and composer routing differing for
the aside surface. Keep the adapter role-preserving and explicit about Mother
versus child ownership so split view remains a view concern, not a second
greenfield transcript implementation.

## Wide-screen split pane (focused aside beside Mother)

On wide viewports (≥1100px), focusing a `/btw` aside opens a right-side pane
that mirrors the aside transcript next to Mother's messages. The pane is
collapsible — the user can hide it via a Hide button (which exposes a thin
vertical handle for re-expanding) without losing aside focus. While the pane
is visible, the focused aside's sticky card is hidden from the composer
footer to avoid duplication; collapsing the pane restores that card.

Composer ownership in the split layout: each pane owns its own composer.
Mother keeps the full footer composer (model picker, attachments, voice,
permission mode, deferred queue, etc.) but narrowed to the messages
column. The aside pane carries a minimal composer (textarea + Send,
Enter-to-send, anchored at the pane bottom so it remains visible while
the aside body scrolls). The minimal composer intentionally omits model,
attachments, voice, and permission affordances — only `/done` is parsed
client-side; other slash text is forwarded verbatim to the aside agent,
and users who need a full composer can collapse the pane to fall back to
the single-composer focus-routing model.

Contracts:

- Split pane affordance is opt-in by viewport width and focus. Mobile,
  narrow viewports, and unfocused state retain the existing inline aside
  cards above the composer.
- Hiding the pane (`btwSidePaneCollapsed = true`) must not change aside
  focus, queue state, or aside lifetime; only the right-pane render is
  suppressed and the sticky card returns. In the collapsed state the
  aside pane composer is unmounted, so Mother's footer reverts to
  routing into the focused aside (`mainComposerForAside` is true).
- When the pane is expanded the footer composer routes to Mother
  (`mainComposerForAside` is false). Aside turns go through the pane
  composer; Mother's draft and the aside's draft are independent.
- Closing the aside (Done button in the pane, the inline card's Done, or
  `/done` in either composer) must clear the focus and return the
  composer to Mother.
- Focus transitions reset the pane to expanded and clear the aside-pane
  draft (single-string, not persisted to localStorage in the initial
  ship); an explicit collapse only persists for the current focus
  session.
- Layout uses CSS grid on the `session-split-with-aside` container so
  messages occupy top-left, Mother's footer occupies bottom-left, and
  the aside (or its handle) spans the full-height right column. The
  underlying DOM remains source-ordered as messages, aside, handle,
  footer to preserve narrow-viewport behavior under the default
  flex-column.

## `/done` close-and-report command (in-aside)

`/done` is a YA-intercepted slash command available in an aside composer. It
closes the aside and reports back to Mother through the user-mediated draft
path. It is not sent to the aside agent. Argument shapes:

- `/done` (no argument) — minimal report. Long-term target: drafts into
  Mother's composer `> /btw <asideSessionId>: <original side request,
  truncated>`, no agent invocation. **Initial ship is close-only**: closes
  the aside with no Mother-composer draft, pending agreement on the value
  of automatic drafting.
- `/done <free text>` — long-term target: drafts `> /btw <asideSessionId>:
  <free text>` into Mother's composer, no agent invocation. **Initial ship**:
  closes the aside with a toast noting that report-back drafting is not yet
  implemented.
- `/done summary` (future) — sends a synthetic instruction to the aside agent
  ("produce a handoff-light report, 3-5 lines, paste-ready for the parent
  session"), waits for the response, then drafts that response into Mother's
  composer prefixed with a fork attribution. The user can cancel during the
  wait.
- `/done file [path]` (future) — writes the report (either the minimal form
  or the summary-mode output) to a temp file under the YA data directory and
  shows the path; useful for reports too long for a composer draft. Does not
  populate Mother's composer.

Contracts:

- `/done` is valid only when the composer is focused on an aside. In the
  parent composer it is rejected with a toast, never forwarded as prompt
  text.
- Report-back to Mother always goes through the autodraft-if-empty /
  clipboard-otherwise path; never auto-send a turn to Mother.
- After report-back is drafted (or copied), the aside is dismissed.
- The default `/done` and `/done <free text>` modes must not invoke the
  aside agent — they are pure client-side wind-down.
- `/done summary` is the only mode that issues a further turn to the aside
  agent; that turn must be tagged so it is visible in the aside transcript
  as a YA-initiated handoff request, not as an organic user message.

Open questions deferred until we agree on value:

- Whether the parent agent should be able to read the aside transcript when
  the user asks it to ("hand off everything that happened in that fork").
  Today the parent has no awareness of the aside; cross-session read would
  require new permissions and is intentionally out of scope for the initial
  `/done` ship.
- Whether `/done summary` should be available even when the aside provider
  cannot cheaply produce a short report (e.g., already context-exhausted).

## Future: manual compress-in-place on the forked transcript

Opt-in, user-triggered compression of an aside's cloned transcript (plus the
pending side request) before the aside agent's first real turn runs. Motivated
by long-parent forks where the full clone leaves little headroom for the
aside; manual rather than automatic so the user owns the fidelity/headroom
tradeoff per fork. Default `/btw` behavior remains full-clone with no
autosummary.

Sketched constraints to honor when this is built:

- Compression must not become the aside agent's first turn. Run it as a
  separate, tool-disabled model call whose only output is summary text; do not
  let the aside provider begin the side request until the rewritten transcript
  is in place.
- Compression input includes the cloned history and the pending side request,
  since directives often reference "the file we just edited" or similar —
  compressing only the history can strip the referents the directive depends
  on.
- The rewritten JSONL should contain a single synthetic turn carrying the
  summary, clearly labelled as a YA-generated compression (not as a parent
  assistant turn), followed by the side request as the normal user turn the
  aside responds to.
- Keep the pre-compression clone retrievable (or operate on a copy) so a bad
  compression does not strand the user with an unusable aside.
- Out of scope of `compact-and-handoff.md`'s auto-compact policy. That policy
  is a parent-side pre-send mitigation for one provider/model pairing; this is
  an aside-side, manual, opt-in path that does not share triggers, owners, or
  fallback rules with it.
