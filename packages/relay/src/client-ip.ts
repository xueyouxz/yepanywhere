import type { IncomingMessage } from "node:http";

export interface TrustedProxy {
  v6: boolean;
  netBig: bigint;
  maskBits: number;
}

/**
 * Parse a comma-separated list of IPs or CIDRs into normalized form.
 * Silently drops malformed entries.
 */
export function parseTrustedProxies(input: string | undefined): TrustedProxy[] {
  if (!input) return [];
  const out: TrustedProxy[] = [];
  for (const raw of input.split(",")) {
    const spec = raw.trim();
    if (!spec) continue;
    const parsed = parseCidr(spec);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Resolve the real client IP from an upgrade/HTTP request.
 *
 * When the immediate peer is one of the trusted proxies, walk
 * `X-Forwarded-For` from right (most recent) to left (original client),
 * skipping entries that are themselves trusted proxies. Return the first
 * non-trusted entry as the client IP. If trustedProxies is empty or the
 * peer is not trusted, return the socket address unchanged.
 */
export function getClientIp(
  request: IncomingMessage,
  trustedProxies: TrustedProxy[],
): string {
  const peer = request.socket.remoteAddress ?? "unknown";
  if (trustedProxies.length === 0) return peer;
  if (!ipMatchesAny(peer, trustedProxies)) return peer;

  const header = request.headers["x-forwarded-for"];
  const chain = Array.isArray(header) ? header.join(",") : header;
  if (!chain) return peer;

  const entries = chain
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i];
    if (candidate && !ipMatchesAny(candidate, trustedProxies)) return candidate;
  }
  return peer;
}

function ipMatchesAny(ip: string, nets: TrustedProxy[]): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  for (const net of nets) {
    if (net.v6 !== parsed.v6) continue;
    const totalBits = net.v6 ? 128 : 32;
    const hostBits = totalBits - net.maskBits;
    const mask =
      net.maskBits === 0
        ? 0n
        : ((1n << BigInt(net.maskBits)) - 1n) << BigInt(hostBits);
    if ((parsed.big & mask) === net.netBig) return true;
  }
  return false;
}

function parseCidr(spec: string): TrustedProxy | null {
  const slash = spec.indexOf("/");
  const ipPart = slash === -1 ? spec : spec.slice(0, slash);
  const maskPart = slash === -1 ? null : spec.slice(slash + 1);
  const ip = parseIp(ipPart);
  if (!ip) return null;
  const totalBits = ip.v6 ? 128 : 32;
  const maskBits = maskPart === null ? totalBits : Number.parseInt(maskPart, 10);
  if (!Number.isInteger(maskBits) || maskBits < 0 || maskBits > totalBits) {
    return null;
  }
  const hostBits = totalBits - maskBits;
  const mask =
    maskBits === 0 ? 0n : ((1n << BigInt(maskBits)) - 1n) << BigInt(hostBits);
  return { v6: ip.v6, netBig: ip.big & mask, maskBits };
}

function parseIp(s: string): { big: bigint; v6: boolean } | null {
  const stripped = s.includes("%") ? s.slice(0, s.indexOf("%")) : s;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(stripped);
  if (mapped?.[1]) return parseIpV4(mapped[1]);
  if (stripped.includes(":")) return parseIpV6(stripped);
  return parseIpV4(stripped);
}

function parseIpV4(s: string): { big: bigint; v6: false } | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let big = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    big = (big << 8n) | BigInt(n);
  }
  return { big, v6: false };
}

function parseIpV6(s: string): { big: bigint; v6: true } | null {
  const doubleColon = s.indexOf("::");
  let parts: string[];
  if (doubleColon === -1) {
    parts = s.split(":");
    if (parts.length !== 8) return null;
  } else {
    const head = s.slice(0, doubleColon);
    const tail = s.slice(doubleColon + 2);
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    parts = [...headParts, ...new Array<string>(missing).fill("0"), ...tailParts];
  }
  let big = 0n;
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
    big = (big << 16n) | BigInt(Number.parseInt(p, 16));
  }
  return { big, v6: true };
}
