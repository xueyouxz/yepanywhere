# Direct xAI Speech
> Hosted Grok STT should send browser-captured audio directly to xAI when the
> operator accepts client-held xAI credentials, leaving YA to provide only
> explicit key/config brokering and transcript integration.

Topic: direct-xai-speech

## Contract

Direct xAI speech is the immediate hosted Grok relief path. It is not a
replacement for YA-mediated speech in general:

- **Hosted Grok prefers browser -> xAI.** For xAI STT, sending audio through
  browser -> relay -> YA server -> xAI adds latency and failure surface without
  much benefit in the private-server deployment. The browser already has
  outbound HTTPS/WSS connectivity to xAI. When the server advertises `ya-grok`,
  the client defaults to direct Grok streaming because an authenticated private
  client can use either its browser-local key or a server-minted short-lived
  xAI client secret without exposing the long-lived server key.
- **Server-local STT stays YA-mediated.** Local Whisper or another recognizer
  running on the YA host still requires browser audio to reach YA. The
  server-mediated flow remains important for local models, audit/tuning,
  biasing, and future audio-as-modality work.
- **Relay-to-server speech remains future work.** The dedicated relayed speech
  channel is not working end to end today. It should not block hosted Grok
  usability, but it remains valuable for phone-to-local-Whisper and other
  server-local recognizers.
- **Credential delegation is explicit.** A server-provided xAI STT credential
  is a client-borrowed credential: authenticated private YA clients may receive
  either a short-lived xAI client secret or, only with a stronger opt-in, the
  long-lived STT key. Public/shared views must never receive either.
- **Public shares spend no server STT credits.** Secret-link public viewers are
  read-only and unauthenticated. They must not get server-mediated STT, relayed
  speech channels, server-minted xAI client secrets, or borrowed long-lived xAI
  keys. A public viewer using a browser-local personal xAI key would be outside
  YA server credit delegation.
- **Browser-local personal key is supported.** A client may configure its own
  xAI key in browser-local storage instead of borrowing server credentials.
  That browser-local key is not sent to the YA server. Once the browser has a
  non-empty local key, direct Grok streaming is selectable even if the YA server
  has no xAI STT key and therefore does not advertise `ya-grok`.
- **Upstream default is no key exposure.** Sharing a server STT key with
  clients must be an explicit operator setting, not implied by
  `YEP_STT_XAI_API_KEY` existing. Minting a short-lived xAI client secret for
  authenticated private clients does not reveal the long-lived key. Long-lived
  key sharing remains a separate explicit opt-in for direct batch.

## Current xAI API Facts

As of 2026-06-15, xAI documents:

- Batch STT at `POST https://api.x.ai/v1/stt`, using multipart form audio and
  `Authorization: Bearer <key>`.
- Streaming STT at `wss://api.x.ai/v1/stt`, configured by query parameters
  such as `sample_rate=16000`, `encoding=pcm`, `interim_results=true`,
  `language=en`, `keyterm=...`, `smart_turn=...`, and
  `smart_turn_timeout=...`.
- Streaming audio is raw binary frames, with `{"type":"audio.done"}` to flush.
  xAI recommends 16 kHz PCM and 100 ms chunks for streaming STT.
- The streaming STT reference shows Bearer authentication in the WebSocket
  handshake. Browsers cannot set arbitrary `Authorization` headers on
  `new WebSocket(...)`.
- xAI documents browser WebSocket auth through `Sec-WebSocket-Protocol` for
  client secrets minted by `/v1/realtime/client_secrets`. The STT docs still
  describe backend proxying, but empirical probes on 2026-06-15 found the same
  `xai-client-secret.*` subprotocol is accepted by `wss://api.x.ai/v1/stt`.
- `/v1/realtime` is xAI's voice-agent API, not the STT API, and is priced
  differently. YA may call `/v1/realtime/client_secrets` only to mint a
  browser-compatible secret; dictation audio must still stream to `/v1/stt`.

