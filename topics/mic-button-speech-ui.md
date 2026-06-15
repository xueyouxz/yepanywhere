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

## Streaming Behavior

Streaming providers may emit mutable interim text, finalized chunks
(`is_final`), and utterance-final or end-of-turn events. YA commits finalized
chunks into the speech transaction as they arrive, using provider audio timing
where available to advance the insertion target.

Spoken commands are evaluated from finalized speech, not from mutable interim
text. A command word is a trailing lexical token such as `send`, `cancel`, or
`wait`, after punctuation/quote stripping and case normalization. Recognized
command words are control tokens and must not be inserted into the textbox.

Current streaming command semantics:

- `cancel` removes only the most recent committed final speech chunk in the
  current mic transaction and keeps recognition running.
- `wait` stops recognition, keeps committed speech text, and does not submit.
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
off using the provider's normal stop behavior. In the initial implementation,
Esc may duplicate that same toggle behavior when focus is in the composer.

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
