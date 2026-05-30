/**
 * Speech-recognition methods exposed in the UI.
 *
 * `browser-native` is the client-side escape hatch. Every server-routed
 * method comes directly from `/api/version.voiceBackends`; the client must not
 * keep an independent whitelist of backend ids.
 */

import {
  detectBrowserNativeLabel,
  formatBrowserNativeLabel,
} from "./browserNativeLabel";

export type SpeechMethodId = string;

export const DEFAULT_SPEECH_METHOD: SpeechMethodId = "browser-native";

const SERVER_BACKEND_PREFERENCE = ["ya-grok", "ya-deepgram"] as const;

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

function normalizeBackendLabelPart(part: string): string {
  if (!part) return part;
  return `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
}

function formatServerBackendLabel(id: string): string {
  const trimmed = id.trim();
  const withoutYaPrefix = trimmed.startsWith("ya-")
    ? trimmed.slice("ya-".length)
    : trimmed;
  const formatted =
    withoutYaPrefix
      .split(/[-_]+/)
      .filter(Boolean)
      .map(normalizeBackendLabelPart)
      .join(" ") || trimmed;
  return trimmed.startsWith("ya-") ? `YA ${formatted}` : formatted;
}

export function describeServerBackend(id: string): SpeechMethodDescriptor {
  return {
    id,
    label: formatServerBackendLabel(id),
    description: "Server-routed transcription through YA.",
    clientSupported: true,
    serverRouted: true,
  };
}

export function getOrderedServerSpeechBackends(
  serverBackends: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const unique = serverBackends
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id !== DEFAULT_SPEECH_METHOD)
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const rank = (id: string) => {
    const index = SERVER_BACKEND_PREFERENCE.indexOf(
      id as (typeof SERVER_BACKEND_PREFERENCE)[number],
    );
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  return unique
    .map((id, index) => ({ id, index }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.index - b.index)
    .map(({ id }) => id);
}

export function getPreferredSpeechMethod(
  serverBackends: readonly string[] = [],
): SpeechMethodId {
  return getOrderedServerSpeechBackends(serverBackends)[0] ?? DEFAULT_SPEECH_METHOD;
}

export function resolveSpeechMethod(
  storedMethod: SpeechMethodId,
  serverBackends: readonly string[] | undefined,
  hasStoredMethod: boolean,
): SpeechMethodId {
  if (serverBackends === undefined) {
    return hasStoredMethod ? storedMethod : DEFAULT_SPEECH_METHOD;
  }

  const activeServerBackends = getOrderedServerSpeechBackends(serverBackends);
  if (!hasStoredMethod) {
    return activeServerBackends[0] ?? DEFAULT_SPEECH_METHOD;
  }

  if (storedMethod === DEFAULT_SPEECH_METHOD) {
    return DEFAULT_SPEECH_METHOD;
  }

  return activeServerBackends.includes(storedMethod)
    ? storedMethod
    : DEFAULT_SPEECH_METHOD;
}

/**
 * Build the speech method list from what the server advertises plus
 * the local browser-native option. Only advertised server backends
 * appear in the selector — no phantom options for unconfigured backends.
 */
export function getSpeechMethods(
  serverBackends: readonly string[] = [],
  userAgent?: string,
): SpeechMethodDescriptor[] {
  return [
    ...getOrderedServerSpeechBackends(serverBackends).map(describeServerBackend),
    describeBrowserNative(userAgent),
  ];
}

/** @deprecated Use getSpeechMethods(serverBackends) instead. */
export function getBuiltinSpeechMethods(
  userAgent?: string,
): SpeechMethodDescriptor[] {
  return [describeBrowserNative(userAgent)];
}

export function isSpeechMethodId(value: string): value is SpeechMethodId {
  return value.trim().length > 0;
}
