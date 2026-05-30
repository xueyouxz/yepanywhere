/**
 * Catalog of known speech-recognition methods exposed in the UI.
 *
 * The `browser-native` method is always known but gated on
 * `window.SpeechRecognition`. Server-routed methods are only shown
 * when the server advertises them via the `voiceBackends` capability
 * field on the version response.
 */

import {
  detectBrowserNativeLabel,
  formatBrowserNativeLabel,
} from "./browserNativeLabel";

export type SpeechMethodId =
  | "browser-native"
  | "ya-dummy"
  | "ya-deepgram"
  | "ya-whisper";

export const DEFAULT_SPEECH_METHOD: SpeechMethodId = "browser-native";

export interface SpeechMethodDescriptor {
  id: SpeechMethodId;
  label: string;
  description?: string;
  /** True if this method can run without a server-side backend. */
  clientSupported: boolean;
  /** True if this method requires a server-side backend. */
  serverRouted: boolean;
}

function browserNativeAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: unknown })
        .webkitSpeechRecognition,
  );
}

export function describeBrowserNative(
  userAgent?: string,
): SpeechMethodDescriptor {
  const label = detectBrowserNativeLabel(userAgent);
  return {
    id: "browser-native",
    label: formatBrowserNativeLabel(label),
    description: label.likelySupported
      ? "Runs in the browser; no audio leaves this device."
      : "This browser is unlikely to support Web Speech recognition.",
    clientSupported: browserNativeAvailable() && label.likelySupported,
    serverRouted: false,
  };
}

export function describeYaDummy(): SpeechMethodDescriptor {
  return {
    id: "ya-dummy",
    label: "YA dummy (test only)",
    description: "Fake server backend that echoes a canned transcript.",
    clientSupported: true,
    serverRouted: true,
  };
}

export function describeYaDeepgram(): SpeechMethodDescriptor {
  return {
    id: "ya-deepgram",
    label: "Deepgram (cloud)",
    description: "Server-routed cloud transcription with keyterm boosting.",
    clientSupported: true,
    serverRouted: true,
  };
}

export function describeYaWhisper(): SpeechMethodDescriptor {
  return {
    id: "ya-whisper",
    label: "Local Whisper (CPU)",
    description: "Server-local faster-whisper model; no audio leaves the server.",
    clientSupported: true,
    serverRouted: true,
  };
}

/**
 * Build the speech method list from what the server advertises plus
 * the local browser-native option. Only advertised server backends
 * appear in the selector — no phantom options for unconfigured backends.
 */
export function getSpeechMethods(
  serverBackends: string[] = [],
  userAgent?: string,
): SpeechMethodDescriptor[] {
  const methods: SpeechMethodDescriptor[] = [describeBrowserNative(userAgent)];

  for (const id of serverBackends) {
    switch (id) {
      case "ya-dummy":
        methods.push(describeYaDummy());
        break;
      case "ya-deepgram":
        methods.push(describeYaDeepgram());
        break;
      case "ya-whisper":
        methods.push(describeYaWhisper());
        break;
    }
  }

  return methods;
}

/** @deprecated Use getSpeechMethods(serverBackends) instead. */
export function getBuiltinSpeechMethods(
  userAgent?: string,
): SpeechMethodDescriptor[] {
  return [describeBrowserNative(userAgent), describeYaDummy()];
}

export function isKnownSpeechMethodId(value: string): value is SpeechMethodId {
  return (
    value === "browser-native" ||
    value === "ya-dummy" ||
    value === "ya-deepgram" ||
    value === "ya-whisper"
  );
}
