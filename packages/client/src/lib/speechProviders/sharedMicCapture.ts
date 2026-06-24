import { UI_KEYS } from "../storageKeys";

export const SPEECH_CAPTURE_SAMPLE_RATE = 16_000;
export const SHARED_SPEECH_MIC_LEASE_STORAGE_KEY =
  "yep-anywhere-speech-warm-mic-lease";

const SHARED_SPEECH_MIC_CHANNEL_NAME = "yep-anywhere-speech-warm-mic";
const SHARED_SPEECH_MIC_LEASE_TTL_MS = 4000;
const SHARED_SPEECH_MIC_LEASE_HEARTBEAT_MS = 1000;
const TAB_ID = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2)}`;

interface SharedSpeechMicLease {
  ownerId: string;
  expiresAt: number;
}

interface SharedSpeechMicChannelMessage {
  type: "claimed" | "released";
  ownerId: string;
}

let sharedWarmStream: MediaStream | null = null;
let sharedWarmDeviceKey: string | null = null;
let sharedWarmRequest: Promise<MediaStream> | null = null;
let sharedWarmRequestKey: string | null = null;
let sharedWarmGeneration = 0;
let sharedActiveCaptureLeases = 0;
let releaseSharedWarmWhenInactive = false;
let reacquireSharedWarmWhenVisible = false;
let sharedWarmRequested = false;
let idleLeaseHeld = false;
let idleLeaseHeartbeat: ReturnType<typeof setInterval> | null = null;
let lifecycleInstalled = false;
let leaseChannel: BroadcastChannel | null = null;

function deviceKey(micDeviceId: string | null | undefined): string {
  return micDeviceId ?? "";
}

function canUseStorage(): boolean {
  return (
    typeof globalThis.localStorage !== "undefined" &&
    typeof globalThis.localStorage.getItem === "function" &&
    typeof globalThis.localStorage.setItem === "function" &&
    typeof globalThis.localStorage.removeItem === "function"
  );
}

function isDocumentVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState === "visible"
  );
}

function getStoredKeepMicWarm(): boolean {
  return (
    canUseStorage() &&
    globalThis.localStorage.getItem(UI_KEYS.speechKeepMicWarm) === "true"
  );
}

function getStoredMicDeviceId(): string | null {
  if (!canUseStorage()) return null;
  const deviceId = globalThis.localStorage.getItem(UI_KEYS.speechMicDeviceId);
  return deviceId && deviceId.length > 0 ? deviceId : null;
}

function readIdleLease(): SharedSpeechMicLease | null {
  if (!canUseStorage()) return null;
  const raw = globalThis.localStorage.getItem(
    SHARED_SPEECH_MIC_LEASE_STORAGE_KEY,
  );
  if (!raw) return null;
  try {
    const lease = JSON.parse(raw) as Partial<SharedSpeechMicLease>;
    if (
      typeof lease.ownerId === "string" &&
      typeof lease.expiresAt === "number" &&
      Number.isFinite(lease.expiresAt)
    ) {
      return { ownerId: lease.ownerId, expiresAt: lease.expiresAt };
    }
  } catch {
    return null;
  }
  return null;
}

function writeIdleLease(ownerId: string): void {
  if (!canUseStorage()) return;
  const lease: SharedSpeechMicLease = {
    ownerId,
    expiresAt: Date.now() + SHARED_SPEECH_MIC_LEASE_TTL_MS,
  };
  globalThis.localStorage.setItem(
    SHARED_SPEECH_MIC_LEASE_STORAGE_KEY,
    JSON.stringify(lease),
  );
}

function isLeaseCurrent(
  lease: SharedSpeechMicLease | null,
): lease is SharedSpeechMicLease {
  return lease !== null && lease.expiresAt > Date.now();
}

function getBroadcastChannel(): BroadcastChannel | null {
  if (leaseChannel) return leaseChannel;
  if (typeof BroadcastChannel === "undefined") return null;
  leaseChannel = new BroadcastChannel(SHARED_SPEECH_MIC_CHANNEL_NAME);
  leaseChannel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as Partial<SharedSpeechMicChannelMessage>;
    if (message.ownerId === TAB_ID) return;
    if (message.type === "claimed") {
      releaseIdleSharedSpeechMicStream(false);
    }
  };
  return leaseChannel;
}

function broadcastIdleLease(type: SharedSpeechMicChannelMessage["type"]): void {
  getBroadcastChannel()?.postMessage({ type, ownerId: TAB_ID });
}

function stopIdleLeaseHeartbeat(): void {
  if (idleLeaseHeartbeat !== null) {
    clearInterval(idleLeaseHeartbeat);
    idleLeaseHeartbeat = null;
  }
}

function releaseIdleLease(): void {
  if (!idleLeaseHeld) return;
  idleLeaseHeld = false;
  stopIdleLeaseHeartbeat();
  const lease = readIdleLease();
  if (lease?.ownerId === TAB_ID) {
    globalThis.localStorage.removeItem(SHARED_SPEECH_MIC_LEASE_STORAGE_KEY);
  }
  broadcastIdleLease("released");
}

function startIdleLeaseHeartbeat(): void {
  if (idleLeaseHeartbeat !== null) return;
  idleLeaseHeartbeat = setInterval(() => {
    if (!idleLeaseHeld || !isDocumentVisible()) {
      releaseIdleSharedSpeechMicStream(!isDocumentVisible());
      return;
    }
    writeIdleLease(TAB_ID);
  }, SHARED_SPEECH_MIC_LEASE_HEARTBEAT_MS);
}

function tryAcquireIdleLease(): boolean {
  if (!isDocumentVisible()) return false;
  if (!canUseStorage()) {
    idleLeaseHeld = true;
    startIdleLeaseHeartbeat();
    broadcastIdleLease("claimed");
    return true;
  }

  const existing = readIdleLease();
  if (isLeaseCurrent(existing) && existing.ownerId !== TAB_ID) {
    return false;
  }

  writeIdleLease(TAB_ID);
  if (readIdleLease()?.ownerId !== TAB_ID) return false;
  idleLeaseHeld = true;
  startIdleLeaseHeartbeat();
  broadcastIdleLease("claimed");
  return true;
}

function stopSharedWarmStreamNow(): void {
  sharedWarmGeneration += 1;
  if (sharedWarmStream) {
    stopSpeechStreamTracks(sharedWarmStream);
  }
  sharedWarmStream = null;
  sharedWarmDeviceKey = null;
  sharedWarmRequest = null;
  sharedWarmRequestKey = null;
  releaseIdleLease();
}

function releaseIdleSharedSpeechMicStream(reacquireOnVisible: boolean): void {
  if (reacquireOnVisible) reacquireSharedWarmWhenVisible = true;
  releaseIdleLease();
  if (sharedActiveCaptureLeases > 0) {
    releaseSharedWarmWhenInactive = true;
    return;
  }
  stopSharedWarmStreamNow();
}

function maybeReacquireSharedWarmStream(): void {
  if (!reacquireSharedWarmWhenVisible) return;
  if (!isDocumentVisible() || !getStoredKeepMicWarm()) return;
  reacquireSharedWarmWhenVisible = false;
  void getSpeechMicStream({
    keepWarm: true,
    micDeviceId: getStoredMicDeviceId(),
  }).catch((err: unknown) => {
    console.warn(
      "[SpeechMic] Warm microphone reacquire failed",
      err instanceof Error ? err.message : String(err),
    );
  });
}

function retainOrReleaseIdleWarmStream(): void {
  if (sharedActiveCaptureLeases > 0) return;

  if (releaseSharedWarmWhenInactive) {
    const shouldTryRetain =
      isDocumentVisible() &&
      (sharedWarmRequested || getStoredKeepMicWarm()) &&
      !reacquireSharedWarmWhenVisible;
    releaseSharedWarmWhenInactive = false;
    if (!shouldTryRetain || !tryAcquireIdleLease()) {
      stopSharedWarmStreamNow();
    }
    return;
  }

  if (!hasLiveSpeechTracks(sharedWarmStream)) return;
  if (
    !isDocumentVisible() ||
    (!sharedWarmRequested && !getStoredKeepMicWarm()) ||
    !tryAcquireIdleLease()
  ) {
    stopSharedWarmStreamNow();
  }
}

function installSharedMicLifecycle(): void {
  if (lifecycleInstalled || typeof window === "undefined") return;
  lifecycleInstalled = true;
  getBroadcastChannel();

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!isDocumentVisible()) {
        releaseIdleSharedSpeechMicStream(true);
        return;
      }
      releaseSharedWarmWhenInactive = false;
      maybeReacquireSharedWarmStream();
    });
  }

  window.addEventListener("pagehide", () => {
    releaseIdleSharedSpeechMicStream(false);
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== SHARED_SPEECH_MIC_LEASE_STORAGE_KEY) return;
    const lease = readIdleLease();
    if (lease?.ownerId && lease.ownerId !== TAB_ID) {
      releaseIdleSharedSpeechMicStream(false);
    }
  });
}

export function acquireSharedSpeechMicActiveLease(): () => void {
  installSharedMicLifecycle();
  if (sharedActiveCaptureLeases === 0) {
    broadcastIdleLease("claimed");
  }
  sharedActiveCaptureLeases += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sharedActiveCaptureLeases = Math.max(0, sharedActiveCaptureLeases - 1);
    retainOrReleaseIdleWarmStream();
  };
}

export function hasLiveSpeechTracks(
  stream: MediaStream | null,
): stream is MediaStream {
  return (
    stream?.getTracks().some((track) => track.readyState !== "ended") === true
  );
}

export function stopSpeechStreamTracks(stream: MediaStream): void {
  stream.getTracks().forEach((track) => {
    track.stop();
  });
}

export function startSpeechWaveformMonitor(
  stream: MediaStream,
  onAudioSamples: ((samples: Float32Array) => void) | undefined,
): () => void {
  if (!onAudioSamples || typeof window === "undefined") return () => {};
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) return () => {};

  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let silentGain: GainNode | null = null;
  try {
    context = new AudioContextCtor();
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(1024, 1, 1);
    silentGain = context.createGain();
    silentGain.gain.value = 0;
    processor.onaudioprocess = (event) => {
      onAudioSamples(event.inputBuffer.getChannelData(0));
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    void context.resume().catch(() => undefined);
  } catch {
    processor?.disconnect();
    source?.disconnect();
    silentGain?.disconnect();
    void context?.close().catch(() => undefined);
    return () => {};
  }

  return () => {
    if (processor) processor.onaudioprocess = null;
    processor?.disconnect();
    source?.disconnect();
    silentGain?.disconnect();
    void context?.close();
  };
}

export function isSharedSpeechMicStream(stream: MediaStream | null): boolean {
  return stream !== null && stream === sharedWarmStream;
}

export function speechMicConstraints(
  micDeviceId: string | null | undefined,
): MediaStreamConstraints {
  return {
    audio: {
      ...(micDeviceId ? { deviceId: { exact: micDeviceId } } : {}),
      // A single YA-controlled capture shape avoids paying a fresh
      // getUserMedia/device path when the user switches STT backends.
      channelCount: { ideal: 1 },
      sampleRate: { ideal: SPEECH_CAPTURE_SAMPLE_RATE },
      sampleSize: { ideal: 16 },
      // Capture raw mic audio. The selected OS/browser device is the gain and
      // processing choice; YA should not silently route some backends through
      // browser call-processing while others use raw PCM.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
}

export function releaseSharedSpeechMicStream(): void {
  sharedWarmRequested = false;
  releaseIdleLease();
  if (sharedActiveCaptureLeases > 0) {
    releaseSharedWarmWhenInactive = true;
    reacquireSharedWarmWhenVisible = false;
    return;
  }
  reacquireSharedWarmWhenVisible = false;
  stopSharedWarmStreamNow();
}

export function getSpeechMicStream({
  keepWarm,
  micDeviceId,
}: {
  keepWarm: boolean;
  micDeviceId?: string | null;
}): Promise<MediaStream> {
  const key = deviceKey(micDeviceId);
  const constraints = speechMicConstraints(micDeviceId);
  if (!keepWarm) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  installSharedMicLifecycle();
  sharedWarmRequested = true;

  const hasActiveCapture = sharedActiveCaptureLeases > 0;
  if (!hasActiveCapture) {
    if (!tryAcquireIdleLease()) {
      return Promise.reject(
        new Error("Another visible YA tab owns the idle warm microphone"),
      );
    }
  }

  if (sharedWarmDeviceKey !== null && sharedWarmDeviceKey !== key) {
    stopSharedWarmStreamNow();
  }
  sharedWarmDeviceKey = key;

  if (hasLiveSpeechTracks(sharedWarmStream)) {
    return Promise.resolve(sharedWarmStream);
  }
  if (sharedWarmRequest && sharedWarmRequestKey === key) {
    return sharedWarmRequest;
  }

  const generation = sharedWarmGeneration;
  const request = navigator.mediaDevices.getUserMedia(constraints);
  sharedWarmRequest = request;
  sharedWarmRequestKey = key;

  return request
    .then((stream) => {
      if (
        generation === sharedWarmGeneration &&
        sharedWarmRequest === request &&
        sharedWarmDeviceKey === key &&
        (sharedActiveCaptureLeases > 0 ||
          (isDocumentVisible() && idleLeaseHeld))
      ) {
        sharedWarmStream = stream;
      } else if (hasLiveSpeechTracks(stream)) {
        stopSpeechStreamTracks(stream);
      }
      return stream;
    })
    .finally(() => {
      if (sharedWarmRequest === request) {
        sharedWarmRequest = null;
        sharedWarmRequestKey = null;
      }
    });
}
