# Session Retitle

> Session retitle is the proposed explicit, user-confirmed title editing flow
> that combines manual rename, LLM-generated title suggestions, and unchanged
> recent-session navigation without silently applying generated text.

Topic: session-retitle

Related topics: [recaps](recaps.md), [side-session-config](side-session-config.md),
[fork-from-turn](fork-from-turn.md), [session-ui-customization](session-ui-customization.md),
[vanilla-defaults](vanilla-defaults.md).

## Contract

- A session title must not change from generated text without an explicit user
  confirmation or the clearly requested one-shot generated-and-apply action.
- The existing session-menu **Rename** entry remains manual rename. It does not
  start the generated-retitle helper flow, but it should share the same
  temporary confirm and dismiss controls as the retitle surface.
- Left-clicking the non-menu title text is the proposed entry point for retitle
  or rename. The small chevron may keep the current recent-sessions dropdown
  behavior, because it is the existing rarely used route to the same navigation
  affordance.
- Escape, an `X` button, or losing interest in the helper proposal must leave
  the current title unchanged.

## Manual Rename Surface

Manual rename stays an inline edit of the title field. It should use all
available header width while editing, instead of clipping against a fixed
viewport heuristic.

Confirmation should be visible beside the edit field and shared with generated
retitle:

- **Enter** is the default generated-title accept path when generated retitle
  mode is active. If the helper title is already present, Enter combines it with
  the edit field text according to the current selection and saves that combined
  value as the session title. If the helper is still computing, Enter arms a
  deferred accept that performs the same combine-and-save when the generated
  title arrives.
- A thought-bubble/send glyph is the pointer equivalent of Enter: use the LLM
  title, with the same deferred behavior while the helper is still computing.
- `Ctrl+Enter` is the hard-confirm-as-is path: save the text exactly as it is
  currently typed, without waiting for or inserting a generated title.
- A separate hard-confirm button, likely a disk glyph or quote-mark glyph,
  mirrors `Ctrl+Enter` for pointer users and mobile users.
- `Esc` or `X` cancels with no metadata update.

## Generated Retitle Flow

Generated retitle is a separate helper action, not the current **Rename** menu
entry. The title-text click may enter a compact title-edit surface with a
visible helper affordance, or it may directly start a one-shot proposal
generation if that is the chosen final UX.

Generation prompt shape:

```text
What is a good new title for this session?

Target length: <configured or UI-stated length target>.
Return only the title.
```

The browser Appearance setting **Generated Title Length** controls the target.
It defaults to 80 characters and clamps the visible setting to 50-132
characters. The server accepts that upper bound so the client cannot choose a
target that the retitle route rejects.

The first implementation should use a temporary fork, matching the
fork-after-summary constraint: do not pollute the source provider transcript
with a "summarize/title yourself" turn. The generated title is viewer/UI state
until accepted.

For a stopped session, retitle must first resolve the session's real provider
from live YA ownership, persisted metadata, or cross-provider transcript
readers before testing fork support. If YA can tail/display that stopped
session but has no live source process, retitle reactivates the primary session
with the ordinary message-less resume path before creating the helper fork. That
reactivation is single-flight by YA session id, so a normal user send that
arrives concurrently waits for the same resumed process and then queues its
turn there instead of starting a second resume.

When generation finishes, show the proposed title near the current title or
below the inline edit surface. Do not overwrite the user's typed edit text.
If the user already hard-confirmed the manually typed value, the later helper
result is stale and must not change the title or edit field.

## Accepting Generated Text

Generated text has two possible accept shapes; both remain explicit:

Enter or the thought-bubble/send glyph accepts generated text as the title to
save. The generated text is combined with the edit field according to the
selection captured at accept time: replace selected text, or insert at the
caret, which naturally appends after a typed prefix when the caret sits at the
end. A fully selected title therefore becomes just the generated title.

If generation is still pending when the user presses Enter or the
thought-bubble/send glyph, YA captures that selection/caret state and performs
the same combine-and-save when the generated title arrives. This is a deferred
metadata save, but only because the user already made the explicit generated
accept gesture. `Ctrl+Enter` / hard-confirm remains the separate path for
saving the field exactly as typed, without waiting for generation.

While that deferred accept is armed, the title edit field should stop looking
editable and momentarily show a generating-title placeholder until the helper
result lands. The `X` escape hatch remains visible; additional typing should
not be encouraged because it would not be part of the captured deferred save.
The generating/deferred status surface exposes the submitted helper turn text
on hover so the user can inspect what YA asked the provider to do.

## One-Shot Apply

The compact generated-title button beside the recent-session chevron generates
and applies a new title in one click. It enters the same retitle surface as the
normal proposal flow, immediately arms the deferred generated-title accept path,
and shows the generating placeholder until the helper returns. The generated
text replaces the whole current title because there is no active caret or text
selection before the one-shot action starts.

This remains distinct from clicking the title text: title text starts the normal
generated proposal flow and does not update metadata until the user accepts the
suggestion.

## Helper Model Notes

The first helper can use the same temporary-fork strategy as
fork-after-summary. Future work may use a lesser helper model over a bounded
subset of turns, favoring user turns, to produce quicker title proposals.
That optimization belongs under [side-session-config](side-session-config.md):
it should share helper model/lifecycle policy rather than creating a private
retitle-only helper configuration.

## Tests That Should Fail On Contract Regressions

- Generated retitle output is not written into the source provider transcript.
- A generated title does not update `customTitle` until the user accepts it.
- A pending generated-title accept inserts into the edit field at the captured
  selection/caret when the helper result arrives.
- A manual hard-confirm while generation is pending invalidates the helper
  result; the late proposal must not overwrite the saved title.
- Manual **Rename** opens the edit surface without starting generation.
- Title-text click and chevron click diverge as designed: title text enters the
  retitle/rename flow, while chevron opens recent sessions.
- `Esc` and `X` exit either manual or generated retitle mode without changing
  session metadata.
- Stopped mixed-provider sessions use the provider found by transcript readers,
  wake the source session before the helper fork, and do not race a concurrent
  normal send into a second resume.
