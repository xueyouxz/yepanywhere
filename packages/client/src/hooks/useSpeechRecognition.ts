import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserNativeProvider } from "../lib/speechProviders/BrowserNativeProvider";
import { YaServerProvider } from "../lib/speechProviders/YaServerProvider";
import {
  SPEECH_STATUS_LABELS as PROVIDER_SPEECH_STATUS_LABELS,
  type SpeechProvider,
  type SpeechProviderState,
  type SpeechProviderStatus,
} from "../lib/speechProviders/SpeechProvider";

export interface UseSpeechRecognitionOptions {
  /** Language for recognition (default: browser default). */
  lang?: string;
  /** Selected speech method id (default: "browser-native"). */
  speechMethod?: string;
  /** Base path for relay/remote connections (used by YaServerProvider). */
  basePath?: string;
  /** Callback when final transcript is available. */
  onResult?: (transcript: string) => void;
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
  error: string | null;
}

function createProvider(
  speechMethod: string | undefined,
  basePath: string,
  events: {
    lang?: string;
    onResult?: (t: string) => void;
    onInterimResult?: (t: string) => void;
    onEnd?: () => void;
    onError?: (e: string) => void;
  },
): SpeechProvider {
  if (speechMethod && speechMethod !== "browser-native") {
    // Strip "ya-" prefix to get the backend id sent to the server
    const backendId = speechMethod.startsWith("ya-")
      ? speechMethod.slice(3)
      : speechMethod;
    return new YaServerProvider(backendId, basePath, events);
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
  const { lang, speechMethod, basePath = "", onResult, onInterimResult, onEnd, onError } =
    options;

  const onResultRef = useRef(onResult);
  const onInterimResultRef = useRef(onInterimResult);
  const onEndRef = useRef(onEnd);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onResultRef.current = onResult;
    onInterimResultRef.current = onInterimResult;
    onEndRef.current = onEnd;
    onErrorRef.current = onError;
  }, [onResult, onInterimResult, onEnd, onError]);

  const speechMethodRef = useRef(speechMethod);
  const basePathRef = useRef(basePath);

  const providerRef = useRef<SpeechProvider | null>(null);
  if (providerRef.current === null) {
    providerRef.current = createProvider(speechMethodRef.current, basePathRef.current, {
      lang,
      onResult: (t) => onResultRef.current?.(t),
      onInterimResult: (t) => onInterimResultRef.current?.(t),
      onEnd: () => onEndRef.current?.(),
      onError: (e) => onErrorRef.current?.(e),
    });
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
    if (speechMethod === speechMethodRef.current) return;
    speechMethodRef.current = speechMethod;
    basePathRef.current = basePath;

    const old = providerRef.current;
    old?.dispose();

    const next = createProvider(speechMethod, basePath, {
      lang,
      onResult: (t) => onResultRef.current?.(t),
      onInterimResult: (t) => onInterimResultRef.current?.(t),
      onEnd: () => onEndRef.current?.(),
      onError: (e) => onErrorRef.current?.(e),
    });
    providerRef.current = next;
    setState(next.getState());
    next.subscribe(setState);
  }, [speechMethod, basePath, lang]);

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
    if (provider.getState().isListening) {
      provider.stop();
    } else {
      provider.start();
    }
  }, []);

  return {
    isSupported: providerRef.current?.isSupported ?? false,
    isListening: state.isListening,
    status: state.status,
    interimTranscript: state.interimTranscript,
    startListening,
    stopListening,
    toggleListening,
    error: state.error,
  };
}
