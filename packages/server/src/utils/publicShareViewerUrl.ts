import {
  DEFAULT_YA_CLIENT_BASE_URL,
  buildYaClientPublicShareBaseUrl,
  buildYaClientPublicShareUrl,
  normalizeYaClientBaseUrl,
  normalizeYaClientBaseUrlFromShareViewerUrl,
} from "@yep-anywhere/shared";

const YA_CLIENT_BASE_URL_ENV = "YEP_CLIENT_BASE_URL";

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

export function resolveYaClientBaseUrl(
  configured?: string | null,
  legacyShareViewerBaseUrl?: string | null,
): string {
  if (configured) {
    return normalizeYaClientBaseUrl(configured);
  }

  const envYaClientBaseUrl = process.env[YA_CLIENT_BASE_URL_ENV];
  if (envYaClientBaseUrl) {
    return normalizeYaClientBaseUrl(envYaClientBaseUrl);
  }

  if (legacyShareViewerBaseUrl) {
    return normalizeYaClientBaseUrlFromShareViewerUrl(legacyShareViewerBaseUrl);
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
