# Streaming speech capture (client PCM pipeline)

> YA's server-streaming speech path treats browser microphone capture as a
> stateful device pipeline: direct transport only, PCM frames from the first
> real audio callback, and explicit opt-in for warm mic or future AudioWorklet
> modes.

Topic: streaming-speech-capture

See also: [pluggable-speech-recognition.md](pluggable-speech-recognition.md)
(server-side backend registry, batch transcription, Smart Turn recipe). This
doc covers the **client** capture pipeline for server-mediated streaming STT -
the path from microphone to PCM16 frames over `/api/speech/ws` - and the
contracts that kept biting it.

Primary code: `packages/client/src/lib/speechProviders/YaServerProvider.ts`
(`doStartStreaming`), `packages/client/src/components/VoiceInputButton.tsx`,
`packages/server/src/routes/speech.ts`, and
`packages/server/src/services/voice/xaiSttBackend.ts`.

## Capture modes

- **Standard mode (current): Web Audio `ScriptProcessorNode`.** Deprecated but
  universally available. The processor pulls mic frames off the audio clock;
  it must be connected to `destination` (through a zero-gain node) to fire. YA
  requests a 16 kHz `AudioContext` so Web Audio can resample the mic track to
  xAI's native STT rate before YA packs samples into PCM16.
- **AudioWorklet mode (planned, opt-in):** the modern replacement. Recent
  Chrome supports `AudioWorkletNode`, so the next implementation pass should
  add a small PCM worklet behind feature detection (`audioContext.audioWorklet`
  and `AudioWorkletNode`) and a visible capture-mode option. Keep
  `ScriptProcessorNode` as fallback and do **not** make AudioWorklet the silent
  default until desktop Chrome plus mobile browsers prove reliable. This will
  address processor deprecation and likely mobile frame-delivery flakiness; it
  will **not** fix the pre-graph `getUserMedia` cold-open latency, which occurs
  before either processor type exists.

## Hard contracts (each cost a debugging cycle)

1. **Transport.** `/api/speech/ws` is direct-only; it is **not** multiplexed
   through the secure relay. Over relay (`useRemoteBasePath()` non-empty) the
   socket cannot reach the server, so streaming must be disabled and the client
   falls back to the remote-compatible batch POST path. `VoiceInputButton`
   gates `serverStreaming` on `!relayTransport`. Symptom when violated: a phone
   on the hosted client shows "yellow then nothing".

2. **Capture from mic-on, no dead window.** Build the audio graph the instant
   `getUserMedia` resolves and **buffer PCM frames until the socket handshake
   completes**, flushing in order. Do not gate capture on the socket/resume.
   Symptom when violated: the first seconds of speech are dropped (a 5s
   utterance arrived as 2.2s).

3. **"listening" means audio is actually flowing.** Status flips to
   `listening` only from the **first real `onaudioprocess` callback**, not after
   a fixed sequence. A suspended/dead context never reaches `listening`; the
   3.5s audio-flow watchdog then surfaces a visible error. `resume()` rejection
   is logged, not swallowed.

4. **Capture constraints: all call-oriented processing off.** No audio is
   played, so `echoCancellation` has nothing to cancel; `noiseSuppression` and
   `autoGainControl` reshape the waveform - all three **off**, capture the raw
   mic. Keep `channelCount: 1` (a proper mono downmix transcribes better than
   one channel of a stereo stream; dropping it hurt quality).

   Capture **level** is managed by **input-device selection**, not AGC. Retained
   captures showed peak swinging 0.5%-16% FS with quiet ones mis-transcribing
   ("Thank you" for "Testing"); the level was fixed by choosing a good input
   device (here, switching the OS mic to 44.1 kHz), which is why the device
   picker matters. (Note: AGC normalization was hypothesized from that
   correlation but never verified and did **not** turn out to be the fix - do
   not re-enable it on that reasoning.) Evidence lives in
   `~/.yep-anywhere/speech-audio/<date>/` `.bin`+`.json` - analyze peak/RMS vs
   transcript directly rather than trusting the browser console.

5. **PCM packing must not allocate per callback.** The streaming path targets
   xAI-native 16 kHz PCM16 and emits 100 ms chunks (1600 samples / 3200 bytes).
   `Pcm16Chunker` reuses fixed buffers and only flushes a short final frame on
   manual stop. If Web Audio still reports a non-16 kHz context, the fallback
   resampler averages input windows and each output sample must span at least 1
   input sample, or a slice of output becomes silence.

6. **Mid-session failure must reach the client.** `SpeechStreamHandlers.onError`
   carries an upstream timeout/drop (no caller awaits `openPromise` once the
   session is live). The route forwards it as `{type:"error"}`. The client
   **salvages the live preview** (commits already-transcribed words) and only
   shows an error when there is nothing to salvage - never hangs on
   "listening". Guarded by request id so a superseded session is closed and
   cannot steal a newer request's buffered frames.

## Microphone lifecycle (latency + device selection)

The `getUserMedia` **device cold-open** dominates start latency and is
device-dependent - measured from ~60ms (a silent/disconnected default device
that opens instantly) to ~2080ms (the real mic). Diagnose with the `[YaSTT]`
console marks (`start` -> `getUserMedia call` -> `getUserMedia ready` ->
`graph built` -> `first audio frame` -> per-frame `frame peak=`). A fast open
with `frame peak~0.003` means the **wrong input device** was selected, not a
code fault.

