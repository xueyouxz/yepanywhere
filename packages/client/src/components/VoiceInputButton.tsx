import {
  type ForwardedRef,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
} from "react";
import { useBrowserXaiSttApiKey } from "../hooks/useBrowserXaiSttApiKey";
import { useModelSettings } from "../hooks/useModelSettings";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useSpeechCaptureSettings } from "../hooks/useSpeechCaptureSettings";
import {
  SPEECH_STATUS_LABELS,
  useSpeechRecognition,
} from "../hooks/useSpeechRecognition";
import { useConnection } from "../hooks/useConnection";
import { useVersion } from "../hooks/useVersion";
import { useViewportWidth } from "../hooks/useViewportWidth";
import { useI18n } from "../i18n";
import { hasCoarsePointer } from "../lib/deviceDetection";
import {
  canSpeechMethodStream,
  isServerRoutedSpeechMethod,
  resolveSpeechMethod,
  type SpeechMethodId,
} from "../lib/speechProviders/methods";
import type {
  SpeechSmartTurnSettings,
  SpeechTranscriptionContext,
  SpeechTranscriptionResultMetadata,
} from "../lib/speechProviders/SpeechProvider";

/**
 * A cancellable in-progress speech state the composer surfaces as a chip:
 * `listening` during active capture, `transcribing` for a batch wait,
 * `finalizing` for a streaming flush. The chip's ✕ cancels the non-final
 * portion in every case; already-committed finals stay in the draft.
 */
export type SpeechPendingKind = "listening" | "transcribing" | "finalizing";

export interface VoiceInputButtonRef {
  /** Stop listening and return any pending interim text */
  stopAndFinalize: () => string;
  /** Toggle listening on/off */
  toggle: () => void;
  /** Abandon an in-flight post-capture transcription; late result is discarded. */
  cancelProcessing: () => void;
  /** Speculatively warm capture resources before the first click. */
  prewarm: () => void;
  /** Whether currently listening */
  isListening: boolean;
  /** Whether voice input is available (supported and enabled) */
  isAvailable: boolean;
}

interface VoiceInputButtonProps {
  /** Callback when final transcript is received - appends to input */
  onTranscript: (
    text: string,
    metadata?: SpeechTranscriptionResultMetadata,
  ) => void;
  /** Callback for interim results - shows live preview */
  onInterimTranscript?: (text: string) => void;
  /** Callback when listening starts - useful for focusing input */
  onListeningStart?: () => void;
  /** Callback when the user explicitly stops active capture. */
  onListeningStop?: () => void;
  /** Callback when a post-capture pending state (transcribing/finalizing) starts or ends. */
  onPendingSpeechChange?: (kind: SpeechPendingKind | null) => void;
  /** Whether the button should be disabled */
  disabled?: boolean;
  /** Additional class name */
  className?: string;
  /** Speech method selected by an enclosing in-session selector. */
  speechMethod?: SpeechMethodId;
  /** Context attached to YA-server transcription requests. */
  getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;
  /** Smart Turn settings for streaming STT backends that support it. */
  smartTurn?: SpeechSmartTurnSettings;
}

/**
 * Microphone button for voice input using Web Speech API.
 * Only renders when:
 * 1. Web Speech API is supported (Chrome/Edge)
 * 2. Voice input is enabled in settings
 */
