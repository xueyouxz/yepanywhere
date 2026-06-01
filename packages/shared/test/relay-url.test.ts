import { describe, expect, it } from "vitest";
import { DEFAULT_RELAY_URL, normalizeRelayUrl } from "../src/relay-url.js";

describe("normalizeRelayUrl", () => {
  it("keeps the default relay canonical", () => {
    expect(normalizeRelayUrl(DEFAULT_RELAY_URL)).toBe(DEFAULT_RELAY_URL);
  });

  it("accepts a bare relay host", () => {
    expect(normalizeRelayUrl("relay.graehl.org")).toBe(
      "wss://relay.graehl.org/ws",
    );
    expect(normalizeRelayUrl("192.168.1.25:4400")).toBe(
      "wss://192.168.1.25:4400/ws",
    );
  });

  it("converts HTTP origins to websocket relay URLs", () => {
    expect(normalizeRelayUrl("https://relay.graehl.org")).toBe(
      "wss://relay.graehl.org/ws",
    );
    expect(normalizeRelayUrl("http://localhost:4400")).toBe(
      "ws://localhost:4400/ws",
    );
  });

  it("preserves explicit non-root relay paths", () => {
    expect(normalizeRelayUrl("wss://relay.example.com/custom/")).toBe(
      "wss://relay.example.com/custom",
    );
  });

  it("rejects non-websocket-style URLs and URL extras", () => {
    expect(() => normalizeRelayUrl("ftp://relay.example.com")).toThrow(
      "Relay URL must use ws:// or wss://",
    );
    expect(() => normalizeRelayUrl("relay.example.com/ws?debug=1")).toThrow(
      "Relay URL must not include query or hash",
    );
    expect(() => normalizeRelayUrl("wss://user@relay.example.com/ws")).toThrow(
      "Relay URL must not include credentials",
    );
  });
});
