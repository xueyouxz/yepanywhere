# Pluggable Speech Recognition Providers
> YA speech recognition should be an explicit user-selected method:
> browser-native stays as the device-local fallback, while configured YA server
> backends receive browser-captured audio for transcription or future audio
> forwarding without exposing speech credentials to clients.

Topic: pluggable-speech-recognition

See also: [direct-xai-speech.md](direct-xai-speech.md) for the hosted Grok
plan where the browser sends audio directly to xAI and YA only brokers
explicit credential/config material.
See also: [mic-button-speech-ui.md](mic-button-speech-ui.md) for the mic
button's composer insertion, selection replacement, and spoken-command
behavior across streaming and batch STT.

## Contract

- `VOICE_INPUT=false` is the master kill switch. When it is false, YA does
  not advertise voice input or server-routed speech backends.
- Server-routed backends are off unless an explicit signal enables them.
  Local/test backends (`ya-whisper`, `ya-parakeet`, `ya-dummy`) must be named in
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
- Speech readiness UI is event-driven. The mic must not turn red, show
  recording bars, or display "Listening" from a fixed delay or from a weak
  start-request acknowledgement. Use real capture/listening events from the
  active path: first Web Audio processor frame for YA-controlled PCM capture,
  browser Web Speech audio/sound/speech events for browser-native STT, and
  backend/socket events only for backend readiness. A fixed delay or warm-up
  margin may be proposed, but it requires explicit maintainer authorization
  before implementation.
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
backend-supported sample rate, and sends binary frames to the direct
`/api/speech/ws` route locally or to a dedicated secure relay `speech` channel
remotely. The relayed channel is a second WebSocket/TCP stream for speech, not
PCM multiplexed through the app/control relay socket.

Backends should implement a common `SpeechBackend` contract:

- validate credentials or local runtime readiness at startup;
- advertise only validated ids plus their capabilities;
- transcribe a complete utterance with optional `mimeType`, `prompt`, and
  `keyterms` options;
- optionally open a streaming session that accepts raw audio frames and emits
  interim/final transcript events;
- keep expensive local models warm rather than loading per utterance.

Local STT backends should use the same event contract when the model/runtime can
produce meaningful stream updates. A local model that exposes partial/final
segments, timestamps, endpoint confidence, or a confidence signal that an audio
chunk is transcribable should feed those events through the generalized
streaming path instead of inventing a separate UI flow. Offline-only models
such as a basic faster-whisper worker remain batch backends until a verified
streaming/confidence surface exists.

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
  to 16 kHz signed PCM16 little-endian, and sends binary frames to
  `/api/speech/ws`. Interim and chunk-final events update the composer
  preview; final partial events commit provider-owned transcript segments into
  the editable draft without stopping the mic, and utterance-final partials
  (`speech_final=true`) close or Smart Turn-decide the speech turn.
  For xAI-style streaming events, YA treats word timestamps as the committed
  audio span when they are present. The top-level `start` plus `duration` may
  instead describe a broader segment window that remains fixed while xAI emits
  several non-empty `is_final` sub-chunks. YA uses the top-level `start` as the
  replacement group key, uses word spans to advance the committed cursor inside
  that group, and treats a later `speech_final=true` event for the group as an
  authoritative correction of the group-owned text. If a stitched
  utterance-final event starts at an earlier committed group and no longer has
  the already-committed group text as its prefix, YA replaces the owned group
  range through explicit composer replacement metadata. If the event is merely
  cumulative and still has the committed group text as a prefix, YA keeps only
  the word-timestamp tail after the committed-audio cursor. Distinct later spans
  append even if their transcript text is identical. The streaming path must
  not dedupe or slice by substring comparison.
  The client does not infer safe sub-spans from punctuation, confidence, or
  sentence boundaries; safe-to-edit text is only the text already committed by
  provider event semantics.
  Clicking stop commits the currently visible preview before ignoring
  stop-flush partials, and the final event carries the retained transcription
  id.
  Interim streaming text is rendered through an inline textarea mirror: it wraps
  in the same visual compose plane as the committed draft and highlights the
  mutable tail, but it is not part of the textarea value. The textarea remains
  the committed draft only, so user edits do not accidentally freeze recognizer
  text that may still be revised.
  Appending committed speech deltas must not steal the textarea cursor: if the
  user is editing earlier committed text, preserve selection and scroll; if the
  cursor was already at the old end, let it follow the appended speech.
  Starting the mic also creates a speech-owned insertion range. If committed
  text is selected, YA deletes that selection first, places the cursor at the
  deletion point, and inserts final speech deltas there rather than at the end.
  User edits map the speech-owned range through ordinary textarea changes;
  edits inside that range remain part of the speech-owned text. A Smart Turn
  `wait` command leaves the range's committed text in the composer without
  sending, while `cancel` removes the range and clears the mutable preview.
  Selection restoration is tied to the committed textarea value update, not to a
  fixed UI delay.
