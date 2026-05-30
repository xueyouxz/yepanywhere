import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  type TrustedProxy,
  getClientIp,
  parseTrustedProxies,
} from "../src/client-ip.js";

function makeReq(
  remoteAddress: string,
  xff?: string | string[],
): IncomingMessage {
  return {
    socket: { remoteAddress } as IncomingMessage["socket"],
    headers: xff !== undefined ? { "x-forwarded-for": xff } : {},
  } as IncomingMessage;
}

describe("parseTrustedProxies", () => {
  it("returns empty for undefined and empty string", () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies("")).toEqual([]);
    expect(parseTrustedProxies("   ,  ")).toEqual([]);
  });

  it("parses single IPv4 and IPv6 hosts", () => {
    const proxies = parseTrustedProxies("127.0.0.1, ::1");
    expect(proxies).toHaveLength(2);
    expect(proxies[0]?.v6).toBe(false);
    expect(proxies[0]?.maskBits).toBe(32);
    expect(proxies[1]?.v6).toBe(true);
    expect(proxies[1]?.maskBits).toBe(128);
  });

  it("parses CIDR ranges", () => {
    const proxies = parseTrustedProxies("10.0.0.0/8, fc00::/7");
    expect(proxies).toHaveLength(2);
    expect(proxies[0]?.maskBits).toBe(8);
    expect(proxies[1]?.maskBits).toBe(7);
  });

  it("drops malformed entries silently", () => {
    const proxies = parseTrustedProxies("not-an-ip, 127.0.0.1, 256.0.0.1, 10.0.0.0/33");
    expect(proxies).toHaveLength(1);
    expect(proxies[0]?.maskBits).toBe(32);
  });
});

describe("getClientIp", () => {
  const trusted: TrustedProxy[] = parseTrustedProxies("127.0.0.1, ::1, 10.0.0.0/8");

  it("returns peer when trustedProxies list is empty", () => {
    const req = makeReq("203.0.113.7", "1.2.3.4");
    expect(getClientIp(req, [])).toBe("203.0.113.7");
  });

  it("returns peer when peer is not trusted (XFF is ignored)", () => {
    const req = makeReq("203.0.113.7", "1.2.3.4");
    expect(getClientIp(req, trusted)).toBe("203.0.113.7");
  });

  it("returns the XFF entry when peer is a trusted proxy", () => {
    const req = makeReq("127.0.0.1", "203.0.113.7");
    expect(getClientIp(req, trusted)).toBe("203.0.113.7");
  });

  it("walks XFF rightwards skipping trusted hops", () => {
    const req = makeReq("127.0.0.1", "203.0.113.7, 10.0.0.5");
    expect(getClientIp(req, trusted)).toBe("203.0.113.7");
  });

  it("treats IPv4-mapped IPv6 peer as IPv4 for trust matching", () => {
    const req = makeReq("::ffff:127.0.0.1", "203.0.113.7");
    expect(getClientIp(req, trusted)).toBe("203.0.113.7");
  });

  it("falls back to peer when XFF is missing", () => {
    const req = makeReq("127.0.0.1");
    expect(getClientIp(req, trusted)).toBe("127.0.0.1");
  });

  it("falls back to peer when every XFF entry is itself trusted", () => {
    const req = makeReq("127.0.0.1", "10.0.0.5, 10.0.0.6");
    expect(getClientIp(req, trusted)).toBe("127.0.0.1");
  });

  it("handles multi-header XFF (array form)", () => {
    const req = makeReq("127.0.0.1", ["203.0.113.7", "10.0.0.5"]);
    expect(getClientIp(req, trusted)).toBe("203.0.113.7");
  });

  it("matches an IPv6 CIDR proxy", () => {
    const fc00 = parseTrustedProxies("fc00::/7");
    const req = makeReq("fd12:3456::1", "2001:db8::1");
    expect(getClientIp(req, fc00)).toBe("2001:db8::1");
  });
});
