# Pluggable Speech Recognition Providers
> YA speech recognition should be an explicit user-selected method:
> browser-native stays as the device-local fallback, while configured YA server
> backends receive browser-captured audio for transcription or future audio
> forwarding without exposing speech credentials to clients.

Topic: pluggable-speech-recognition

## Contract

- `VOICE_INPUT=false` is the master kill switch. When it is false, YA does
  not advertise voice input or server-routed speech backends.
- Server-routed backends are off unless an explicit signal enables them.
  Local/test backends (`ya-whisper`, `ya-dummy`) must be named in
  `YA_VOICE_BACKENDS`; cloud backends (`ya-deepgram`, `ya-grok`) auto-enable
  when their YA-scoped key is provided, since providing a metered key is the
  operator's explicit opt-in. Only backends that pass startup validation are
  advertised through `/api/version` as `voiceBackends`.
- Browser-native Web Speech recognition is a selectable local escape hatch,
  not a YA server backend. The browser still owns its recognizer, credentials,
  latency, and failure modes.
- The user chooses among advertised methods. YA should not silently fall back
  from one configured server method to another, and it should not auto-enable
  a backend merely because its code exists — enablement requires an explicit
  signal: a `YA_VOICE_BACKENDS` entry, or a provided cloud key.
- OS keyboard dictation is outside YA's speech stack. If the user taps the
  keyboard's mic glyph, that is device-native text entry, not YA-mediated
  speech recognition.
- Server-mediated recognition is valuable only if it buys something browser
  native cannot: server-side keys, backend choice, project/session biasing,
  retry/buffering under YA's transport, or direct audio input to an
  audio-capable agent provider.
- YA-server recognition keeps an audit trail by default. Captured speech audio
  is retained for eight weeks or 400 MB, whichever limit prunes it first, using
  a speech-appropriate compressed browser recording such as Opus/WebM. Each
  retained utterance has sidecar metadata that includes backend id, MIME type,
  byte size, timing, transcript text, the ordered streaming recognizer trace
  when available, and the best available session plus client-turn pointer. This
  is intentionally useful for local speech-model fine-tuning,
  transcription-quality audits, and debugging backend selection.
- Ordinary server logs should identify the selected speech backend, request
  source, audio size, MIME type, session/turn pointer, duration, transcript
  character count, and retention result. Logs must not include the transcript
  text itself; retained metadata is the place where transcript text belongs.

## Intended Architecture

The browser-native path uses `SpeechRecognition` /
`webkitSpeechRecognition`. YA receives only transcript text and appends it to
the composer as if the user had typed it.

The YA-server path captures audio in the browser and has the server dispatch it
to the selected backend. Backends advertise optional capabilities alongside
their ids; `streaming: true` means the client may use YA's streaming speech
WebSocket instead of the batch POST path. Batch transcription records
speech-appropriate compressed audio with `MediaRecorder`, buffers until stop,
then sends the complete utterance through YA's ordinary API transport so local,
hosted, and relay clients share the same request path. Streaming transcription
captures Web Audio samples, converts them to raw PCM16 little-endian at a
backend-supported sample rate, and sends binary frames to `/api/speech/ws`.

Backends should implement a common `SpeechBackend` contract:

- validate credentials or local runtime readiness at startup;
- advertise only validated ids plus their capabilities;
- transcribe a complete utterance with optional `mimeType`, `prompt`, and
  `keyterms` options;
- optionally open a streaming session that accepts raw audio frames and emits
  interim/final transcript events;
- keep expensive local models warm rather than loading per utterance.

## Implemented

- Client speech capture was refactored behind a `SpeechProvider` interface.
  `BrowserNativeProvider` owns the Web Speech state machine, explicit
  language setting, interim/final result handling, mobile cumulative-final
  deduplication, and auto-restart behavior.
- `YaServerProvider` captures microphone audio with `MediaRecorder`, buffers a
  complete utterance, and posts it to `/api/speech/transcribe` through the
  shared client API helper. Remote/SecureConnection clients therefore use the
  same transport as ordinary YA API calls.