Planned, both as STT settings (`pluggable-speech-recognition.md` covers the
settings surface):

- **Mic device picker.** Add an explicit native input-device chooser to the
  shared `SpeechControlMenu` STT options surface (the mic-attached menu reused
  by the new-session composer and message toolbar). Enumerate
  `audioinput` devices, store the browser-local selected `deviceId`, and pass
  it to `getUserMedia` for both warm-mic pre-open and per-dictation capture.
  Fixes silent capture from a wrong default device, and lets the user avoid a
  slow-opening device. Do **not** expose low-level capture params such as
  downsampling, mono mixing, sample size, or AudioContext sample rate in that
  UI; those remain browser/Web Audio responsibilities governed by the capture
  contracts above.
- **Warm-mic option (implemented, opt-in, default off).** A **standalone**
  browser-local setting that
  applies to **all server-mediated speech recognition** (every backend, both
  the PCM streaming and the compressed batch paths) - not nested under
  `GrokSpeechAudioSettings`. It is **device-local** (a phone and a desktop want
  different warm behavior), so it must **not** sync as a server-side client
  default. When enabled, **keep the mic warm always**: acquire the `MediaStream`
  once and never stop its tracks between dictations, so every dictation skips
  the device cold-open. "Warm" means the **mic device / MediaStream only** - no
  audio is sent and the streaming WebSocket is **not** held open or fed between
  dictations; the WS + frame sending stay strictly per-dictation. Privacy-
  visible (Chrome shows the mic indicator continuously) - the explicit, accepted
  tradeoff of enabling it. Do **not** use a short idle TTL that silently
  re-incurs the cold-open. Release only on provider dispose, option-off,
  backend/device change, or tab close. Default off keeps no speculative capture.
  Implementation detail: when Chrome already has microphone permission, provider
  construction pre-opens the stream; otherwise the first click still performs
  the permission/device open, then subsequent dictations reuse the warm stream.

The cold-open cannot be eliminated for the *first* use without prewarming
before the click (mic indicator before intent), which is exactly why warm-mic
is an explicit option rather than default behavior.

## Mobile: "turns yellow, never red" (open, unresolved)

Observed: on mobile (hosted ya.graehl.org client) the mic shows the amber
**connecting** state ("starting") and never reaches the red **listening**
state. Per contract #3, `listening` is gated on the first real
`onaudioprocess` callback, so "never red" means **the first audio frame never
fires** - the indicator gate is doing its honest job; the fault is upstream in
capture, not in the button. Best guesses, roughly in order:

1. **Streaming is being attempted on mobile and `ScriptProcessorNode` never
   fires there.** If the hosted client's `currentRelayUsername` is empty (so
   `useRemoteBasePath()` returns `""`), `relayTransport` is false and
   `serverStreaming` stays true - the PCM streaming path runs on mobile even
   though it should fall back to batch (contract #1). On mobile browsers (iOS
   Safari especially) `ScriptProcessorNode.onaudioprocess` is unreliable and/or
   the `AudioContext` stays `suspended` because the in-gesture `resume()` is
   `await`-deferred past the user-activation window - either way no first frame,
   so it sticks on yellow. The 3.5s audio-flow watchdog should then surface an
   error; if only persistent yellow is seen, the watchdog isn't reaching the
   mobile UI (or is being cleared) - worth checking.
2. **Batch path also stalls.** If relay *is* detected and batch is used,
   `getUserMedia({audio:true})` or `MediaRecorder` may hang/reject on mobile;
   batch only sets `listening` after `recorder.start()`, so a hang likewise
   leaves it on "starting"/yellow. Note batch uses the browser-default
   EC/NS/AGC, unlike the streaming path's all-off constraints.
3. **AudioWorklet mode is the likely real fix.** The deprecated
   `ScriptProcessorNode` is exactly the component that is flaky on mobile;
   moving capture to an `AudioWorklet` (the planned opt-in mode) is the
   strongest candidate to make mobile capture deliver frames reliably. This
   raises the priority of that planned work specifically for mobile.

Next diagnostic step (not yet done): enable **Remote Log Collection**
(Developer Mode) on the phone so the `[YaSTT]` marks reach
`~/.yep-anywhere/logs/client-logs/`, then read which mark is last:
- `graph built` present but no `first audio frame` -> ScriptProcessor /
  suspended-AudioContext on mobile (guess 1/3).
- no `getUserMedia ready` -> the device open itself hangs on mobile.
- also confirm whether the transport resolved to relay (should be batch) or
  direct/streaming - that decides guess 1 vs 2.

## Implementation status (keep current)

- **Done:** transport-aware streaming/batch selection and transport-aware
  streaming-only controls (contract #1); capture from mic-on with handshake
  buffering (#2); first-frame-gated `listening` + watchdog (#3); EC/NS/AGC off
  + `channelCount: 1` (#4); resampler at-least-1-sample span (#5); `onError`/timeout
  salvage + request-id guard (#6); browser-local warm-mic option; `[YaSTT]`
  diagnostics.
- **Open / not implemented:** mobile "never red" (above); mic device picker;
  AudioWorklet mode. The non-AudioWorklet path already sends 16 kHz PCM16 in
  100 ms chunks.

## Diagnostics

`[YaSTT]` console marks (and `frame peak=`) are intentionally kept in
`doStartStreaming` while this path is being hardened; they flow to the remote
client log collector too. Remove or gate them once standard mode is settled and
AudioWorklet mode lands.
