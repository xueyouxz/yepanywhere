export const DEFAULT_YA_CLIENT_BASE_URL = "https://yepanywhere.com/remote";

const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function withDefaultScheme(raw: string): string {
  return URL_SCHEME_PATTERN.test(raw) ? raw : `https://${raw}`;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePath(pathname: string): string {
  const trimmed = trimTrailingSlashes(pathname);
  return trimmed === "/" ? "" : trimmed;
}

export function normalizeYaClientBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("YA URL is required");
  }

  let url: URL;
  try {
    url = new URL(withDefaultScheme(trimmed));
  } catch {
    throw new Error("YA URL must be a valid host or URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("YA URL must use http:// or https://");
  }
  if (!url.hostname) {
    throw new Error("YA URL must include a host");
  }
  if (url.username || url.password) {
    throw new Error("YA URL must not include credentials");
  }
  if (url.search || url.hash) {
    throw new Error("YA URL must not include query or hash");
  }

  const path = normalizePath(url.pathname);
  return `${url.origin}${path}`;
}

export function normalizeYaClientBaseUrlFromShareViewerUrl(
  raw: string,
): string {
  const normalized = normalizeYaClientBaseUrl(raw);
  const url = new URL(normalized);
  const pathSegments = normalizePath(url.pathname).split("/").filter(Boolean);
  if (pathSegments.at(-1) === "share") {
    pathSegments.pop();
    url.pathname = pathSegments.length ? `/${pathSegments.join("/")}` : "/";
    return normalizeYaClientBaseUrl(url.toString());
  }
  return normalized;
}

function buildYaClientUrl(baseUrl: string, segments: string[]): string {
  const normalized = normalizeYaClientBaseUrl(baseUrl);
  const url = new URL(normalized);
  const basePath = normalizePath(url.pathname);
  const encodedSegments = segments.map((segment) =>
    encodeURIComponent(segment),
  );
  url.pathname = [basePath, ...encodedSegments].filter(Boolean).join("/");
  if (!url.pathname.startsWith("/")) {
    url.pathname = `/${url.pathname}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function buildYaClientRelayLoginUrl(baseUrl: string): string {
  return buildYaClientUrl(baseUrl, ["login", "relay"]);
}

export function buildYaClientPublicShareBaseUrl(baseUrl: string): string {
  return buildYaClientUrl(baseUrl, ["share"]);
}

export function buildYaClientPublicShareUrl(
  secret: string,
  baseUrl: string,
): string {
  return buildYaClientUrl(baseUrl, ["share", secret]);
}
