import {
  DEFAULT_YA_CLIENT_BASE_URL,
  buildYaClientPublicShareBaseUrl,
  buildYaClientPublicShareUrl,
  normalizeYaClientBaseUrl,
  normalizeYaClientBaseUrlFromShareViewerUrl,
} from "@yep-anywhere/shared";

const NEW_YA_CLIENT_BASE_URL_ENV = "YEP_YA_CLIENT_BASE_URL";
const LEGACY_VIEWER_BASE_URL_ENV = "YEP_PUBLIC_SHARE_VIEWER_BASE_URL";
const LEGACY_VIEWER_ORIGIN_ENV = "YEP_PUBLIC_SHARE_ORIGIN";

export function getDefaultYaClientBaseUrl(): string {
  return DEFAULT_YA_CLIENT_BASE_URL;
}

export function getDefaultPublicShareViewerBaseUrl(): string {
  return buildYaClientPublicShareBaseUrl(DEFAULT_YA_CLIENT_BASE_URL);
}

export function normalizePublicShareViewerBaseUrl(raw: string): string {
  return buildYaClientPublicShareBaseUrl(
    normalizeYaClientBaseUrlFromShareViewerUrl(raw),
  );
}

function normalizeLegacyPublicShareOrigin(raw: string): string {
  return normalizeYaClientBaseUrl(raw);
}

export function resolveYaClientBaseUrl(
  configured?: string | null,
  legacyShareViewerBaseUrl?: string | null,
): string {
  if (configured) {
    return normalizeYaClientBaseUrl(configured);
  }

  const envYaClientBaseUrl = process.env[NEW_YA_CLIENT_BASE_URL_ENV];
  if (envYaClientBaseUrl) {
    return normalizeYaClientBaseUrl(envYaClientBaseUrl);
  }

  if (legacyShareViewerBaseUrl) {
    return normalizeYaClientBaseUrlFromShareViewerUrl(legacyShareViewerBaseUrl);
  }

  const legacyEnvBaseUrl = process.env[LEGACY_VIEWER_BASE_URL_ENV];
  if (legacyEnvBaseUrl) {
    return normalizeYaClientBaseUrlFromShareViewerUrl(legacyEnvBaseUrl);
  }

  const legacyOrigin = process.env[LEGACY_VIEWER_ORIGIN_ENV];
  if (legacyOrigin) {
    return normalizeLegacyPublicShareOrigin(legacyOrigin);
  }

  return DEFAULT_YA_CLIENT_BASE_URL;
}

export function resolvePublicShareViewerBaseUrl(
  configured?: string | null,
  legacyShareViewerBaseUrl?: string | null,
): string {
  return buildYaClientPublicShareBaseUrl(
    resolveYaClientBaseUrl(configured, legacyShareViewerBaseUrl),
  );
}

export function buildPublicShareViewerUrl(
  secret: string,
  yaClientBaseUrl: string,
): string {
  return buildYaClientPublicShareUrl(secret, yaClientBaseUrl);
}
