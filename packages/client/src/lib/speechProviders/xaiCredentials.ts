import { fetchJSON } from "../../api/client";
import { getServerScoped, LEGACY_KEYS, setServerScoped } from "../storageKeys";

export type XaiSttCredentialSource = "browser-local" | "server-borrowed";

export interface XaiSttCredential {
  apiKey: string;
  source: XaiSttCredentialSource;
}

export type XaiSttStreamingSecretSource = "browser-local" | "server-ephemeral";

export interface XaiSttStreamingSecret {
  clientSecret: string;
  expiresAt?: string;
  source: XaiSttStreamingSecretSource;
}

interface XaiClientKeyResponse {
  apiKey?: string;
}

interface XaiClientSecretResponse {
  clientSecret?: string;
  expiresAt?: string;
}

const XAI_STT_KEY_STORAGE = "xaiSttApiKey";
const XAI_STT_KEY_CHANGE_EVENT = "ya:xai-stt-api-key-change";

export function getBrowserXaiSttApiKey(): string {
  return (
    getServerScoped(XAI_STT_KEY_STORAGE, LEGACY_KEYS.xaiSttApiKey)?.trim() ?? ""
  );
}

export function hasBrowserXaiSttApiKey(): boolean {
  return getBrowserXaiSttApiKey().length > 0;
}

export function setBrowserXaiSttApiKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  const previous = getBrowserXaiSttApiKey();
  setServerScoped(XAI_STT_KEY_STORAGE, trimmed, LEGACY_KEYS.xaiSttApiKey);
  if (previous !== trimmed && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(XAI_STT_KEY_CHANGE_EVENT));
  }
}

export function subscribeBrowserXaiSttApiKey(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = () => listener();
  window.addEventListener(XAI_STT_KEY_CHANGE_EVENT, listener);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(XAI_STT_KEY_CHANGE_EVENT, listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export async function getXaiSttCredential(): Promise<XaiSttCredential> {
  const browserKey = getBrowserXaiSttApiKey();
  if (browserKey) {
    return { apiKey: browserKey, source: "browser-local" };
  }

  const response = await fetchJSON<XaiClientKeyResponse>(
    "/speech/xai-client-key",
    { method: "POST" },
  );
  const apiKey = response.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "No xAI STT key available. Add a browser key in Speech settings or enable server key borrowing.",
    );
  }
  return { apiKey, source: "server-borrowed" };
}

export async function getXaiSttStreamingSecret(): Promise<XaiSttStreamingSecret> {
  const browserKey = getBrowserXaiSttApiKey();
  if (browserKey) {
    return { clientSecret: browserKey, source: "browser-local" };
  }

  const response = await fetchJSON<XaiClientSecretResponse>(
    "/speech/xai-client-secret",
    { method: "POST" },
  );
  const clientSecret = response.clientSecret?.trim();
  if (!clientSecret) {
    throw new Error(
      "No xAI STT streaming secret available. Add a browser key in Speech settings or configure the YA server xAI STT key.",
    );
  }
  return {
    clientSecret,
    expiresAt: response.expiresAt,
    source: "server-ephemeral",
  };
}
