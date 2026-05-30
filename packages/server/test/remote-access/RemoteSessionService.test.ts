import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt } from "../../src/crypto/nacl-wrapper.js";
import { RemoteSessionService } from "../../src/remote-access/RemoteSessionService.js";

describe("RemoteSessionService", () => {
  let service: RemoteSessionService;
  let testDir: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testDir = path.join(os.tmpdir(), `remote-session-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    service = new RemoteSessionService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    service.shutdown();
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("createSession", () => {
    it("creates a new session", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe("string");

      const session = service.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session?.username).toBe("testuser");
    });

    it("stores session key correctly", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      const storedKey = service.getSessionKey(sessionId);
      expect(storedKey).not.toBeNull();
      // Compare as arrays since getSessionKey returns Buffer, not Uint8Array
      // biome-ignore lint/style/noNonNullAssertion: We just asserted it's not null
      expect(Array.from(storedKey!)).toEqual(Array.from(sessionKey));
    });

    it("generates unique session IDs", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId1 = await service.createSession("user1", sessionKey);
      const sessionId2 = await service.createSession("user2", sessionKey);

      expect(sessionId1).not.toBe(sessionId2);
    });

    it("enforces max sessions per user", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);

      // Create 5 sessions (the max)
      const sessions: string[] = [];
      for (let i = 0; i < 5; i++) {
        // Small delay to ensure different lastUsed times
        await new Promise((resolve) => setTimeout(resolve, 10));
        const id = await service.createSession("testuser", sessionKey);
        sessions.push(id);
      }

      // Create a 6th session - oldest should be evicted
      const newSessionId = await service.createSession("testuser", sessionKey);

      // First session should be gone
      expect(service.getSession(sessions[0])).toBeNull();

      // New session should exist
      expect(service.getSession(newSessionId)).not.toBeNull();

      // User should have exactly 5 sessions
      expect(service.getSessionCount("testuser")).toBe(5);
    });
  });

  describe("getSession", () => {
    it("returns null for non-existent session", () => {
      const session = service.getSession("nonexistent");
      expect(session).toBeNull();
    });

    it("returns session for valid session ID", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      const session = service.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session?.sessionId).toBe(sessionId);
      expect(session?.username).toBe("testuser");
    });
  });

  describe("validateProof", () => {
    it("validates correct proof", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      // Generate a valid proof (encrypted timestamp + sessionId + challenge)
      const timestamp = Date.now();
      const proofData = JSON.stringify({ timestamp, sessionId, challenge });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        challenge,
      );
      expect(validatedSession).not.toBeNull();
      expect(validatedSession?.sessionId).toBe(sessionId);
    });

    it("rejects proof with wrong session key", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const wrongKey = new Uint8Array(32).fill(0x43);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      // Generate proof with wrong key
      const timestamp = Date.now();
      const proofData = JSON.stringify({ timestamp, sessionId, challenge });
      const { nonce, ciphertext } = encrypt(proofData, wrongKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        challenge,
      );
      expect(validatedSession).toBeNull();
    });

    it("rejects proof with old timestamp", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      // Generate proof with timestamp 10 minutes ago (> 5 min max age)
      const oldTimestamp = Date.now() - 10 * 60 * 1000;
      const proofData = JSON.stringify({
        timestamp: oldTimestamp,
        sessionId,
        challenge,
      });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        challenge,
      );
      expect(validatedSession).toBeNull();
    });

    it("accepts proof within the 5 minute skew window", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      const timestamp = Date.now() - 4 * 60 * 1000;
      const proofData = JSON.stringify({ timestamp, sessionId, challenge });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        challenge,
      );
      expect(validatedSession).not.toBeNull();
      expect(validatedSession?.sessionId).toBe(sessionId);
    });

    it("rejects proof with wrong challenge", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      const timestamp = Date.now();
      const proofData = JSON.stringify({
        timestamp,
        sessionId,
        challenge: "challenge-a",
      });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        "challenge-b",
      );
      expect(validatedSession).toBeNull();
    });

    it("rejects proof with mismatched sessionId in payload", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      const timestamp = Date.now();
      const proofData = JSON.stringify({
        timestamp,
        sessionId: "different-session-id",
        challenge,
      });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        challenge,
      );
      expect(validatedSession).toBeNull();
    });

    it("rejects proof for non-existent session", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const challenge = "test-challenge";

      const timestamp = Date.now();
      const proofData = JSON.stringify({
        timestamp,
        sessionId: "nonexistent",
        challenge,
      });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        "nonexistent",
        proof,
        challenge,
      );
      expect(validatedSession).toBeNull();
    });

    it("updates lastUsed on successful validation", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      const sessionBefore = service.getSession(sessionId);
      const lastUsedBefore = sessionBefore?.lastUsed;

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Validate proof
      const timestamp = Date.now();
      const proofData = JSON.stringify({ timestamp, sessionId, challenge });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      await service.validateProof(sessionId, proof, challenge);

      const sessionAfter = service.getSession(sessionId);
      expect(sessionAfter?.lastUsed).not.toBe(lastUsedBefore);
    });
  });

  describe("deleteSession", () => {
    it("deletes an existing session", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      expect(service.getSession(sessionId)).not.toBeNull();

      await service.deleteSession(sessionId);

      expect(service.getSession(sessionId)).toBeNull();
    });

    it("handles deleting non-existent session gracefully", async () => {
      await expect(service.deleteSession("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("invalidateUserSessions", () => {
    it("invalidates all sessions for a user", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);

      // Create multiple sessions for testuser
      const session1 = await service.createSession("testuser", sessionKey);
      const session2 = await service.createSession("testuser", sessionKey);

      // Create session for different user
      const otherSession = await service.createSession("otheruser", sessionKey);

      const count = await service.invalidateUserSessions("testuser");

      expect(count).toBe(2);
      expect(service.getSession(session1)).toBeNull();
      expect(service.getSession(session2)).toBeNull();
      expect(service.getSession(otherSession)).not.toBeNull();
    });

    it("returns 0 when user has no sessions", async () => {
      const count = await service.invalidateUserSessions("nonexistent");
      expect(count).toBe(0);
    });
  });

  describe("getSessionCount", () => {
    it("returns correct count for user", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);

      await service.createSession("testuser", sessionKey);
      await service.createSession("testuser", sessionKey);
      await service.createSession("otheruser", sessionKey);

      expect(service.getSessionCount("testuser")).toBe(2);
      expect(service.getSessionCount("otheruser")).toBe(1);
      expect(service.getSessionCount("nonexistent")).toBe(0);
    });
  });

  describe("persistence", () => {
    it("does not persist sessions to disk by default", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      // Shutdown current service
      service.shutdown();

      // Create a new service instance pointing to same directory
      const newService = new RemoteSessionService({ dataDir: testDir });
      await newService.initialize();

      // Session should not exist after restart in default in-memory mode
      const session = newService.getSession(sessionId);
      expect(session).toBeNull();

      newService.shutdown();
    });

    it("persists sessions to disk when enabled", async () => {
      await service.setDiskPersistenceEnabled(true);

      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      service.shutdown();

      const newService = new RemoteSessionService({ dataDir: testDir });
      await newService.setDiskPersistenceEnabled(true);
      await newService.initialize();

      const session = newService.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session?.username).toBe("testuser");

      newService.shutdown();
    });

    it("deletes persisted session file when persistence is disabled", async () => {
      await service.setDiskPersistenceEnabled(true);
      await service.createSession("testuser", new Uint8Array(32).fill(0x42));

      const filePath = path.join(testDir, "remote-sessions.json");
      await expect(fs.stat(filePath)).resolves.toBeTruthy();

      await service.setDiskPersistenceEnabled(false);

      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("file permissions", () => {
    it("writes remote-sessions.json with 0600 permissions", async () => {
      if (process.platform === "win32") {
        return;
      }

      await service.setDiskPersistenceEnabled(true);
      const sessionKey = new Uint8Array(32).fill(0x42);
      await service.createSession("testuser", sessionKey);

      const filePath = path.join(testDir, "remote-sessions.json");
      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("tightens permissions on existing remote-sessions.json files at startup", async () => {
      if (process.platform === "win32") {
        return;
      }

      const filePath = path.join(testDir, "remote-sessions.json");
      await fs.writeFile(
        filePath,
        JSON.stringify({ version: 1, sessions: {} }, null, 2),
        "utf-8",
      );
      await fs.chmod(filePath, 0o644);

      const newService = new RemoteSessionService({ dataDir: testDir });
      await newService.setDiskPersistenceEnabled(true);
      await newService.initialize();

      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);

      newService.shutdown();
    });
  });

  describe("session expiry", () => {
    it("expires sessions past max lifetime", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      // Get session and manually set createdAt to 31 days ago
      const session = service.getSession(sessionId);
      expect(session).not.toBeNull();

      // Access internal state to manipulate for testing
      const state = (
        service as unknown as {
          state: { sessions: Record<string, { createdAt: string }> };
        }
      ).state;
      state.sessions[sessionId].createdAt = new Date(
        Date.now() - 31 * 24 * 60 * 60 * 1000,
      ).toISOString();

      // Now getSession should return null (expired)
      expect(service.getSession(sessionId)).toBeNull();
    });

    it("expires sessions past idle timeout", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      // Get session and manually set lastUsed to 8 days ago
      const session = service.getSession(sessionId);
      expect(session).not.toBeNull();

      // Access internal state to manipulate for testing
      const state = (
        service as unknown as {
          state: { sessions: Record<string, { lastUsed: string }> };
        }
      ).state;
      state.sessions[sessionId].lastUsed = new Date(
        Date.now() - 8 * 24 * 60 * 60 * 1000,
      ).toISOString();

      // Now getSession should return null (expired)
      expect(service.getSession(sessionId)).toBeNull();
    });
  });
});
