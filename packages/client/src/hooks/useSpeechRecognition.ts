import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionSpeechSocket } from "../lib/connection/types";
import { BrowserNativeProvider } from "../lib/speechProviders/BrowserNativeProvider";
import { DirectXaiSpeechProvider } from "../lib/speechProviders/DirectXaiSpeechProvider";
import { YaServerProvider } from "../lib/speechProviders/YaServerProvider";
import { XAI_DIRECT_BATCH_SPEECH_METHOD } from "../lib/speechProviders/methods";
import {
  SPEECH_STATUS_LABELS as PROVIDER_SPEECH_STATUS_LABELS,
  type SpeechProvider,
  type SpeechProviderState,
  type SpeechProviderStatus,
  type SpeechSmartTurnSettings,
  type SpeechTranscriptionContext,
  type SpeechTranscriptionResultMetadata,
} from "../lib/speechProviders/SpeechProvider";

export interface UseSpeechRecognitionOptions {
  /** Language for recognition (default: browser default). */
  lang?: string;
  /** Selected speech method id (default: "browser-native"). */
  speechMethod?: string;
  /** Base path for relay/remote connections (used by YaServerProvider). */
  basePath?: string;
  /** Context attached to YA-server transcription requests. */
  getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;
  /** Whether the selected server backend should use YA speech streaming. */
  serverStreaming?: boolean;
  /** Smart Turn settings for streaming backends that support it. */
  smartTurn?: SpeechSmartTurnSettings;
  /** Keep the mic device warm between dictations (skips getUserMedia cold-open). */
  keepMicWarm?: boolean;
  /** Browser-local microphone device id for YA-server capture. */
  micDeviceId?: string | null;
  /** Dedicated secure relay speech socket opener. */
  openRelayedSpeechSocket?: () => Promise<ConnectionSpeechSocket>;
  /** Callback when final transcript is available. */
  onResult?: (
    transcript: string,
    metadata?: SpeechTranscriptionResultMetadata,
  ) => void;
  /** Callback for interim results (live transcription). */
  onInterimResult?: (transcript: string) => void;
  /** Callback when recognition ends. */
  onEnd?: () => void;
  /** Callback on error. */
  onError?: (error: string) => void;
}

export type SpeechRecognitionStatus = SpeechProviderStatus;
export const SPEECH_STATUS_LABELS = PROVIDER_SPEECH_STATUS_LABELS;

export interface UseSpeechRecognitionReturn {
  isSupported: boolean;
  isListening: boolean;
  status: SpeechRecognitionStatus;
  interimTranscript: string;
  startListening: () => void;
  stopListening: () => void;
  toggleListening: () => void;
  prewarm: () => void;
  error: string | null;
}

function createProvider(
  speechMethod: string | undefined,
  basePath: string,
  events: {
    lang?: string;
    getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;
    serverStreaming?: boolean;
    smartTurn?: SpeechSmartTurnSettings;
    keepMicWarm?: boolean;
    micDeviceId?: string | null;
    openRelayedSpeechSocket?: () => Promise<ConnectionSpeechSocket>;
    onResult?: (
      t: string,
      metadata?: SpeechTranscriptionResultMetadata,
    ) => void;
    onInterimResult?: (t: string) => void;
    onEnd?: () => void;
    onError?: (e: string) => void;
  },
): SpeechProvider {
  if (speechMethod === XAI_DIRECT_BATCH_SPEECH_METHOD) {
    return new DirectXaiSpeechProvider(events);
  }
  if (speechMethod && speechMethod !== "browser-native") {
    return new YaServerProvider(speechMethod, basePath, events);
  }
  return new BrowserNativeProvider({ lang: events.lang, ...events });
}

/**
 * Hook for using a pluggable speech-recognition provider.
 *
 * Selects BrowserNativeProvider or YaServerProvider based on
 * `speechMethod`. The provider owns all status/error/auto-restart
 * machinery; this hook is a thin subscription layer.
 */