Observed on 2026-06-14: unauthenticated `OPTIONS` preflight requests to
`https://api.x.ai/v1/stt` from both `https://ya.graehl.org` and
`http://localhost:3400` origins returned wildcard CORS allow-origin, methods,
and headers. That makes direct REST batch plausible in-browser. It does not
solve WebSocket authentication, because browser WebSocket constructors still
cannot set the required `Authorization` header.

Observed on 2026-06-15:

- Node `ws` reached `transcript.created` on `wss://api.x.ai/v1/stt` with
  ordinary server-side `Authorization: Bearer ...`.
- Node `ws` also reached `transcript.created` on the same STT endpoint with
  the primary xAI key passed as `Sec-WebSocket-Protocol:
  xai-client-secret.*`.
- A short-lived client secret minted from
  `POST https://api.x.ai/v1/realtime/client_secrets` likewise reached
  `transcript.created` on `/v1/stt` via `xai-client-secret.*`.
- Headless Chromium confirmed the actual browser constructor path: `new
  WebSocket("wss://api.x.ai/v1/stt?sample_rate=16000&encoding=pcm&...",
  ["xai-client-secret.<client-secret>"])` reached `transcript.created`.

Sources:

- xAI Speech to Text:
  <https://docs.x.ai/developers/model-capabilities/audio/speech-to-text>
- xAI voice REST reference:
  <https://docs.x.ai/developers/rest-api-reference/inference/voice>
- xAI Ephemeral Tokens:
  <https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens>

## Key Sources

The client chooses one effective xAI credential source:

1. **Browser-local key.** Stored only in this browser profile. This is the most
   honest "client-owned key" path and needs no YA server key exposure.
2. **Server-minted client secret.** When the browser-local key is absent and
   the YA server has `YEP_STT_XAI_API_KEY`, `POST /api/speech/xai-client-secret`
   mints a short-lived xAI client secret for authenticated private direct
   streaming. The long-lived key stays on the YA server.
3. **Server-provided borrowed key.** The YA server returns its configured xAI
   STT key only to authenticated private clients and only when the operator has
   explicitly enabled long-lived key sharing with
   `YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS=1`. This path exists for direct batch
   REST STT, where `fetch` needs `Authorization: Bearer ...`.

Do not blur these in UI or logs. A server-provided key should be described as
"borrowed from this YA server" and the UI should say that audio goes directly
from the browser to xAI.

## UI Shape

Rename the Grok audio choices around behavior, not implementation detail:

- **Grok streaming, direct to xAI.** Uses 16 kHz PCM16 frames and can expose
  Smart Turn when xAI streaming auth works in the browser.
- **Grok batch, non-streaming, direct to xAI.** Uses `MediaRecorder` output and
  `POST /v1/stt`; no streaming drafts and no Smart Turn.
- **Grok streaming through YA.** Uses 16 kHz PCM16 frames from browser to YA,
  then YA to xAI. Keep as an advanced/debug/server-mediated option for direct
  localhost/tunnel use and future comparisons.
- **Grok batch through YA.** Uses a complete browser `MediaRecorder` recording
  through YA and is labeled batch/non-streaming.

The mic button must provide immediate feedback even when auth/capture fails:
`starting` on click, then either listening/receiving or a visible error naming
the failed stage. A dead click that only focuses the composer violates the
speech UI contract.

## Implementation Plan

Current implementation, 2026-06-15:

- `xai-grok-direct-streaming` is a client speech method that captures Web
  Audio, uses YA's existing PCM16 chunker discipline, and streams raw frames
  directly to `wss://api.x.ai/v1/stt` using the `xai-client-secret.*`
  WebSocket subprotocol.
- `xai-grok-direct-batch` is a client speech method that records an utterance
  with `MediaRecorder`, posts multipart audio directly to
  `https://api.x.ai/v1/stt`, and emits final text only.
- Direct xAI methods do not send audio through YA, so YA cannot retain the
  captured audio artifact for later inspection. Do not compensate by storing
  browser-local audio unless that is explicitly requested as a separate feature.
