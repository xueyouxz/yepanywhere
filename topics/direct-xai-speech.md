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
  outbound HTTPS/WSS connectivity to xAI. Direct Grok should be selectable and
  persistable now; making it an automatic hosted default needs an advertised
  client-key or browser-key availability signal so unconfigured installs do not
  default into a dead mic.
- **Server-local STT stays YA-mediated.** Local Whisper or another recognizer
  running on the YA host still requires browser audio to reach YA. The
  server-mediated flow remains important for local models, audit/tuning,
  biasing, and future audio-as-modality work.
- **Relay-to-server speech remains future work.** The dedicated relayed speech
  channel is not working end to end today. It should not block hosted Grok
  usability, but it remains valuable for phone-to-local-Whisper and other
  server-local recognizers.
- **Credential disclosure is explicit.** A server-provided xAI STT key is a
  client-borrowed key: authenticated private YA clients may receive and use it
  over HTTPS/WSS. It is not secret from those clients. Public/shared views must
  never receive it.
- **Browser-local personal key is supported.** A client may configure its own
  xAI key in browser-local storage instead of borrowing the server key.
- **Upstream default is no key exposure.** Sharing a server STT key with
  clients must be an explicit operator setting, not implied by
  `YA_stt__XAI_API_KEY` existing. This preserves upstream trust while allowing
  the private deployment to opt in.

## Current xAI API Facts

As of 2026-06-14, xAI documents:

- Batch STT at `POST https://api.x.ai/v1/stt`, using multipart form audio and
  `Authorization: Bearer <key>`.
- Streaming STT at `wss://api.x.ai/v1/stt`, configured by query parameters
  such as `sample_rate=16000`, `encoding=pcm`, `interim_results=true`,
  `language=en`, `keyterm=...`, `smart_turn=...`, and
  `smart_turn_timeout=...`.
- Streaming audio is raw binary frames, with `{"type":"audio.done"}` to flush.
  xAI recommends 16 kHz PCM and 100 ms chunks for streaming STT.
- The streaming STT reference requires Bearer authentication in the WebSocket
  handshake. Browsers cannot set arbitrary `Authorization` headers on
  `new WebSocket(...)`.
- xAI documents browser WebSocket auth through `Sec-WebSocket-Protocol` for
  ephemeral tokens on `/v1/realtime`; it does not clearly state that the same
  mechanism works for `/v1/stt`.
- `/v1/realtime` is xAI's voice-agent API, not the STT API, and is priced
  differently. Do not route YA dictation there to work around STT WebSocket
  browser-auth limits.

Observed on 2026-06-14: unauthenticated `OPTIONS` preflight requests to
`https://api.x.ai/v1/stt` from both `https://ya.graehl.org` and
`http://localhost:3400` origins returned wildcard CORS allow-origin, methods,
and headers. That makes direct REST batch plausible in-browser. It does not
solve WebSocket authentication, because browser WebSocket constructors still
cannot set the required `Authorization` header.

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
2. **Server-provided borrowed key.** The YA server returns its configured xAI
   STT credential only to authenticated private clients and only when the
   operator has explicitly enabled key sharing with
   `YA_stt__SHARE_XAI_KEY_WITH_CLIENTS=1`. Public share routes and
   unauthenticated views get no key material and should not show usable xAI
   STT controls.
3. **Ephemeral token, if STT supports it.** Preferred if xAI confirms
   `/v1/stt` accepts short-lived client secrets through a browser-compatible
   mechanism. YA would mint the token and never reveal the long-lived API key.

Do not blur these in UI or logs. A server-provided key should be described as
"borrowed from this YA server" and the UI should say that audio goes directly
from the browser to xAI.

## UI Shape

Rename the Grok audio choices around behavior, not implementation detail:

- **Grok streaming, direct to xAI.** Uses 16 kHz PCM16 frames and can expose
  Smart Turn when xAI streaming auth works in the browser.
- **Grok batch, non-streaming, direct to xAI.** Uses `MediaRecorder` output and
  `POST /v1/stt`; no streaming drafts and no Smart Turn.