export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {},
): UseSpeechRecognitionReturn {
  const {
    lang,
    speechMethod,
    basePath = "",
    getTranscriptionContext,
    serverStreaming,
    smartTurn,
    keepMicWarm,
    micDeviceId,
    openRelayedSpeechSocket,
    onResult,
    onInterimResult,
    onEnd,
    onError,
  } = options;

  const onResultRef = useRef(onResult);
  const onInterimResultRef = useRef(onInterimResult);
  const onEndRef = useRef(onEnd);
  const onErrorRef = useRef(onError);
  const getTranscriptionContextRef = useRef(getTranscriptionContext);
  useEffect(() => {
    onResultRef.current = onResult;
    onInterimResultRef.current = onInterimResult;
    onEndRef.current = onEnd;
    onErrorRef.current = onError;
    getTranscriptionContextRef.current = getTranscriptionContext;
  }, [onResult, onInterimResult, onEnd, onError, getTranscriptionContext]);

  const speechMethodRef = useRef(speechMethod);
  const basePathRef = useRef(basePath);
  const serverStreamingRef = useRef(serverStreaming);
  const smartTurnRef = useRef(smartTurn);
  const keepMicWarmRef = useRef(keepMicWarm);
  const micDeviceIdRef = useRef(micDeviceId);
  const openRelayedSpeechSocketRef = useRef(openRelayedSpeechSocket);

  const providerRef = useRef<SpeechProvider | null>(null);
  if (providerRef.current === null) {
    providerRef.current = createProvider(
      speechMethodRef.current,
      basePathRef.current,
      {
        lang,
        getTranscriptionContext: () => getTranscriptionContextRef.current?.(),
        serverStreaming: serverStreamingRef.current,
        smartTurn: smartTurnRef.current,
        keepMicWarm: keepMicWarmRef.current,
        micDeviceId: micDeviceIdRef.current,
        openRelayedSpeechSocket: openRelayedSpeechSocketRef.current,
        onResult: (t, metadata) => onResultRef.current?.(t, metadata),
        onInterimResult: (t) => onInterimResultRef.current?.(t),
        onEnd: () => onEndRef.current?.(),
        onError: (e) => onErrorRef.current?.(e),
      },
    );
  }

  const [state, setState] = useState<SpeechProviderState>(() =>
    providerRef.current!.getState(),
  );

  useEffect(() => {
    const provider = providerRef.current;
    if (!provider) return;
    return provider.subscribe(setState);
  }, []);

  // Recreate provider when speechMethod changes (stop the old one first)
  useEffect(() => {
    if (
      speechMethod === speechMethodRef.current &&
      serverStreaming === serverStreamingRef.current &&
      smartTurn === smartTurnRef.current &&
      keepMicWarm === keepMicWarmRef.current &&
      micDeviceId === micDeviceIdRef.current &&
      openRelayedSpeechSocket === openRelayedSpeechSocketRef.current
    ) {
      return;
    }
    speechMethodRef.current = speechMethod;
    basePathRef.current = basePath;
    serverStreamingRef.current = serverStreaming;
    smartTurnRef.current = smartTurn;
    keepMicWarmRef.current = keepMicWarm;
    micDeviceIdRef.current = micDeviceId;
    openRelayedSpeechSocketRef.current = openRelayedSpeechSocket;

    const old = providerRef.current;
    old?.dispose();

    const next = createProvider(speechMethod, basePath, {
      lang,
      getTranscriptionContext: () => getTranscriptionContextRef.current?.(),
      serverStreaming,
      smartTurn,
      keepMicWarm,
      micDeviceId,
      openRelayedSpeechSocket,
      onResult: (t, metadata) => onResultRef.current?.(t, metadata),
      onInterimResult: (t) => onInterimResultRef.current?.(t),
      onEnd: () => onEndRef.current?.(),
      onError: (e) => onErrorRef.current?.(e),
    });
    providerRef.current = next;
    setState(next.getState());
    next.subscribe(setState);
  }, [
    speechMethod,
    basePath,
    lang,
    serverStreaming,
    smartTurn,
    keepMicWarm,
    micDeviceId,
    openRelayedSpeechSocket,
  ]);

  useEffect(() => {
    return () => {
      providerRef.current?.dispose();
      providerRef.current = null;
    };
  }, []);

  const startListening = useCallback(() => {
    providerRef.current?.start();
  }, []);

  const stopListening = useCallback(() => {
    providerRef.current?.stop();
  }, []);

  const toggleListening = useCallback(() => {
    const provider = providerRef.current;
    if (!provider) return;
    const providerState = provider.getState();
    if (providerState.isListening || providerState.status === "starting") {
      provider.stop();
    } else {
      provider.start();
    }
  }, []);

  const prewarm = useCallback(() => {
    providerRef.current?.prewarm?.();
  }, []);

  return {
    isSupported: providerRef.current?.isSupported ?? false,
    isListening: state.isListening,
    status: state.status,
    interimTranscript: state.interimTranscript,
    startListening,
    stopListening,
    toggleListening,
    prewarm,
    error: state.error,
  };
}