- The browser-local xAI STT key lives in server-scoped local storage.
- When the browser-local key is empty, direct streaming asks
  `POST /api/speech/xai-client-secret` for a short-lived xAI client secret
  minted by the YA server from `YEP_STT_XAI_API_KEY`.
- When the browser-local key is empty, the client asks
  `POST /api/speech/xai-client-key` for the borrowed server key. The server
  returns it only when `YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS=1` is set.
- Direct streaming is selectable in the STT backend menu and can be saved like
  any other speech method when either `ya-grok` is advertised or this browser
  has a local xAI STT key. The direct batch implementation remains in code for
  legacy or special use, but normal STT menus do not advertise it.
- When `ya-grok` is advertised and no explicit local speech method is stored,
  the client defaults to `Grok STT direct` rather than Grok through YA.
- When no server Grok backend is advertised, entering a browser-local xAI STT
  key immediately makes `Grok STT direct` the default for a browser with no
  explicit speech-method override. Browser paste is one input event, so the UI
  does not add a fixed debounce delay.
- Grok through YA is advertised as `Grok STT through YA`; the retained
  `Grok STT through YA batch` implementation is hidden from normal STT menus.
- The xAI key input is always reachable from the main STT settings page and
  from the mic-button speech options. This lets a client unlock direct Grok
  without any server-side speech backend initialization.

1. **Direct batch first.** Ship a browser provider that records a complete
   utterance with `MediaRecorder` and posts it directly to `POST /v1/stt` with
   a browser-local key or an on-demand server-borrowed key. This is
   non-streaming but removes YA relay/server audio from the immediate hosted
   Grok path.
2. **Browser-auth spike before direct streaming.** Completed 2026-06-15:
   `/v1/stt` accepts `xai-client-secret.*` in the browser WebSocket
   subprotocol and reaches `transcript.created`.
3. **Add an xAI credential broker endpoint.** A private authenticated YA route
   returns either an ephemeral token or, when explicitly enabled, the borrowed
   server STT key. It should also report whether public/share clients are
   ineligible, so the UI can hide controls rather than fail late.
4. **Add a direct xAI client provider.** This should live beside
   `YaServerProvider`, not inside it. It owns browser capture, xAI connection,
   interim/final event handling, Smart Turn handling, and clear stage-specific
   errors.
5. **Ship direct streaming.** Use the existing 16 kHz PCM16 chunker
   discipline: no per-audio-frame allocation, 100 ms frames, `audio.done` on
   stop, and first-audio-frame gated "listening" state.
6. **Keep server-mediated streaming paths selectable.** Existing `ya-grok`
   through YA and local backends such as `ya-whisper` remain available where
   configured, especially for direct localhost/tunnel usage and local server
   STT. Grok batch implementations remain code paths, not normal menu choices.
7. **Record cost and retention semantics.** Direct-to-xAI audio is not retained
   by YA unless separately captured for audit. Server-mediated paths keep the
   existing retention contract.

## Verification

Acceptance for the immediate hosted relief path:

- With a browser-local xAI key, hosted `ya.graehl.org` can transcribe a short
  utterance without YA receiving audio.
- With server xAI STT configured, an authenticated private hosted client can
  mint a short-lived client secret and stream directly; public/share views
  cannot.
- If a hidden/special direct batch path is invoked with server long-lived key
  sharing enabled, direct batch can borrow the key and transcribe; public/share
  views cannot.
- Streaming mode, when available, shows yellow immediately after click, red
  only after first audio frame, tentative drafts while xAI emits mutable
  partials, committed draft text when xAI emits chunk-final partials, and final
  metadata on `transcript.done`.
- Devtools/network or server logs demonstrate that audio goes browser -> xAI,
  not browser -> YA, for direct xAI modes.
- Direct xAI failures do not regress server-mediated `ya-whisper` or direct
  localhost `/api/speech` behavior.