- Backends may advertise `smartTurn: true` when their streaming API supports
  ML end-of-turn detection. Grok STT exposes this through the xAI
  `smart_turn` threshold and `smart_turn_timeout` parameters. The client shows
  Smart Turn controls only when the selected backend advertises that capability.
- Grok STT through YA has separate top-level methods for streaming and batch
  behavior. `ya-grok` captures Web Audio in the browser and sends raw 16 kHz
  PCM16 frames to YA for streaming recognition. `ya-grok-batch` uses the
  browser's MediaRecorder output and the batch transcription route. Smart Turn
  depends on streaming `speech_final` events and is therefore only active for
  methods whose capabilities advertise both `streaming` and `smartTurn`.
- `useSpeechRecognition` selects browser-native when the method is
  `browser-native`; `xai-grok-direct-streaming` constructs a direct xAI
  streaming provider; `xai-grok-direct-batch` constructs a direct xAI batch
  provider; advertised server backend ids construct `YaServerProvider`
  unchanged.
- The client speech-method selector is data-driven from
  `/api/version.voiceBackends`, the special browser-native fallback, and direct
  xAI client methods only when direct xAI can run: either `ya-grok` is
  advertised or this browser has a local xAI STT key. It does not keep a
  client-side whitelist of server backend ids; unknown advertised ids remain
  selectable and route through YA unchanged.
- `NewSessionForm` and the active session composer toolbar build
  speech-method dropdowns from the same advertised active backend list. The
  dropdown is shown only when more than one method is available.
- `useModelSettings` persists a server-scoped `speechMethod`. When there is
  no explicit local choice, server-learned `clientDefaults.speech` from
  `/api/version` supplies the client default. Speech setting changes write both
  the local explicit value and a partial server client-default update so a later
  browser with no explicit local override inherits the most recent UI choice.
  If neither local nor server default exists, the effective runtime default
  prefers direct Grok streaming when `ya-grok` is configured, otherwise active
  server-routed STT over browser-native, with `ya-deepgram` ranked ahead of
  unknown server backends. Browser-native remains the explicit local escape
  hatch.
- Server config parses `VOICE_INPUT`, `YA_VOICE_BACKENDS`,
  `YA_stt__DEEPGRAM_API_KEY`, `YA_stt__XAI_API_KEY`, `XAI_API_KEY`,
  `WHISPER_MODEL`, `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE`,
  `PARAKEET_MODEL`, and `PARAKEET_DEVICE`.
  `YA_stt__XAI_API_KEY` takes precedence for `ya-grok`; `XAI_API_KEY` is a
  convenience fallback that is scrubbed from `process.env` after config load.
- `SpeechBackendRegistry` supports `ya-dummy`, `ya-deepgram`,
  `ya-grok`, `ya-whisper`, and `ya-parakeet`; it validates configured backends and
  exposes enabled ids plus capability metadata to `/api/version`.