- When the selected server backend advertises `streaming: true`,
  `YaServerProvider` captures microphone audio through Web Audio, downsamples it
  to 24 kHz signed PCM16 little-endian, and sends binary frames to
  `/api/speech/ws`. Non-final events update the composer preview; final-ish
  streaming partials commit transcript deltas so later interim clears cannot
  erase already accepted speech. The final event carries the retained
  transcription id.
- `useSpeechRecognition` selects browser-native when the method is
  `browser-native`; any other method constructs `YaServerProvider` with the
  advertised backend id unchanged.
- The client speech-method selector is data-driven from
  `/api/version.voiceBackends` plus the special browser-native fallback. It
  does not keep a client-side whitelist of server backend ids; unknown
  advertised ids remain selectable and route through YA unchanged.
- `NewSessionForm` and the active session composer toolbar build
  speech-method dropdowns from the same advertised active backend list. The
  dropdown is shown only when more than one method is available.
- `useModelSettings` persists a server-scoped `speechMethod`. When there is
  no explicit stored choice, the effective runtime default prefers active
  server-routed STT over browser-native, with `ya-grok` ranked before
  `ya-deepgram`; browser-native remains the explicit local escape hatch.
- Server config parses `VOICE_INPUT`, `YA_VOICE_BACKENDS`,
  `YA_stt__DEEPGRAM_API_KEY`, `YA_stt__XAI_API_KEY`, `WHISPER_MODEL`,
  `WHISPER_DEVICE`, and `WHISPER_COMPUTE_TYPE`.
- `SpeechBackendRegistry` supports `ya-dummy`, `ya-deepgram`,
  `ya-grok`, and `ya-whisper`; it validates configured backends and
  exposes enabled ids plus capability metadata to `/api/version`.
- `ya-grok` posts batch multipart audio to xAI's `POST /v1/stt`
  endpoint and implements xAI's `wss://api.x.ai/v1/stt` streaming endpoint.
  Both cloud backends auto-enable when their YA-scoped key is present
  (`YA_stt__XAI_API_KEY` for `ya-grok`, `YA_stt__DEEPGRAM_API_KEY` for
  `ya-deepgram`) because providing a metered key is the operator's explicit
  opt-in. `ya-grok` is currently the only backend advertising streaming.
- Deepgram and local faster-whisper backend implementations exist. The local
  Whisper path uses a warm Python worker subprocess around `faster_whisper`.
- The normal `index.ts` runtime mounts `/api/speech` after
  `createNodeWebSocket()` creates the shared `upgradeWebSocket` helper.
- `createSpeechRoutes` implements `POST /api/speech/transcribe` for batch
  transcription and `GET /api/speech/ws` for both buffered WebSocket
  transcription and streaming transcription to capable backends. The WS route
  accepts JSON control frames even when the unified Node WS path presents text
  frames as `Buffer`s. Streaming metadata includes the ordered transcript trace
  as one recognizer event per line.
- Tests cover registry defaults, explicit backend advertisement, disabled
  voice input, `/api/version.voiceBackends`, HTTP batch transcription, and the
  dummy backend through the mounted WebSocket route.

## Current Remaining Gaps

The 2026-05-30 wiring audit found three end-to-end blockers: the real server
did not mount speech routes, the client stripped the `ya-` backend prefix, and
the client used a raw same-origin WS that bypassed YA's remote transport. The
current implementation fixes those blockers for batch transcription by
mounting `/api/speech`, preserving backend ids, and routing the production
client through `fetchJSON("/speech/transcribe", ...)`.

- With no cloud STT keys and an empty `YA_VOICE_BACKENDS`, a server advertises
  `voiceInput` but `voiceBackends: []`, causing the UI to expose only
  browser-native recognition. Seeing device-native speech on mobile is
  therefore expected in that bare runtime.
- The `/api/speech/ws` route is still a direct WebSocket endpoint for local
  use and Grok streaming. It is not itself multiplexed through the secure
  remote transport; the batch POST path remains the remote-compatible path.
- Previously selected server methods are reconciled against current
  `voiceBackends` before the mic button is used. If an explicit server backend
  disappears, the current resolver falls back to browser-native rather than
  silently choosing another server backend; a one-time notice or re-pick prompt
  is still a UI follow-up.
- The current UI setting is a global default, not a true per-session speech
  method. The original plan's per-new-session override is not persisted as
  session metadata or passed through message submission.
