import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELAY_ALLOWED_ORIGINS,
  isRelayOriginAllowed,
  parseRelayAllowedOrigins,
} from "../src/origin-policy.js";

describe("parseRelayAllowedOrigins", () => {
  it("uses Yep Anywhere production defaults when unset", () => {
    const policy = parseRelayAllowedOrigins(undefined);

    expect(policy.allowAll).toBe(false);
    expect(policy.invalidEntries).toEqual([]);
    expect(policy.rules).toHaveLength(DEFAULT_RELAY_ALLOWED_ORIGINS.length);
    expect(isRelayOriginAllowed("https://yepanywhere.com", policy)).toBe(true);
    expect(
      isRelayOriginAllowed("https://staging.yepanywhere.com", policy),
    ).toBe(true);
    expect(
      isRelayOriginAllowed("https://preview.foo.yepanywhere.com", policy),
    ).toBe(true);
    expect(isRelayOriginAllowed("https://ya.graehl.org", policy)).toBe(true);
  });

  it("parses exact origins and normalizes default ports", () => {
    const policy = parseRelayAllowedOrigins(
      "https://example.com:443, http://localhost:3403",
      [],
    );

    expect(policy.invalidEntries).toEqual([]);
    expect(isRelayOriginAllowed("https://example.com", policy)).toBe(true);
    expect(isRelayOriginAllowed("https://example.com:443", policy)).toBe(true);
    expect(isRelayOriginAllowed("http://localhost:3403", policy)).toBe(true);
    expect(isRelayOriginAllowed("http://example.com", policy)).toBe(false);
    expect(isRelayOriginAllowed("http://localhost:3404", policy)).toBe(false);
  });

  it("parses wildcard subdomain origins without matching the apex", () => {
    const policy = parseRelayAllowedOrigins("https://*.example.com", []);

    expect(policy.invalidEntries).toEqual([]);
    expect(isRelayOriginAllowed("https://app.example.com", policy)).toBe(true);
    expect(isRelayOriginAllowed("https://deep.app.example.com", policy)).toBe(
      true,
    );
    expect(isRelayOriginAllowed("https://example.com", policy)).toBe(false);
    expect(isRelayOriginAllowed("https://badexample.com", policy)).toBe(false);
    expect(isRelayOriginAllowed("http://app.example.com", policy)).toBe(false);
  });

  it("honors wildcard ports", () => {
    const policy = parseRelayAllowedOrigins("http://*.example.test:8080", []);

    expect(isRelayOriginAllowed("http://app.example.test:8080", policy)).toBe(
      true,
    );
    expect(isRelayOriginAllowed("http://app.example.test", policy)).toBe(false);
  });

  it("supports an explicit allow-all policy", () => {
    const policy = parseRelayAllowedOrigins("https://example.com, *", []);

    expect(policy).toEqual({ allowAll: true, rules: [], invalidEntries: [] });
    expect(isRelayOriginAllowed("https://evil.example", policy)).toBe(true);
    expect(isRelayOriginAllowed("not an origin", policy)).toBe(true);
  });

  it("allows missing Origin but rejects empty, null, and malformed Origins", () => {
    const policy = parseRelayAllowedOrigins("https://example.com", []);

    expect(isRelayOriginAllowed(undefined, policy)).toBe(true);
    expect(isRelayOriginAllowed("", policy)).toBe(false);
    expect(isRelayOriginAllowed("null", policy)).toBe(false);
    expect(isRelayOriginAllowed("not an origin", policy)).toBe(false);
  });

  it("rejects config entries with paths, queries, hashes, or unsupported schemes", () => {
    const policy = parseRelayAllowedOrigins(
      [
        "https://example.com/path",
        "https://example.com?x=1",
        "https://example.com#x",
        "wss://example.com",
        "https://*.example.com/path",
        "https://*.example.com:99999",
        "https://valid.example",
      ].join(","),
      [],
    );

    expect(policy.invalidEntries).toEqual([
      "https://example.com/path",
      "https://example.com?x=1",
      "https://example.com#x",
      "wss://example.com",
      "https://*.example.com/path",
      "https://*.example.com:99999",
    ]);
    expect(isRelayOriginAllowed("https://valid.example", policy)).toBe(true);
    expect(isRelayOriginAllowed("https://example.com", policy)).toBe(false);
    expect(isRelayOriginAllowed("https://app.example.com", policy)).toBe(false);
  });

  it("deduplicates equivalent entries", () => {
    const policy = parseRelayAllowedOrigins(
      "https://example.com, https://example.com:443, https://*.example.com, https://*.example.com:443",
      [],
    );

    expect(policy.invalidEntries).toEqual([]);
    expect(policy.rules).toHaveLength(2);
  });
});