- `ya-grok` posts batch multipart audio to xAI's `POST /v1/stt`
  endpoint and implements xAI's `wss://api.x.ai/v1/stt` streaming endpoint.
  In streaming mode it can enable Smart Turn and pass through xAI word
  timestamps so the client can recognize optional paused end commands.
  Both cloud backends auto-enable when their key is present
  (`YA_stt__XAI_API_KEY` or scrubbed `XAI_API_KEY` for `ya-grok`,
  `YA_stt__DEEPGRAM_API_KEY` for `ya-deepgram`) because providing a metered key
  is the operator's explicit opt-in. `ya-grok` is currently the only backend
  advertising streaming.
- Deepgram and local faster-whisper backend implementations exist. The local
  Whisper path uses a warm Python worker subprocess around `faster_whisper`.
  The local Parakeet path uses the same pixi `stt` environment with a separate
  Transformers/PyTorch bootstrap and a warm Python worker around
  `pipeline("automatic-speech-recognition")`. The browser can choose the
  Parakeet model id per request from STT settings or the mic options panel; the
  server `PARAKEET_MODEL` remains the fallback for clients that send no model.
  The implemented presets are limited to Hugging Face model cards that document
  Transformers pipeline usage: `nvidia/parakeet-tdt-0.6b-v3` and
  `nvidia/parakeet-ctc-1.1b`. The backend is batch-only until a local
  streaming/chunking surface is proven.
- The normal `index.ts` runtime mounts `/api/speech` after
  `createNodeWebSocket()` creates the shared `upgradeWebSocket` helper.
- `createSpeechRoutes` implements `POST /api/speech/transcribe` for batch
  transcription and `GET /api/speech/ws` for both buffered WebSocket
  transcription and streaming transcription to capable backends. The WS route
  accepts JSON control frames even when the unified Node WS path presents text
  frames as `Buffer`s. Streaming metadata includes the ordered transcript trace
  as one recognizer event per line.
- `createSpeechRoutes` also exposes direct xAI credential brokering:
  `/api/speech/xai-client-secret` mints a short-lived xAI client secret for
  browser WebSocket streaming to `/v1/stt`, while
  `/api/speech/xai-client-key` returns the long-lived STT key only when
  `YA_stt__SHARE_XAI_KEY_WITH_CLIENTS=1` enables direct batch borrowing.
- `xai-grok-direct-streaming` reuses the YA Web Audio PCM16 capture path but
  opens `wss://api.x.ai/v1/stt` directly from the browser with
  `Sec-WebSocket-Protocol: xai-client-secret.*`. `xai-grok-direct-batch`
  records a complete `MediaRecorder` utterance and posts it directly to
  `POST /v1/stt`, so it emits final text only.
- The browser-local xAI STT key field is always reachable from STT settings and
  from the mic-button speech options. Saving a non-empty browser key updates
  the method list locally and can make direct Grok streaming the selected
  default even when the YA server advertises no Grok STT backend.
- YA-controlled and direct xAI STT paths share one browser mic capture owner
  when Keep Mic Warm is enabled. The shared stream is keyed by the selected mic
  device, requests the same raw speech constraints for batch and streaming
  paths (mono / 16 kHz / 16-bit ideals, echo cancellation, noise suppression,
  and auto gain off), survives provider disposal during STT backend switches,
  and is released when Keep Mic Warm is disabled or the selected mic changes.
- Browser-native STT does not consume YA's shared mic stream: Chrome owns the
  Web Speech capture path. Its UI treats `SpeechRecognition.onstart` only as a
  start acknowledgement; red/listening state waits for Web Speech
  audio/sound/speech start events or for a result event if Chrome skips the
  earlier events.
- Hosted/relay clients can stream to server STT through a dedicated secure
  relay `speech` channel. The server registers that channel separately from the
  app channel under the same relay username/install id, the browser opens a
  second relayed WebSocket, resumes the same YA remote-access session on it,
  sends speech controls as encrypted JSON, and sends PCM frames as encrypted
  binary speech-audio frames.
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
- `/api/speech/ws` remains the direct/local streaming endpoint. Relay streaming
  uses the dedicated secure relay `speech` channel instead of trying to route a
  raw browser WebSocket through the hosted app origin.
