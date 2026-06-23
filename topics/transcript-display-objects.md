# Persisted transcript display objects (pseudo-turns)

Topic: transcript-display-objects

Status: future work / not built. Captures the idea of **saved display-only
objects placed in a session's transcript** — the durable home the
fork-after-summary indicator should transition into. Recorded now so the
design intent is not lost; nothing here is implemented.

See also:
[fork-from-turn](fork-from-turn.md) (the motivating instance — the
"Forking…/Forked link" object),
[synthetic-turn-injection](synthetic-turn-injection.md) (the deliberate contrast
— that is about putting turns *into* model context; these are explicitly *not*
in context),
[scrollback-view-stability](scrollback-view-stability.md) (the transcript window
/ placement-anchoring concerns these inherit).

## What they are (and are not)

A **transcript display object** is a saved display-only item with a **placement**
in a session's transcript — a comment, a status chip, a follow link. Crucially:

- **Not a turn.** Nothing here enters the provider/model context. It is never
  sent to the model, never replayed on resume, never counted in tokens. Calling
  them "synthetic turns" is shorthand; they are *saved display objects/comments
  with a placement*, not conversation turns.
- **Distinct from [synthetic-turn-injection](synthetic-turn-injection.md).** That
  topic is the opposite operation — materializing items the model *does* treat
  as context. These never touch context; the only thing they share is "not a
  real provider-generated turn."
- **Placed, not pinned.** The object is anchored at a transcript position
  (placed at the end as of when it was created) and **scrolls with content**. It
  is not a permanent float; if the session sees continued use it scrolls off,
  which is desirable — a float that stayed forever would be annoying.

## Behavior (from the fork-after-summary instance)

The fork-send follow link is the first such object (see
[fork-from-turn](fork-from-turn.md)). Its lifecycle generalizes:

- Created and placed at-end at creation time.
- **Updates in place**: e.g. gains `(tab opened)` if auto-open is detected to
  have succeeded.
- **Click marks it `(clicked)`** (clicked in any way), but the object — and its
  link — **stay in any case**; clicking does not remove it.
- A transient companion **float** near the composer may give immediate
  attention, then **animate/fade out on a terminal event** (`(clicked)` or
  `(tab opened)`); the preferred end state is that it **transitions into the
  durable pseudo-turn** in the session outline rather than just vanishing.

## Persistence

The objects should survive **two** things, and that pair is the whole rationale
for the storage choice:

1. **Migrating the view to a new device** — open the same session on another
   client and the objects are still there, in place.
2. **A YA (server) restart** — they reappear in the same transcript position
   after the server bounces.

- **Ideal: server-side.** Save them server-side, associated with the session and
  its placement, so both survival goals hold and the objects follow the user
  across clients.
- **Client-side localStorage is an acceptable quick hack** for an MVP, but it
  cannot meet goal (1): it is per-device, so a device migration loses it. It is
  also awkward to anchor durably. So treat localStorage as a stopgap, not the
  target.

## Open design questions (for when this is built)

- **Placement anchoring.** How to pin a stable position that survives later
  turns, edits, and the client's scrollback window (see
  [scrollback-view-stability](scrollback-view-stability.md)). Anchor to a
  neighboring message id? An ordinal? A timestamp?
- **Schema.** What a saved object holds: kind (link/comment/chip), placement
  anchor, label/text, optional href, mutable state flags (`opened`, `clicked`),
  created-at. Server-side storage shape and API.
- **Authorship scope.** System-generated (the fork link) vs potential
  user-authored comments; whether both share one mechanism.
- **GLOSSARY.** "Transcript display object" / "pseudo-turn" is a candidate term
  if this is built.
