import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredSession } from "../connection/SecureConnection";
import {
  getHostByRelayUsername,
  loadSavedHosts,
  upsertRelayHost,
} from "../hostStorage";
const TEST_SESSION: StoredSession = {
  wsUrl: "wss://relay.example/ws",
  username: "alice",
  sessionId: "session-123",
  sessionKey: "base64-session-key",
};

describe("upsertRelayHost", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a relay host with a stored session when one does not exist", () => {
    const host = upsertRelayHost({
      relayUrl: TEST_SESSION.wsUrl,
      relayUsername: "relay-alice",
      srpUsername: TEST_SESSION.username,
      session: TEST_SESSION,
    });

    expect(host.session).toEqual(TEST_SESSION);
    expect(host.lastConnected).toBeTruthy();
    expect(getHostByRelayUsername("relay-alice")?.id).toBe(host.id);
  });

  it("updates an existing relay host without replacing its identity", () => {
    const first = upsertRelayHost({
      relayUrl: TEST_SESSION.wsUrl,
      relayUsername: "relay-alice",
      srpUsername: TEST_SESSION.username,
    });

    const second = upsertRelayHost({
      relayUrl: TEST_SESSION.wsUrl,
      relayUsername: "relay-alice",
      srpUsername: TEST_SESSION.username,
      session: TEST_SESSION,
    });

    expect(second.id).toBe(first.id);
    expect(second.session).toEqual(TEST_SESSION);
    expect(loadSavedHosts().hosts).toHaveLength(1);
  });
});