export const VoiceInputButton = forwardRef(function VoiceInputButton(
  {
    onTranscript,
    onInterimTranscript,
    onListeningStart,
    onListeningStop,
    onPendingSpeechChange,
    disabled,
    className = "",
    speechMethod: selectedSpeechMethod,
    getTranscriptionContext,
    smartTurn,
  }: VoiceInputButtonProps,
  ref: ForwardedRef<VoiceInputButtonRef>,
) {
  const { t } = useI18n();
  const {
    voiceInputEnabled,
    speechMethod: storedSpeechMethod,
    hasStoredSpeechMethod,
    parakeetSpeechModel,
  } = useModelSettings();
  const { version: versionInfo } = useVersion();
  const { hasBrowserXaiSttApiKey } = useBrowserXaiSttApiKey();
  const connection = useConnection();
  const basePath = useRemoteBasePath();
  const { keepMicWarm, micDeviceId } = useSpeechCaptureSettings();
  const serverVoiceEnabled =
    versionInfo?.capabilities?.includes("voiceInput") ?? true;
  const speechMethod = useMemo(
    () =>
      selectedSpeechMethod ??
      resolveSpeechMethod(
        storedSpeechMethod,
        versionInfo?.voiceBackends,
        hasStoredSpeechMethod,
        { directXaiAvailable: hasBrowserXaiSttApiKey },
      ),
    [
      selectedSpeechMethod,
      storedSpeechMethod,
      versionInfo?.voiceBackends,
      hasStoredSpeechMethod,
      hasBrowserXaiSttApiKey,
    ],
  );
  const relayTransport = basePath !== "";
  const openRelayedSpeechSocket = useMemo(() => {
    const openSpeechSocket = connection.openSpeechSocket;
    if (!relayTransport || !openSpeechSocket) return undefined;
    return () => openSpeechSocket.call(connection);
  }, [connection, relayTransport]);
  const speechMethodServerRouted = isServerRoutedSpeechMethod(speechMethod);
  const serverStreaming = canSpeechMethodStream({
    methodId: speechMethod,
    serverCapabilities: versionInfo?.voiceBackendCapabilities,
    relayTransport,
    relayedServerSpeechAvailable:
      !speechMethodServerRouted || openRelayedSpeechSocket !== undefined,
  });
  const viewportWidth = useViewportWidth();

  // Show status text on desktop with sufficient width
  const showStatusText =
    !hasCoarsePointer() && viewportWidth >= 600 && voiceInputEnabled;

  const handleResult = useCallback(
    (transcript: string, metadata?: SpeechTranscriptionResultMetadata) => {
      onTranscript(transcript, metadata);
    },
    [onTranscript],
  );

  const handleInterim = useCallback(
    (transcript: string) => {
      onInterimTranscript?.(transcript);
    },
    [onInterimTranscript],
  );

  const {
    isSupported,
    isListening,
    status,
    toggleListening,
    stopListening,
    cancelProcessing,
    prewarm,
    error,
    interimTranscript,
  } = useSpeechRecognition({
    speechMethod,
    basePath,
    getTranscriptionContext,
    serverStreaming,
    smartTurn: serverStreaming ? smartTurn : undefined,
    keepMicWarm,
    micDeviceId,
    parakeetModel: parakeetSpeechModel,
    openRelayedSpeechSocket,
    onResult: handleResult,
    onInterimResult: handleInterim,
  });
  const isStarting = status === "starting";
  const isCapturing =
    isListening ||
    status === "listening" ||
    (status === "receiving" && isListening);
  const isFinalizing = status === "finalizing";
  const isBusy = isStarting || isFinalizing || status === "reconnecting";
  const isActive = isCapturing || isBusy;
  const isPressed = isCapturing || isStarting || status === "reconnecting";
  const isProcessing = status === "processing";
  // A cancellable in-progress speech state the composer surfaces as a chip.
  // Active capture is "listening"; the batch wait is "transcribing"; the
  // streaming flush is "finalizing". The chip's ✕ routes to the unified
  // cancel() (drops the non-final portion, keeps committed finals) in all three.
  const pendingKind: SpeechPendingKind | null = isProcessing
    ? "transcribing"
    : isFinalizing
      ? "finalizing"
      : isCapturing
        ? "listening"
        : null;

  const isAvailable = isSupported && voiceInputEnabled && serverVoiceEnabled;

  // Get display text for status
  const statusLabel = error || SPEECH_STATUS_LABELS[status];

  // Expose methods and state to parent
  useImperativeHandle(
    ref,
    () => ({
      stopAndFinalize: () => {
        const pending = interimTranscript;
        if (isActive) {
          stopListening();
        }
        return pending;
      },
      toggle: toggleListening,
      cancelProcessing,
      prewarm,
      isListening: isActive,
      isAvailable,
    }),
    [
      interimTranscript,
      isActive,
      cancelProcessing,
      prewarm,
      stopListening,
      toggleListening,
      isAvailable,
    ],
  );

  // Clear interim when listening stops
  useEffect(() => {
    if (!isCapturing && interimTranscript) {
      onInterimTranscript?.("");
    }
  }, [isCapturing, interimTranscript, onInterimTranscript]);

  useEffect(() => {
    onPendingSpeechChange?.(pendingKind);
    return () => {
      if (pendingKind) onPendingSpeechChange?.(null);
    };
  }, [pendingKind, onPendingSpeechChange]);

  // Handle click - toggle listening and notify when starting
  const handleClick = useCallback(() => {
    const wasActive = isActive;
    if (wasActive) {
      onListeningStop?.();
      toggleListening();
      return;
    }
    onListeningStart?.();
    toggleListening();
  }, [isActive, toggleListening, onListeningStart, onListeningStop]);

  // Don't render if not supported or disabled in settings
  if (!isAvailable) {
    return null;
  }

  // Determine status class for styling
  const statusClass =
    status === "error" || error
      ? "status-error"
      : status === "reconnecting"
        ? "status-reconnecting"
        : status === "finalizing"
          ? "status-finalizing"
        : status === "processing"
          ? "status-processing"
        : status === "starting"
          ? "status-starting"
          : status === "receiving"
            ? "status-receiving"
            : status === "listening"
              ? "status-listening"
              : "";

  const button = (
    <button
      type="button"
      className={`voice-input-button ${isCapturing ? "listening" : ""} ${isStarting ? "connecting" : ""} ${className}`}
      onClick={handleClick}
      disabled={disabled}
      title={
        error
          ? error
          : isFinalizing
            ? statusLabel
            : isActive
            ? t("voiceInputStop" as never)
            : t("voiceInputStart" as never)
      }
      aria-label={
        isFinalizing
          ? statusLabel
          : isActive
          ? t("voiceInputStopLabel" as never)
          : t("voiceInputStartLabel" as never)
      }
      aria-pressed={isPressed}
    >
      {isCapturing ? (
        // Recording indicator - animated bars (only once audio is actually
        // flowing; during "starting" we show the mic so the button does not
        // look like it is capturing before the pipeline is live).
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className="voice-input-recording"
        >
          <rect x="4" y="8" width="3" height="8" rx="1" className="bar bar-1" />
          <rect
            x="10.5"
            y="5"
            width="3"
            height="14"
            rx="1"
            className="bar bar-2"
          />
          <rect
            x="17"
            y="8"
            width="3"
            height="8"
            rx="1"
            className="bar bar-3"
          />
        </svg>
      ) : (
        // Microphone icon
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
    </button>
  );

  // If showing status text, wrap in container; otherwise just return the button.
  // Show during "starting" too so the user sees "Connecting..." instead of a
  // button that looks live before capture has actually begun. Errors break
  // through the desktop-only gate: on a phone (coarse pointer / narrow) the
  // status text is normally hidden, which left mic failures with no feedback
  // at all — the original complaint. An error must always be visible.
  if ((showStatusText && isActive) || error) {
    return (
      <div
        className={`voice-input-container ${isCapturing ? "listening" : ""} ${statusClass}`}
      >
        {button}
        <span className="voice-input-status">{statusLabel}</span>
      </div>
    );
  }

  return button;
});
