export const DEFAULT_RELAY_URL = "wss://relay.yepanywhere.com/ws";

const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function withDefaultScheme(raw: string): string {
  return URL_SCHEME_PATTERN.test(raw) ? raw : `wss://${raw}`;
}

function normalizeRelayPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/ws";
}

export function normalizeRelayUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Relay URL is required");
  }

  let url: URL;
  try {
    url = new URL(withDefaultScheme(trimmed));
  } catch {
    throw new Error("Relay URL must be a valid host or URL");
  }

  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Relay URL must use ws:// or wss://");
  }
  if (!url.hostname) {
    throw new Error("Relay URL must include a host");
  }
  if (url.username || url.password) {
    throw new Error("Relay URL must not include credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Relay URL must not include query or hash");
  }

  url.pathname = normalizeRelayPath(url.pathname);
  return url.toString();
}
