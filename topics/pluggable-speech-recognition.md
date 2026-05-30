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

## Intended Architecture

The browser-native path uses `SpeechRecognition` /
`webkitSpeechRecognition`. YA receives only transcript text and appends it to
the composer as if the user had typed it.

The YA-server path captures audio in the browser with `MediaRecorder` and has
the server dispatch the utterance to the selected backend. The first usable
shape is press-to-talk batch transcription: chunks are buffered until stop,
then the backend returns a final transcript. The production client submits the
complete utterance through YA's ordinary API transport so local, hosted, and
relay clients share the same request path. The `/api/speech/ws` route remains
available for direct/local tests and future streaming partials.

Backends should implement a common `SpeechBackend` contract:

- validate credentials or local runtime readiness at startup;
- advertise only validated ids;
- transcribe a complete utterance with optional `mimeType`, `prompt`, and
  `keyterms` options;
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
  exposes enabled ids to `/api/version`.
- `ya-grok` posts batch multipart audio to xAI's `POST /v1/stt`
  endpoint. Both cloud backends auto-enable when their YA-scoped key is
  present (`YA_stt__XAI_API_KEY` for `ya-grok`, `YA_stt__DEEPGRAM_API_KEY`
  for `ya-deepgram`) because providing a metered key is the operator's
  explicit opt-in.
- Deepgram and local faster-whisper backend implementations exist. The local
  Whisper path uses a warm Python worker subprocess around `faster_whisper`.
- The normal `index.ts` runtime mounts `/api/speech` after
  `createNodeWebSocket()` creates the shared `upgradeWebSocket` helper.
- `createSpeechRoutes` implements `POST /api/speech/transcribe` for batch
  transcription and `GET /api/speech/ws` for buffered WebSocket transcription.
  The WS route accepts JSON control frames even when the unified Node WS path
  presents text frames as `Buffer`s.
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
- YA-server recognition is batch-final only in the production client. There are
  no server-side interim transcripts yet.
- The `/api/speech/ws` route is still a direct WebSocket endpoint for local
  use and future streaming work. It is not itself multiplexed through the
  secure remote transport; the batch POST path is the remote-compatible path.
- Previously selected server methods are reconciled against current
  `voiceBackends` before the mic button is used. If an explicit server backend
  disappears, the current resolver falls back to browser-native rather than
  silently choosing another server backend; a one-time notice or re-pick prompt
  is still a UI follow-up.
- The current UI setting is a global default, not a true per-session speech
  method. The original plan's per-new-session override is not persisted as
  session metadata or passed through message submission.
- Backend biasing is not wired. There is no `buildBiasingContext()` helper
  feeding Whisper `initial_prompt` or Deepgram `keyterm` values from project
  and session context.
- Deepgram streaming partials are not implemented. The current route batches
  audio until stop and calls `transcribe()`.
- Audio-as-modality forwarding to providers that natively accept audio is not
  implemented. All current YA-server backend code is transcript-first.

## Remaining Plan

1. Surface a one-time notice or explicit re-pick prompt when a stored server
   `speechMethod` is no longer advertised.
2. Decide whether speech method is global-only for the first usable release or
   truly per-session. If per-session, persist it with session metadata and pass
   the session context into speech requests.
3. Add `buildBiasingContext(session, project)` and thread its output into
   Deepgram keyterms and Whisper initial prompts.
4. After batch transcription works, add backend-specific streaming partials
   where the backend supports them. Deepgram is the first candidate; local
   Whisper needs chunking or VAD and should remain a follow-up.
5. Decide whether future streaming audio should use the existing direct
   `/api/speech/ws` endpoint only for local clients or gain an explicit secure
   remote substream.
6. Re-check current provider audio-input support before implementing
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
- With both `ya-grok` and `ya-deepgram` advertised and no explicit stored
  speech method, the client selects `ya-grok` as the effective mic backend.
- With an advertised backend id not hardcoded in the client, the selector still
  displays that id generically and sends it unchanged as `backendId`.
- With `YA_VOICE_BACKENDS=ya-whisper` and `faster_whisper` importable, startup
  validation advertises `ya-whisper`; the first utterance warms the model once
  and later utterances reuse the worker.
- Removing a previously selected backend causes an explicit method-selection
  prompt or notice, not a silent fallback and not a dead mic button.
