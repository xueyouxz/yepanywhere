# Mic Button Speech UI
> YA's mic button owns a speech insertion transaction: it captures either
> streaming or batch speech, integrates recognized text at the user's selected
> draft position, and treats spoken commands as control events rather than
> dictated text.

Topic: mic-button-speech-ui

See also:

- [pluggable-speech-recognition.md](pluggable-speech-recognition.md) for
  backend selection, server/direct STT routing, and provider capability rules.
- [streaming-speech-capture.md](streaming-speech-capture.md) for the client
  Web Audio PCM pipeline, warm mic, and readiness indicators.
- [direct-xai-speech.md](direct-xai-speech.md) for direct browser-to-xAI STT.

## Speech Insertion Transaction

Pressing the mic button creates a speech insertion transaction at the current
textarea selection. If no text is selected, final speech inserts at the cursor.
If text is selected, the selected text remains in the textarea and should still
look selected while capture starts; YA deletes it only when a non-command final
transcript chunk is committed. A spoken cancel command before any committed
speech therefore leaves the selected text untouched.

Final speech chunks are speech-owned spans. User edits map those spans through
ordinary textarea changes; YA must not infer replacement by substring matching.
When final speech lands in the middle of draft text, subsequent final chunks in
the same mic transaction insert after the previous final chunk, not at the
draft end and not over the previous chunk.

Interim streaming text is only a preview at the transaction insertion point. It
does not delete pending selected text and does not enter the textarea value.
When a provisional selected replacement target exists, the preview mirror
renders as if the selected text were replaced so following text wraps at the
same positions it will use once a final chunk commits.

If the user makes a non-empty selection after the mic transaction is already
active, YA treats that selection as a provisional replacement target for the
next non-command final speech chunk. The replacement is not committed
immediately: a final chunk that arrives within 300 ms of the selection is held
until that grace window ends. The value is an explicit speech-UI exception
authorized for this race, not a general readiness or latency delay. If the user
types, cuts, copies, pastes, or collapses the selection before the held final
chunk commits, the manual action wins and the provisional speech replacement
is cleared.

Speech providers may sentence-initial-capitalize the first word of a chunk even
when the user is replacing a lowercase word in the middle of a sentence. For
explicit selected-span replacement, YA may lowercase a title-case first word
when the selected text starts lowercase and the replacement context is not
sentence-initial. It must not do this for collapsed-cursor insertion or for
all-caps/acronym-looking words.

## Streaming Behavior

Streaming providers may emit mutable interim text, finalized chunks
(`is_final`), and utterance-final or end-of-turn events. YA commits finalized
chunks into the speech transaction as they arrive, using provider audio timing
where available to advance the insertion target.

xAI STT has two timing notions. The top-level `start`/`duration` on a partial
can identify the current segment window and remain fixed while several
separate finalized sub-chunks arrive. Word timestamps are the committed audio
span for a chunk. YA therefore uses word timestamps, when present, for the
committed cursor and uses the top-level `start` only as the segment group key.

Within one xAI segment group, a later `speech_final` partial may revise the
text made from earlier non-empty `is_final` sub-chunks. YA must not append a
tail guessed from the segment window in that case. It replaces the currently
owned text for that segment with the `speech_final` text by emitting explicit
replacement metadata to the composer.

If a later `speech_final` starts at an earlier committed segment group and its
text is no longer prefixed by the already-committed group text, YA treats it as
a correction spanning the committed groups from that start point to the current
insertion target. It replaces that owned suffix instead of slicing off only the
word-timestamp tail.

An empty finalized chunk is not committed speech. It must not clear the mutable
preview and must not advance the committed audio cursor; xAI can emit empty
`is_final` chunks before a later non-empty final chunk for the same audio span.

When Smart Turn triggers an automatic send from an endpoint event, the provider
may still deliver additional final text in its done event. YA must commit that
uncommitted tail before applying the send command metadata.

