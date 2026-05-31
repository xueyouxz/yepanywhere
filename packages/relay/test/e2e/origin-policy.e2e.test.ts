import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type RelayServer, createRelayServer } from "../../src/server.js";

interface ConnectResult {
  ws: WebSocket;
  accepted: boolean;
  status?: number;
}

describe("Relay origin policy", () => {
  let relay: RelayServer;
  let relayUrl: string;
  let relayHttpUrl: string;
  const openConnections: WebSocket[] = [];

  beforeAll(async () => {
    relay = await createRelayServer({
      inMemoryDb: true,
      logLevel: "warn",
      disablePrettyPrint: true,
      allowedOrigins: "https://allowed.example, https://*.yepanywhere.com",
      unauthenticatedConnectionTimeoutMs: 60_000,
    });
    relayUrl = `ws://127.0.0.1:${relay.port}/ws`;
    relayHttpUrl = `http://127.0.0.1:${relay.port}`;
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
    await relay?.close();
  });

  function connect(origin?: string): Promise<ConnectResult> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = {};
      if (origin !== undefined) headers.Origin = origin;
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
        clearTimeout(timeout);
        resolve({ ws, accepted: false });
      });
    });
  }

  it("allows websocket upgrades from exact allowed origins", async () => {
    const result = await connect("https://allowed.example");

    expect(result.accepted).toBe(true);
  });

  it("allows websocket upgrades from wildcard subdomain origins", async () => {
    const result = await connect("https://staging.yepanywhere.com");

    expect(result.accepted).toBe(true);
  });

  it("allows websocket upgrades with no Origin header", async () => {
    const result = await connect();

    expect(result.accepted).toBe(true);
  });

  it("rejects websocket upgrades from disallowed browser origins", async () => {
    const result = await connect("https://evil.example");

    expect(result.accepted).toBe(false);
    expect(result.status).toBe(403);
  });

  it("returns CORS headers for allowed origins", async () => {
    const response = await fetch(`${relayHttpUrl}/online/test-user`, {
      headers: { Origin: "https://allowed.example" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://allowed.example",
    );
  });

  it("omits CORS allow-origin for disallowed origins", async () => {
    const response = await fetch(`${relayHttpUrl}/online/test-user`, {
      headers: { Origin: "https://evil.example" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("mirrors CORS origin policy for preflight requests", async () => {
    const allowed = await fetch(`${relayHttpUrl}/online/test-user`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://staging.yepanywhere.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    const rejected = await fetch(`${relayHttpUrl}/online/test-user`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://staging.yepanywhere.com",
    );
    expect(rejected.status).toBe(204);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });
});
