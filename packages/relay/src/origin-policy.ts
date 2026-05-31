export const DEFAULT_RELAY_ALLOWED_ORIGINS = [
  "https://yepanywhere.com",
  "https://*.yepanywhere.com",
  "https://ya.graehl.org",
] as const;

export interface ExactRelayOriginRule {
  type: "exact";
  origin: string;
}

export interface WildcardRelayOriginRule {
  type: "wildcard-subdomain";
  protocol: "http:" | "https:";
  hostnameSuffix: string;
  port: string;
}

export type RelayAllowedOriginRule =
  | ExactRelayOriginRule
  | WildcardRelayOriginRule;

export interface RelayAllowedOriginPolicy {
  allowAll: boolean;
  rules: RelayAllowedOriginRule[];
  invalidEntries: string[];
}

interface ParsedHttpOrigin {
  origin: string;
  protocol: "http:" | "https:";
  hostname: string;
  port: string;
}

function isHttpProtocol(protocol: string): protocol is "http:" | "https:" {
  return protocol === "http:" || protocol === "https:";
}

function normalizePort(protocol: "http:" | "https:", port: string): string {
  if (
    (protocol === "http:" && port === "80") ||
    (protocol === "https:" && port === "443")
  ) {
    return "";
  }
  return port;
}

function parseHttpOrigin(value: string): ParsedHttpOrigin | null {
  try {
    const url = new URL(value);
    if (!isHttpProtocol(url.protocol)) {
      return null;
    }
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return {
      origin: url.origin,
      protocol: url.protocol,
      hostname: url.hostname.toLowerCase(),
      port: url.port,
    };
  } catch {
    return null;
  }
}

function isValidHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) {
    return false;
  }
  const labels = hostname.split(".");
  return labels.every((label) => {
    if (!label || label.length > 63) {
      return false;
    }
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
  });
}

function parseWildcardRule(value: string): WildcardRelayOriginRule | null {
  const match = /^(https?):\/\/\*\.([^/:?#]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match) {
    return null;
  }
  const protocol = `${match[1]}:` as "http:" | "https:";
  const hostnameSuffix = match[2]?.toLowerCase() ?? "";
  if (!isValidHostname(hostnameSuffix)) {
    return null;
  }
  const portValue = match[3] ?? "";
  if (portValue) {
    const port = Number.parseInt(portValue, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
  }
  return {
    type: "wildcard-subdomain",
    protocol,
    hostnameSuffix,
    port: normalizePort(protocol, portValue),
  };
}

function parseRule(value: string): RelayAllowedOriginRule | null {
  const wildcard = parseWildcardRule(value);
  if (wildcard) {
    return wildcard;
  }

  const exact = parseHttpOrigin(value);
  if (!exact) {
    return null;
  }
  return { type: "exact", origin: exact.origin };
}

function ruleKey(rule: RelayAllowedOriginRule): string {
  if (rule.type === "exact") {
    return `exact:${rule.origin}`;
  }
  return `wildcard:${rule.protocol}//*.${rule.hostnameSuffix}:${rule.port}`;
}

function getEntries(
  value: string | undefined,
  defaults: readonly string[],
): string[] {
  if (value === undefined || value.trim() === "") {
    return [...defaults];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseRelayAllowedOrigins(
  value: string | undefined,
  defaults: readonly string[] = DEFAULT_RELAY_ALLOWED_ORIGINS,
): RelayAllowedOriginPolicy {
  const entries = getEntries(value, defaults);
  if (entries.includes("*")) {
    return { allowAll: true, rules: [], invalidEntries: [] };
  }

  const seen = new Set<string>();
  const rules: RelayAllowedOriginRule[] = [];
  const invalidEntries: string[] = [];

  for (const entry of entries) {
    const rule = parseRule(entry);
    if (!rule) {
      invalidEntries.push(entry);
      continue;
    }

    const key = ruleKey(rule);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rules.push(rule);
  }

  return { allowAll: false, rules, invalidEntries };
}

export function isRelayOriginAllowed(
  origin: string | undefined,
  policy: RelayAllowedOriginPolicy,
): boolean {
  if (origin === undefined) {
    return true;
  }
  const trimmedOrigin = origin.trim();
  if (!trimmedOrigin) {
    return false;
  }
  if (policy.allowAll) {
    return true;
  }

  const parsed = parseHttpOrigin(trimmedOrigin);
  if (!parsed) {
    return false;
  }

  return policy.rules.some((rule) => {
    if (rule.type === "exact") {
      return parsed.origin === rule.origin;
    }
    if (parsed.protocol !== rule.protocol || parsed.port !== rule.port) {
      return false;
    }
    return (
      parsed.hostname !== rule.hostnameSuffix &&
      parsed.hostname.endsWith(`.${rule.hostnameSuffix}`)
    );
  });
}

export function getRelayCorsAllowOrigin(
  origin: string,
  policy: RelayAllowedOriginPolicy,
): string | null {
  const trimmedOrigin = origin.trim();
  if (!trimmedOrigin) {
    return null;
  }
  if (policy.allowAll) {
    return "*";
  }
  return isRelayOriginAllowed(trimmedOrigin, policy) ? trimmedOrigin : null;
}