- Previously selected server methods are reconciled against current
  `voiceBackends` before the mic button is used. If an explicit server backend
  disappears, the current resolver falls back to browser-native rather than
  silently choosing another server backend; a one-time notice or re-pick prompt
  is still a UI follow-up.
- The current UI setting is a server-learned client default plus local override,
  not a true per-session speech method. The original plan's per-new-session
  override is not persisted as session metadata or passed through message
  submission.
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
- The current Smart Turn end-command recipe is deliberately simple: when Grok
  returns `speech_final=true`, a final `send`, `cancel`, or `wait` word only
  acts as a command if word timestamps show a pause longer than 500 ms before
  it; otherwise the word remains part of the dictated message. If no command is
  recognized, the action defaults to `send`. This fixed pause rule is ripe for
  improvement: a future model-side judge could decide whether the word is
  likely intended as message content or as an end command, including cases with
  a smaller pause. Do not build that extra judging layer until we have traces
  that justify it.
- Direct Grok streaming has a browser WebSocket auth probe and focused client
  tests for the xAI socket adapter, but it still needs a live
  browser-plus-xAI smoke test with a real microphone or captured audio source.
- Switching speech methods no longer intentionally tears down the warmed
  YA-controlled mic stream. If Chrome still pays a later cold-open cost after a
  backend switch, treat it as a browser/device behavior to measure, not a
  provider-disposal consequence.
- Live browser-native testing dropped the first second of "1 2 3 4..." after
  Chrome had fired `SpeechRecognition.onstart`; YA therefore does not treat
  `onstart` as a red/listening event. Browser-native remains a fallback whose
  capture and first-word behavior are owned by Chrome, not YA. Grok PCM
  streaming through YA appears reliable in live `ya.graehl.org` testing,
  likely because YA buffers PCM frames while the socket/provider handshake
  finishes.
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
6. Re-check current provider audio-input support before implementing
   audio-as-modality. Providers that accept audio should get the original
   audio content, while text-only providers keep the transcript-first path.

## Server-Local STT Deployment Plan

Server-local STT is still a first-class reason to keep the YA-mediated speech
flow. The hosted Grok path should prefer browser-to-xAI when browser-safe auth
is acceptable, but a local recognizer is different: the model and its warm
state live on the YA host, so browser audio must go to YA.

Deploy it in stages:

1. **Batch first, streaming later.** Make `ya-whisper` reliable for
   press-to-talk batch transcription through `POST /api/speech/transcribe`
   before attempting local streaming partials. A complete utterance is enough
   for local Whisper's natural operating mode; local streaming requires VAD or
   chunk-stitching and should not block the first usable server-local release.
2. **Use the existing warm worker as the first runtime.** Start with the
   current `faster-whisper` subprocess (`whisper_worker.py`) because it already
   matches YA's backend contract and keeps the model loaded. Treat
   `whisper.cpp` or another runtime as a swappable backend implementation only
   if deployment friction, CPU performance, or packaging makes
   `faster-whisper` the wrong choice.
   Parakeet is a plausible alternate local recognizer, especially if current
   Hugging Face / Transformers support keeps installation lighter than a full
   NeMo stack. Do not wire it directly into the YA Node runtime first: the
   Rocky 8 host has old glibc and an old/easy Docker path may not match modern
   NVIDIA container assumptions. Spike it in an isolated Python environment or
   pinned container, verify CUDA/PyTorch compatibility on the L40S, and expose
   it behind the same warm-worker `SpeechBackend` boundary only if install plus
   cold/warm latency beats `faster-whisper` for this server.
