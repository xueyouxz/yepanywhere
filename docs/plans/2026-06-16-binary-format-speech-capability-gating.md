# Binary frame `0x04` (SPEECH_AUDIO): test cleanup + capability gating

**Date:** 2026-06-16
**Status:** Proposed
**Area:** `packages/shared/src/binary-framing.ts`, relay capability negotiation, relayed STT uplink

## Background

Commit `bbabe78c` ("Stream speech over a dedicated relay channel") allocated a new
binary frame format byte:

```
0x04 = speech audio chunk   (BinaryFormat.SPEECH_AUDIO)
0x05-0xFF = reserved        (was 0x04-0xFF before)
```

This was the correct pattern — the wire design intends format bytes to be
individually feature-detected, not gated behind a hard protocol-version bump
(the `BinaryEnvelopeVersion` byte wraps *every* message, so bumping it would
break all traffic, not just speech). Old peers also reject an unknown format
byte safely rather than misinterpreting existing frames.

Two pieces of cleanup were missed when `0x04` landed.

## 1. Stale reserved-byte test (CI red since 2026-06-14)

`packages/shared/test/binary-framing.test.ts:159` —
`"throws for format byte 0x04 (reserved)"` — still asserts `0x04` is reserved
and must throw. It now decodes successfully as `SPEECH_AUDIO`, so the test fails:

```
AssertionError: expected function to throw an error, but it didn't
```

The test predates the breaking change (last touched in `c2a07966`, Phase 3
compression) and was a negative test pinned to a literal reserved byte — the
classic trap of a value earmarked for future allocation. The speech commit
added new tests in `packages/relay/` and `packages/server/` but never touched
this shared unit test, and main has been red on the `CI` workflow (the one that
runs `pnpm test`) ever since while STT work kept landing on top.

**Fix:**
- Repoint the reserved-byte test to a still-reserved value (`0x05`).
- Add a positive `accepts format 0x04 (SPEECH_AUDIO)` test mirroring the
  existing `0x02`/`0x03` "accepts format" tests (lines 174-186).
- Consider asserting against the lowest-still-reserved byte computed from the
  `BinaryFormat` enum so the next allocation doesn't silently invalidate it.

## 2. Missing capability gating for the relay speech channel

The relayed speech uplink sends `0x04` frames **unconditionally** and is not
gated on any speech-specific compatibility probe. Specifically:

- **Format capability exchange is one-directional.** The `client_capabilities`
  message (`relay.ts`) flows client→server only; the server records
  `connState.supportedFormats` (default `[0x01]`) and uses it to decide whether
  to *send* `COMPRESSED_JSON` to the client
  (`ws-relay-handlers.ts:269`). There is **no server→client** signal telling the
  client which formats the server understands, so a newer client cannot know
  whether the server supports `0x04`.
- **`SecureConnection.sendSpeechAudioFrame` (`SecureConnection.ts:1444`) sends
  `0x04` whenever the socket is open and authenticated** — no support check.
- **The mic / relayed uplink is gated only on the generic `voiceInput`
  capability**, which predates the speech channel (added in `80aa893c`, long
  before `bbabe78c`). `voiceInput=true` does **not** imply the server can handle
  the `0x04` relay channel.

### Symptom: newer client + older server (relay/encrypted)

The old server decrypts the envelope, finds format `0x04`, has no
`SPEECH_AUDIO` branch, and falls through to a generic `binary-format-error`
(400 "Unsupported binary format") **per audio chunk**. It does not crash, but:

- the speech UI gets no clean `speech_event: error`;
- audio silently goes nowhere while the server emits a 400 for every chunk
  (spammy at audio frame rates).

On the plaintext path the old server's `decodeBinaryFrame` throws
`UNKNOWN_FORMAT` outright.

(Reverse skew — old client + new server — is fine; an old client never sends
`0x04` and never advertises it.)

### Fix (mirror the existing `deviceBridge`/`voiceInput` pattern)

- Add a server capability string (e.g. `"relay-speech"` /
  `"speech-audio-frame"`) to `getServerCapabilities()` (`version.ts`) and the
  relay `register` payload.
- Gate the relayed speech *uplink mode* on the client seeing that capability,
  with a graceful fallback (browser/HTTP STT) or a clear "speech unavailable on
  this server" state when absent — instead of inferring it from `voiceInput`.

This keeps the format-byte feature-detection model intact and avoids a
protocol-version bump.

## References

- `packages/shared/src/binary-framing.ts` — `BinaryFormat`, `decodeBinaryFrame`
- `packages/shared/test/binary-framing.test.ts:159` — failing test
- `packages/server/src/routes/ws-message-router.ts:99,208` — server `0x04` handling
- `packages/server/src/routes/ws-relay-handlers.ts:137,269` — `supportedFormats`
- `packages/server/src/routes/version.ts:287` — `getServerCapabilities`
- `packages/client/src/lib/connection/SecureConnection.ts:1444,1476` — uplink + `client_capabilities`
- `packages/client/src/components/VoiceInputButton.tsx:107` — `voiceInput` gating
- Related topics: `topics/streaming-speech-capture.md`, `topics/direct-xai-speech.md`