- Audio retention settings exist conceptually as a global option: enable/disable
  saving, age limit, and size limit. The UI for changing those limits is a
  follow-up, but the runtime default is enabled with the eight-week / 400 MB
  retention contract above.
- Backend biasing is not wired. There is no `buildBiasingContext()` helper
  feeding Whisper `initial_prompt` or Deepgram `keyterm` values from project
  and session context.
- Deepgram streaming partials are not implemented. Deepgram, Whisper, and dummy
  backends still use batch transcription unless a future backend explicitly
  implements the streaming extension.
- Grok streaming has focused route tests, but it still needs a live
  browser-plus-xAI smoke test with a real microphone or captured audio source.
- Audio-as-modality forwarding to providers that natively accept audio is not
  implemented. All current YA-server backend code is transcript-first.

## Remaining Plan

1. Surface a one-time notice or explicit re-pick prompt when a stored server
   `speechMethod` is no longer advertised.
2. Decide whether speech method is global-only for the first usable release or
   truly per-session. If per-session, persist it with session metadata and pass
   the session context into speech requests.
3. Add UI for global speech-audio retention settings. The first implementation
   may use the default eight-week / 400 MB contract without exposing controls.
4. Add `buildBiasingContext(session, project)` and thread its output into
   Deepgram keyterms and Whisper initial prompts.
5. Add backend-specific streaming partials beyond Grok where the backend
   supports them. Deepgram is the next candidate; local Whisper needs chunking
   or VAD and should remain a follow-up.
6. Decide whether future streaming audio should use the existing direct
   `/api/speech/ws` endpoint only for local clients or gain an explicit secure
   remote substream.
7. Re-check current provider audio-input support before implementing
   audio-as-modality. Providers that accept audio should get the original
   audio content, while text-only providers keep the transcript-first path.

## Verification Checklist

- With no cloud keys and empty `YA_VOICE_BACKENDS`, `/api/version` returns
  `voiceBackends: []`, the selector is hidden, and browser-native remains the
  only YA mic method.
- With `YA_VOICE_BACKENDS=ya-dummy`, `/api/version.voiceBackends` includes
  `ya-dummy`, the selector appears, and choosing it posts `backendId:
  "ya-dummy"` to `/api/speech/transcribe`.
- The dummy backend returns a deterministic transcript through both
  `POST /api/speech/transcribe` and the mounted local `/api/speech/ws` route.
- Remote clients use the existing `fetchJSON` / `SecureConnection` path for
  batch transcription; direct WS streaming needs a separate remote transport
  decision before it is treated as a remote-supported path.
- With `YA_stt__DEEPGRAM_API_KEY` present, startup validation auto-enables and
  advertises `ya-deepgram`; with a missing or rejected key, it does not.
- With `YA_stt__XAI_API_KEY` exported in the YA server environment,
  `/api/version.voiceBackends` includes `ya-grok`, and a short batch
  transcription through `/api/speech/transcribe` returns text or a provider
  error from xAI.
- With `YA_stt__XAI_API_KEY` exported in the YA server environment,
  `/api/version.voiceBackendCapabilities["ya-grok"].streaming` is true, the
  client uses `/api/speech/ws` for Grok STT, interim events update the composer,
  and the final event includes the retained transcription id.
- With both `ya-grok` and `ya-deepgram` advertised and no explicit stored
  speech method, the client selects `ya-grok` as the effective mic backend.
- A successful server-routed transcription emits positive-path logs naming the
  backend and audio metadata without logging transcript text.
- A successful server-routed transcription writes retained audio plus metadata
  under the configured data directory by default, and the metadata contains the
  returned transcript plus session/client-turn pointers when the client has
  supplied them.
- A successful streaming transcription writes each interim update, final-ish
  partial, speech-final marker, and final done transcript into retained
  metadata as an ordered one-line-per-event trace.
- With an advertised backend id not hardcoded in the client, the selector still
  displays that id generically and sends it unchanged as `backendId`.
- With `YA_VOICE_BACKENDS=ya-whisper` and `faster_whisper` importable, startup
  validation advertises `ya-whisper`; the first utterance warms the model once
  and later utterances reuse the worker.
- Removing a previously selected backend causes an explicit method-selection
  prompt or notice, not a silent fallback and not a dead mic button.