3. **Ship explicit operator configuration.** The opt-in is
   `YA_VOICE_BACKENDS=ya-whisper` or `YA_VOICE_BACKENDS=ya-parakeet`. The backend is pixi-only in the first
   implementation: the YA checkout commits a `stt` pixi environment, and the
   server validates the backend by importing the required Python packages; if
   that import probe fails for an explicitly enabled local backend, startup runs
   the matching pixi bootstrap task once (`stt-bootstrap` for `ya-whisper`,
   `stt-bootstrap-parakeet` for `ya-parakeet`) and then probes again. Runtime
   validation and the warm worker use `pixi run --frozen -e stt python`, not
   ambient `python3`, so old system Python cannot accidentally become the ASR
   runtime. Parakeet validation also loads the configured fallback model at
   startup; if Hugging Face auth, model access, cache space, or model loading is
   broken, YA logs repair hints and does not advertise `ya-parakeet` to the UI.
   Model/runtime knobs stay server-local for Whisper:
   `WHISPER_MODEL`, `WHISPER_DEVICE`, and `WHISPER_COMPUTE_TYPE`. For
   Parakeet, `PARAKEET_MODEL` is the server fallback, `PARAKEET_DEVICE` is the
   server device policy, and authenticated browser UI may send a per-request
   model id for the same worker. Whisper's default should remain CPU-safe
   (`device=cpu`, `compute_type=int8`). Parakeet defaults to the current
   NVIDIA Transformers model (`nvidia/parakeet-tdt-0.6b-v3`) with
   `PARAKEET_DEVICE=auto`, which lets the worker choose CUDA when available
   without making CUDA a startup requirement.
4. **Add a readiness surface before advertising.** Startup validation should
   confirm pixi exists, the `stt` environment is already bootstrapped,
   `faster_whisper` imports, the configured model can load, and a tiny known
   audio sample transcribes within an acceptable timeout. Only then should
   `/api/version.voiceBackends` advertise `ya-whisper`. Failures should be
   actionable in logs: missing pixi, stale/missing pixi lock or environment,
   missing package, missing model/cache, unsupported device/compute type, or
   model-load timeout. The YA server should still start with a requested local
   backend disabled if bootstrap or validation fails; deploy wrappers may
   choose to run `stt-bootstrap`/`stt-check` as a strict preflight and abort
   before launching YA.
5. **Make model warm-up observable.** The first utterance may legitimately pay
   model-load cost, but the UI and logs should distinguish "loading local STT
   model" from ordinary recognition. Record model name, device, compute type,
   cold-load duration, and per-utterance real-time factor in server logs and
   retained metadata.
6. **Keep audio retention useful for tuning.** Retained audio plus sidecar
   transcript metadata is especially valuable for local STT. The sidecar
   should include model/runtime settings and biasing prompt/keyterms so bad
   transcriptions can be reproduced after changing model size or prompt
   construction.
7. **Add biasing before optimizing streaming.** Local Whisper's biggest YA
   advantage is project/session context. Implement `buildBiasingContext()` and
   feed its prompt into Whisper before spending effort on local streaming
   partials.
8. **Verify with a fixed audio fixture and one live mic pass.** The deployment
   smoke should cover a generated/checked-in short utterance, an empty/silence
   file, and one browser capture. Acceptance is: backend advertised only when
   ready, first request may be cold but succeeds or reports a clear error,
   subsequent requests reuse the worker, and transcription metadata records the
   runtime settings.

### Local STT pixi bootstrap

The committed pixi environment is intentionally not part of the normal
Node/PNPM install. To enable local Whisper on a server:

1. Install pixi on the host.
2. Either let YA run the relevant bootstrap task when the backend is explicitly
   enabled, or preflight it manually from the YA checkout:
   - `pixi run -e stt stt-bootstrap` for `ya-whisper`;
   - `pixi run -e stt stt-bootstrap-parakeet` for `ya-parakeet`;
   - `pixi run -e stt stt-bootstrap-all` for both.
   These commands create the `stt` environment from `pixi.lock` and install the
   relevant Python requirements file(s).
3. Start YA with `YA_VOICE_BACKENDS` containing `ya-whisper`, `ya-parakeet`, or
   both.