An automatic Smart Turn endpoint send is held — committed to the draft but not
submitted — once the user has manually edited the composer during the active
mic transaction. This protects a turn the user is co-authoring by hand from
being submitted out from under them by an endpoint. The hold is specific: it
applies only to the *automatic* endpoint send (carried as `smartTurnAutoSend`
in the result metadata, distinct from an explicit spoken `send`); an explicit
`send` command and a manual Enter always submit. The triggering edit must add or
delete non-whitespace text — whitespace-only changes and cursor moves do not
count — and speech-inserted finals (which reach the draft programmatically, not
through the textarea's change event) are never treated as manual edits. The hold
is scoped to the current mic transaction and resets when the next one starts.

xAI may also send one or more non-empty final partials after YA has sent
`audio.done`, then send an empty `transcript.done`. YA stages such post-stop
final partials in order and uses them only if the final done event has no text,
preserving protection against bad stop-flush partials when `transcript.done`
does contain text.

Manual stop for streaming STT is a flush/finalize operation, not cancellation.
It stops capturing new audio immediately, but final transcript updates for
audio already sent must still reach the composer and retain their Smart Turn
command metadata. Only one streaming provider request is active at a time in
the current implementation, so a reclick during streaming finalization does not
start a competing stream. Future work may make that reclick start local
prerecording immediately, buffer PCM into a new speech transaction, and open
the next provider stream only after the previous `transcript.done` resolves.
That follow-up must preserve the user's click-time insertion target and flush
the buffered audio without dropping first words.

When server-routed speech audio retention is enabled, YA persists structured
streaming transcript events next to the retained audio. The older
tab-separated text trace is kept for grepping, but the structured trace keeps
`isFinal`, `speechFinal`, `start`, `duration`, and word timestamps for replay
and reducer tests.

Spoken commands are evaluated from finalized speech, not from mutable interim
text. A command word is a trailing lexical token such as `send`, `cancel`, or
`wait`, after punctuation/quote stripping and case normalization. Recognized
command words are control tokens and are removed from the textbox — except
`wait`, which is intentionally left in place (see its bullet below).

Current streaming command semantics:

- `cancel` removes only the most recent committed final speech chunk in the
  current mic transaction and keeps recognition running.
- `wait` stops recognition, keeps committed speech text, and does not submit.
  It **holds the send even when Smart Turn's endpoint would otherwise auto-send**
  the turn. Unlike `send`/`cancel`, `wait` is recognized eagerly: it does not
  require a deliberate pause before it, because a missed `wait` prematurely
  submits the turn (the disruptive failure) while a missed `send`/`cancel`
  merely takes no action. So the pause gate that separates a spoken `send`/
  `cancel` command from dictation does not apply to `wait`. Because dropping the
  pause check means a sentence legitimately ending in the word "wait" also
  holds, `wait` is **left in the draft** (not stripped, unlike `send`): a false
  hold is then a one-click manual send with nothing lost. The `send`/`cancel`
  pause gate is 300 ms.
- `send` submits the whole composer. The initial implementation stops
  recognition after sending.
- A future "continue after command" option may let `send` submit and begin a
  fresh speech transaction without making the user press the mic again.

Open design slot: command recognition should eventually work per `is_final`
chunk after a YA command-settle signal. That settle signal may be a timeout
shorter than the Smart Turn timeout, but the value is not chosen here. Per the
speech UI timing rule, do not implement a fixed delay unless the maintainer
explicitly authorizes the value.

## Batch Behavior

Batch providers produce no streaming drafts and no mid-utterance Smart Turn.
The default batch result is "wait": insert the whole recognized transcript at
the speech transaction point, stop recognition, and do not submit.

Stopping a batch recording ends capture synchronously. The mic button must
clear its red/listening state immediately; slower upload, provider latency,
local model load, or a slow CPU plus large ASR model are post-capture
processing and must not make the mic look active.

While the batch result is pending, the composer stays fully editable. The
textarea keeps its real, visible draft and the user may type or edit anywhere,
including the spot where the pending transcript will land. The pending state is
surfaced **inline at the insertion point** — in place of any selected span —
through the same draft mirror that previews streaming interim text: a muted
`Transcribing…` label shows where the result will land. The label lives in an
aria-hidden mirror, never as characters in the textarea value, so no keystroke
or backspace can disturb or delete it. The mirror keeps the live draft visible
and the textarea editable (the caret shows through), so this is **not** the old
transparent-textarea overlay that hid the whole draft and let an accidental
backspace edit invisible text — that earlier hazard is why the label is
non-editable, not why it lives below the field. Streaming interim text and the
post-capture label share the one inline mirror; the label shows for the
no-interim waits (`processing`/`finalizing`) and during active `listening`
before any interim arrives.

### Cancel contract

Cancel during the post-capture wait is **Escape** — a deliberate key, distinct
from the accidental-backspace path the inline label must never trigger. The
mirror is non-interactive (`pointer-events: none`), so there is no inline `✕`.
Escape ends the pending speech transaction and drops its insertion target;
active `listening` still finalizes on Escape instead (keeping interim), and the
mic can still start an overlapping new recording during the wait.

The guarantee is result-suppression, not necessarily work-interruption: a
transcription that finishes after cancel must be fully inert — it inserts
nothing, replaces nothing, and triggers no send. The provider discards the late
result via its `cancel()` method (see
[pluggable-speech-recognition.md](pluggable-speech-recognition.md)). Actually
interrupting the backend request or model work is an optional optimization and
may never be implemented; the only contract is that a completed-after-cancel
result is a no-op.

### Unifying batch and streaming

Batch is a special case of streaming: one `is_final` block per mic activation,
possibly with a high startup latency (model cold-load). The pending-result wait
(`processing`) and the streaming finalize wait (`finalizing`) are the same
conceptual state at different latencies, surfaced by one inline label at the
insertion point. The distinct surface wording is deliberate and stays —
`Transcribing…` for batch, `Finalizing…` for streaming, `Listening…` during
active capture — only the mechanism unifies. The composer receives a single
pending *kind* (`listening` | `transcribing` | `finalizing`) from the mic button
and renders the matching label inline through the streaming-preview mirror.

Cancel (Escape) abandons only the in-progress, non-final portion of the active
mini-turn; already-accepted `is_final` blocks remain in the draft. For batch
there is no committed block during the wait, so cancel drops the whole pending
result. For streaming, `cancel()` discards the uncommitted preview / in-flight
tail and ignores any racing `final` (a start-token bump makes later socket
messages inert), while the `is_final` blocks already emitted to the draft stay;
this is distinct from `stop()`, which finalizes/flushes the tail.

Implemented: the inline label across the whole mic transaction — `listening`
(active capture), `processing`, and `finalizing` — plus the streaming
`cancel()`. The draft mirror surfaces `Listening…` during active capture, then
`Transcribing…` (batch) or `Finalizing…` (streaming flush) at the insertion
point; Escape cancels the post-capture wait and routes to the unified
`cancel()`. During active capture the mic button stays stop/finalize (flush the
tail and finalize); on desktop the mic's own status text and the inline label
may both read `Listening…`/`Finalizing…` (the label is the in-draft readout, the
mic status is the capture-state readout) — an accepted minor redundancy.

Open follow-up (agreed target): make the inline label an interactive tag. Each
pending batch transcription renders as its own `Transcribing… ✕` tag at its own
insertion point, placed before the cursor, in arrival order (the second lands
after the first). Each tag carries its own `✕` cancel; if per-tag proves
impractical, a single `✕` on the last/newest tag is acceptable. This restores a
pointer cancel that Escape currently stands in for. The likely path is making
just the label span interactive (`pointer-events` on the tag only) since the
mirror already positions it inline. Overlapping transcriptions are uncommon
(usually provoked by switch-latency impatience), but the ordering of their
inserts and one-label-per-pending are not yet correct for N>1 — current code
shows a single label and can insert the second result before the first.

When the batch result arrives, YA treats it as one delayed finalized streaming
chunk. It uses the speech transaction target captured at mic start, including
the originally selected replacement span, rather than whatever selection or
speech transaction is current at result time. User edits made while the batch
is pending map that target through ordinary textarea edits. A new recording may
start while the earlier batch transcription is still pending; if multiple batch
transcriptions overlap, each result must either carry a distinct speech target
or be blocked until the previous pending result has landed.

Batch supports simple whole-batch spoken commands:

- A trailing `send` word is stripped, the preceding recognized text is inserted
  at the speech transaction point, and the composer is submitted. If the batch
  transcript is only `send`, YA submits the existing composer unchanged.
- A trailing `cancel` word cancels the whole batch result. It inserts nothing
  and, when the mic started over a selection, leaves that selected text
  untouched.
- `wait` is not a batch command. If the recognizer returns a transcript ending
  in `wait`, YA treats it as dictated text because batch already defaults to
  stop-without-send.

## Stop And Escape

Clicking the active mic button or pressing the voice shortcut toggles capture
off using the provider's normal stop behavior. For xAI streaming STT, manual
stop sends `audio.done` immediately and waits for `transcript.done`. The mic
button must clear its red/listening state as soon as capture stops, but the
speech provider remains in a non-recording finalizing state until the final
response lands. YA should not treat the live interim preview as final unless
the final response fails and the preview is being salvaged. Smart
Turn/endpointing finalizes through `is_final` transcript partials, but manual
stop does not require or promise one last `is_final` partial. In the initial
implementation, Esc may duplicate that same toggle behavior when focus is in
the composer.

Proposed stronger Esc behavior: while a mic transaction is active, Esc should
remove all speech inserted since the button press and stop recognition. That
is broader than spoken `cancel`, which only removes the latest finalized
speech chunk and keeps recognition running.

## Feedback

The mic's capture readiness stays event-driven. Yellow means capture is
starting or connecting; red/listening means the active path has produced a real
listening/capture event. Spoken commands may be shown as temporary UI feedback
near the mic, such as a small command chip, but the chip is advisory UI only:
the command word still must not appear in the textarea value.
