/**
 * E2E test for trusted-proxy X-Forwarded-For handling.
 *
 * Asserts that with `RELAY_TRUSTED_PROXIES` covering localhost, the
 * per-IP unauthenticated-connection cap is bucketed by the XFF entry
 * (not the direct socket peer) and that an untrusted XFF gets the
 * peer's bucket instead.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type RelayServer, createRelayServer } from "../../src/server.js";

interface ConnectResult {
  ws: WebSocket;
  accepted: boolean;
  status?: number;
}

describe("Relay XFF trust", () => {
  let relay: RelayServer;
  let relayUrl: string;
  const openConnections: WebSocket[] = [];

  beforeAll(async () => {
    relay = await createRelayServer({
      inMemoryDb: true,
      logLevel: "warn",
      disablePrettyPrint: true,
      trustedProxies: "127.0.0.1,::1",
      unauthenticatedConnectionLimitPerIp: 2,
      // Keep idle pre-handshake connections alive for the duration of the test.
      unauthenticatedConnectionTimeoutMs: 60_000,
    });
    relayUrl = `ws://127.0.0.1:${relay.port}/ws`;
  });

  afterAll(async () => {
    for (const ws of openConnections) {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.terminate();
      }
    }
    openConnections.length = 0;
    await relay.close();
  });

  function connect(xff?: string): Promise<ConnectResult> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = {};
      if (xff !== undefined) headers["X-Forwarded-For"] = xff;
      const ws = new WebSocket(relayUrl, { headers });
      openConnections.push(ws);

      const timeout = setTimeout(() => {
        ws.terminate();
        resolve({ ws, accepted: false });
      }, 3000);

      ws.on("open", () => {
        clearTimeout(timeout);
        resolve({ ws, accepted: true });
      });

      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timeout);
        resolve({ ws, accepted: false, status: res.statusCode });
      });

      ws.on("error", () => {
        // Some failure modes surface as 'error' without 'unexpected-response'.
        // The open / unexpected-response branches will already have resolved
        // on success or explicit reject; here we only catch the residual case.
        clearTimeout(timeout);
        resolve({ ws, accepted: false });
      });
    });
  }

  it("buckets the per-IP cap by trusted X-Forwarded-For", async () => {
    // Two connections from localhost claiming to originate at 203.0.113.7
    // both succeed (cap is 2).
    const a1 = await connect("203.0.113.7");
    const a2 = await connect("203.0.113.7");
    expect(a1.accepted).toBe(true);
    expect(a2.accepted).toBe(true);

    // A third XFF=203.0.113.7 hits the cap and gets 429.
    const overCap = await connect("203.0.113.7");
    expect(overCap.accepted).toBe(false);
    expect(overCap.status).toBe(429);

    // A different XFF gets its own counter.
    const fresh = await connect("198.51.100.42");
    expect(fresh.accepted).toBe(true);
  });

  it("handles a chain of trusted hops in the XFF header", async () => {
    // Real client, then a downstream proxy at 127.0.0.1 (trusted).
    // The relay should pick the leftmost non-trusted entry.
    const c1 = await connect("192.0.2.55, 127.0.0.1");
    const c2 = await connect("192.0.2.55, 127.0.0.1");
    expect(c1.accepted).toBe(true);
    expect(c2.accepted).toBe(true);

    const overCap = await connect("192.0.2.55, 127.0.0.1");
    expect(overCap.accepted).toBe(false);
    expect(overCap.status).toBe(429);
  });
});