For the private `reyep` helper, the local-STT switch should be set-union logic,
not assignment. A `YA_LOCAL_STT=1 reyep`-style wrapper should append
`ya-whisper` only when the current comma-separated `YA_VOICE_BACKENDS` does not
already contain it. Cloud STT backends still auto-enable from their
`YA_stt__*` keys; the wrapper must not read or print those keys.

Parakeet reuses this deployment shape through `requirements/stt-parakeet.txt`
and `stt-bootstrap-parakeet`. The YA server runs that bootstrap only after the
operator explicitly names `ya-parakeet`; a deploy wrapper may still choose to
run the pixi bootstrap as a stricter preflight.

Current Parakeet support is intentionally Transformers-only. The desired next
track is a NeMo-backed local Parakeet worker so
`nvidia/parakeet-unified-en-0.6b` can become the local default if it verifies:
its model card reports stronger offline accuracy and streaming quality up to
roughly 240 ms latency, but it documents NeMo 2.7.3 rather than the
Transformers pipeline. That NeMo worker should also evaluate
`nvidia/parakeet-rnnt-1.1b` for lower-case English, and any NIM/NGC
multilingual RNNT variant only if there is a host-installable local runtime
that fits the Rocky 8 / pixi deployment constraints.

Hosted relay support for server-local STT is a product choice, not a technical
requirement. If the operator wants phone-to-local-Whisper dictation through
YA, the existing batch YA API path is the safer first target; relayed streaming
to a local model remains a later optimization after local batch is solid.

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
  chunk-final events commit locked deltas into the draft, and the final event
  includes the retained transcription id.
- With `YA_stt__XAI_API_KEY` exported, the version response advertises
  `voiceBackendCapabilities["ya-grok"].smartTurn: true`. Selecting Grok STT
  shows Smart Turn threshold and timeout controls; selecting browser-native,
  Deepgram, Whisper, or dummy hides those controls unless that backend later
  advertises `smartTurn: true`.
- With Grok Smart Turn enabled, `speech_final=true` commits any remaining
  uncommitted delta, stops the streaming recognizer, and then applies a paused
  final command:
  `send` submits, `cancel` discards the speech turn, and `wait` leaves the
  draft for keyboard editing or thought. No recognized command defaults to
  `send`.
- With `Grok STT through YA` selected, the WebSocket start frame advertises
  `mimeType: "audio/pcm;rate=16000;encoding=s16le"`, `sampleRate: 16000`, and
  `encoding: "pcm"`. `Grok STT through YA batch` uses the MediaRecorder batch
  path and hides Smart Turn because that path has no streaming `speech_final`
  events.
- With both `ya-grok` and `ya-deepgram` advertised and no explicit stored
  speech method, the client selects `Grok STT direct` as the effective mic
  backend. The through-YA Grok methods remain explicit fallback/debug choices.
- A successful server-routed transcription emits positive-path logs naming the
  backend and audio metadata without logging transcript text.
- A successful server-routed transcription writes retained audio plus metadata
  under the configured data directory by default, and the metadata contains the
  returned transcript plus session/client-turn pointers when the client has
  supplied them.
- A successful streaming transcription writes each interim update, chunk-final
  partial, speech-final marker, and final done transcript into retained
  metadata as an ordered one-line-per-event trace.
- With an advertised backend id not hardcoded in the client, the selector still
  displays that id generically and sends it unchanged as `backendId`.
- With `YA_VOICE_BACKENDS=ya-whisper` and `faster_whisper` importable, startup
  validation advertises `ya-whisper`; the first utterance warms the model once
  and later utterances reuse the worker.
- With `YA_VOICE_BACKENDS=ya-parakeet`, the Parakeet Transformers runtime
  importable, and the configured fallback model loadable, startup validation
  advertises `ya-parakeet`; otherwise it logs the cache/auth/model-load repair
  hint and hides the backend from the UI. Choosing a different Parakeet model
  in STT settings or mic options sends that model id to `/api/speech/transcribe`
  and restarts the warm worker for the new model.
- Removing a previously selected backend causes an explicit method-selection
  prompt or notice, not a silent fallback and not a dead mic button.