- **Grok through YA server.** Keep as an advanced/debug/server-mediated option
  for direct localhost/tunnel use and future comparisons. Hosted deployments
  can choose direct as their default once key availability is explicit.

The mic button must provide immediate feedback even when auth/capture fails:
`starting` on click, then either listening/receiving or a visible error naming
the failed stage. A dead click that only focuses the composer violates the
speech UI contract.

## Implementation Plan

Current implementation, 2026-06-14:

- `xai-grok-direct-batch` is a client speech method that records an utterance
  with `MediaRecorder`, posts multipart audio directly to
  `https://api.x.ai/v1/stt`, and emits final text only.
- The browser-local xAI STT key lives in server-scoped local storage.
- When the browser-local key is empty, the client asks
  `/api/speech/xai-client-key` for the borrowed server key. The server returns
  it only when `YA_stt__SHARE_XAI_KEY_WITH_CLIENTS=1` is set.
- Direct batch is selectable in the STT backend menu and can be saved like any
  other speech method; it is not yet an automatic no-choice hosted default.
- No direct xAI streaming provider is shipped yet. The next streaming step is
  still an auth spike against `wss://api.x.ai/v1/stt`, not `/v1/realtime`.

1. **Direct batch first.** Ship a browser provider that records a complete
   utterance with `MediaRecorder` and posts it directly to `POST /v1/stt` with
   a browser-local key or an on-demand server-borrowed key. This is
   non-streaming but removes YA relay/server audio from the immediate hosted
   Grok path.
2. **Browser-auth spike before direct streaming.** From a real browser, test:
   - `POST /v1/stt` with a browser-set `Authorization` header and
     `MediaRecorder` audio, including CORS behavior.
   - `wss://api.x.ai/v1/stt` with the server key if xAI offers a
     browser-compatible auth mechanism.
   - `wss://api.x.ai/v1/stt` with an ephemeral token via subprotocol, even
     though docs currently only advertise this for `/v1/realtime`.
   The outcome chooses the first shippable direct mode.
3. **Add an xAI credential broker endpoint.** A private authenticated YA route
   returns either an ephemeral token or, when explicitly enabled, the borrowed
   server STT key. It should also report whether public/share clients are
   ineligible, so the UI can hide controls rather than fail late.
4. **Add a direct xAI client provider.** This should live beside
   `YaServerProvider`, not inside it. It owns browser capture, xAI connection,
   interim/final event handling, Smart Turn handling, and clear stage-specific
   errors.
5. **Then ship direct streaming.** Use the existing 16 kHz PCM16 chunker
   discipline: no per-audio-frame allocation, 100 ms frames, `audio.done` on
   stop, and first-audio-frame gated "listening" state.
6. **Keep server-mediated paths selectable.** Existing `ya-grok` through YA
   and `ya-whisper` remain available where configured, especially for direct
   localhost/tunnel usage and local server STT. Once the client can distinguish
   an actually usable direct credential path, hosted Grok can prefer direct
   without making unconfigured installs fail late.
7. **Record cost and retention semantics.** Direct-to-xAI audio is not retained
   by YA unless separately captured for audit. Server-mediated paths keep the
   existing retention contract.

## Verification

Acceptance for the immediate hosted relief path:

- With a browser-local xAI key, hosted `ya.graehl.org` can transcribe a short
  utterance without YA receiving audio.
- With server key sharing enabled, an authenticated private hosted client can
  borrow the key or token and transcribe; public/share views cannot.
- Batch mode visibly says non-streaming and produces final text or a visible
  xAI/CORS/auth error.
- Streaming mode, when available, shows yellow immediately after click, red
  only after first audio frame, interim drafts while xAI emits partials, and
  final text on `transcript.done`.
- Devtools/network or server logs demonstrate that audio goes browser -> xAI,
  not browser -> YA, for direct xAI modes.
- Direct xAI failures do not regress server-mediated `ya-whisper` or direct
  localhost `/api/speech` behavior.
