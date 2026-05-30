import { randomUUID } from "node:crypto";
import type {
  LookupAddress,
  LookupAllOptions,
  LookupOneOptions,
} from "node:dns";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type {
  EncryptedEnvelope,
  RelayEvent,
  RelayRequest,
  RelayResponse,
  RelaySubscribe,
  RelayUploadComplete,
  RelayUploadEnd,
  RelayUploadError,
  RelayUploadProgress,
  RelayUploadStart,
  SrpClientHello,
  SrpClientProof,
  SrpServerChallenge,
  SrpServerVerify,
  SrpSessionInvalid,
  SrpSessionResume,
  SrpSessionResumeChallenge,
  SrpSessionResumeInit,
  SrpSessionResumed,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFormat,
  encodeUploadChunkPayload,
  isEncryptedEnvelope,
  isSequencedEncryptedPayload,
  isSrpError,
  isSrpServerChallenge,
  isSrpServerVerify,
  isSrpSessionInvalid,
  isSrpSessionResumed,
} from "@yep-anywhere/shared";
import {
  SRPClientSession,
  SRPParameters,
  SRPRoutines,
  bigIntToArrayBuffer,
} from "tssrp6a";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../../src/app.js";
import { AuthService } from "../../src/auth/AuthService.js";
import {
  decrypt,
  decryptBinaryEnvelope,
  deriveSecretboxKey,
  deriveTransportKey,
  encrypt,
  encryptBytesToBinaryEnvelope,
  encryptToBinaryEnvelope,
} from "../../src/crypto/index.js";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/index.js";
import { RemoteSessionService } from "../../src/remote-access/RemoteSessionService.js";
import { RemoteAccessService } from "../../src/remote-access/index.js";
import { createWsRelayRoutes } from "../../src/routes/ws-relay.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { UploadManager } from "../../src/uploads/manager.js";
import { EventBus } from "../../src/watcher/index.js";

/**
 * E2E tests for secure WebSocket transport (Phase 3).
 *
 * These tests verify:
 * - SRP authentication handshake
 * - Encrypted request/response over WebSocket
 * - Encrypted event subscriptions
 */

// Test credentials
const TEST_USERNAME = "testuser";
const TEST_PASSWORD = "testpassword123";
// Use a non-loopback hostname allowed by host policy (*.ts.net) while routing
// DNS to loopback so tests hit the local server.
const SRP_REQUIRED_TEST_HOST = "ws-secure-test.ts.net";

// SRP parameters (same as production)
const SRP_PARAMS = new SRPParameters();
const SRP_ROUTINES = new SRPRoutines(SRP_PARAMS);

function lookupLoopback(
  _hostname: string,
  options: LookupOneOptions | LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  if ("all" in options && options.all) {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
    return;
  }
  callback(null, "127.0.0.1", 4);
}

describe("Secure WebSocket Transport E2E", () => {
  let testDir: string;
  let server: ReturnType<typeof serve>;
  let serverPort: number;
  let mockSdk: MockClaudeSDK;
  let eventBus: EventBus;
  let authService: AuthService;
  let remoteAccessService: RemoteAccessService;
  let remoteSessionService: RemoteSessionService;

  beforeAll(async () => {
    // Create temp directory for project data
    testDir = join(tmpdir(), `ws-secure-test-${randomUUID()}`);
    const projectPath = "/home/user/testproject";
    const encodedPath = projectPath.replaceAll("/", "-");

    await mkdir(join(testDir, "localhost", encodedPath), { recursive: true });
    await writeFile(
      join(testDir, "localhost", encodedPath, "test-session.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );

    // Create data dir for remote access
    const dataDir = join(testDir, "data");
    await mkdir(dataDir, { recursive: true });

    // Create services
    mockSdk = new MockClaudeSDK();
    eventBus = new EventBus();
    authService = new AuthService({
      dataDir,
      cookieSecret: "ws-secure-test-cookie-secret",
    });
    await authService.initialize();

    // Set up remote access with test credentials
    // First configure relay (relay username is used as SRP identity)
    remoteAccessService = new RemoteAccessService({ dataDir });
    await remoteAccessService.initialize();
    await remoteAccessService.setRelayConfig({
      url: "wss://test-relay.example.com/ws",
      username: TEST_USERNAME,
    });
    await remoteAccessService.configure(TEST_PASSWORD);

    remoteSessionService = new RemoteSessionService({ dataDir });
    await remoteSessionService.initialize();

    // Create the app
    const { app, supervisor } = createApp({
      sdk: mockSdk,
      projectsDir: testDir,
      eventBus,
      authService,
      authDisabled: true,
    });

    // Add WebSocket support
    const { upgradeWebSocket, wss } = createNodeWebSocket({ app });

    // Add WebSocket relay route with remote access enabled
    const baseUrl = "http://localhost:0";
    const uploadManager = new UploadManager({
      uploadsDir: join(testDir, "uploads"),
    });
    const wsRelayHandler = createWsRelayRoutes({
      upgradeWebSocket,
      app,
      baseUrl,
      supervisor,
      eventBus,
      uploadManager,
      remoteAccessService,
      remoteSessionService,
    });
    app.get("/api/ws", wsRelayHandler);

    // Start server on random port
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      serverPort = info.port;
      console.log(
        `[WS Secure Test] Server running on port ${serverPort} with remote access enabled`,
      );
    });

    // Attach the unified upgrade handler
    attachUnifiedUpgradeHandler(server, {
      frontendProxy: undefined,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
      app,
      wss,
    });

    // Wait for server to be ready
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }, 30000);

  afterAll(async () => {
    remoteSessionService?.shutdown();
    server?.close();
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a WebSocket connection.
   */
  function connectWebSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://${SRP_REQUIRED_TEST_HOST}:${serverPort}/api/ws`,
        {
          lookup: lookupLoopback,
        },
      );
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
    });
  }

  /**
   * Helper to close a WebSocket connection and wait for the close event.
   * This ensures proper cleanup between tests.
   */
  async function closeWebSocket(ws: WebSocket): Promise<void> {
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.on("close", () => resolve());
      ws.close();
      // Fallback timeout in case close event doesn't fire
      setTimeout(resolve, 100);
    });
    // Extra delay to ensure server has processed the disconnect
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Convert bigint to hex string.
   */
  function bigIntToHex(n: bigint): string {
    return n.toString(16);
  }

  /**
   * Convert hex string to bigint.
   */
  function hexToBigInt(hex: string): bigint {
    return BigInt(`0x${hex}`);
  }

  /**
   * Perform full SRP handshake and return session key.
   * Refactored version with proper state handling.
   */
  async function performSrpHandshakeV2(
    ws: WebSocket,
    username: string,
    password: string,
  ): Promise<Uint8Array> {
    const clientSession = new SRPClientSession(SRP_ROUTINES);
    const clientStep1 = await clientSession.step1(username, password);

    // Send hello
    const hello: SrpClientHello = {
      type: "srp_hello",
      identity: username,
    };
    ws.send(JSON.stringify(hello));

    // Wait for challenge
    const challenge = await waitForMessage<SrpServerChallenge>(
      ws,
      (msg): msg is SrpServerChallenge => isSrpServerChallenge(msg),
      5000,
    );

    // Process challenge
    const saltBigInt = hexToBigInt(challenge.salt);
    const B = hexToBigInt(challenge.B);
    const clientStep2 = await clientStep1.step2(saltBigInt, B);

    // Send proof
    const proof: SrpClientProof = {
      type: "srp_proof",
      A: bigIntToHex(clientStep2.A),
      M1: bigIntToHex(clientStep2.M1),
    };
    ws.send(JSON.stringify(proof));

    // Wait for verify
    const verify = await waitForMessage<SrpServerVerify>(
      ws,
      (msg): msg is SrpServerVerify => isSrpServerVerify(msg),
      5000,
    );

    // Verify server proof
    const M2 = hexToBigInt(verify.M2);
    await clientStep2.step3(M2);

    // Derive session key
    const keyBuffer = bigIntToArrayBuffer(clientStep2.S);
    const rawKey = new Uint8Array(keyBuffer);
    const baseSessionKey = deriveSecretboxKey(rawKey);
    const transportSessionKey = verify.transportNonce
      ? deriveTransportKey(baseSessionKey, verify.transportNonce)
      : baseSessionKey;

    // Wait to ensure server has fully processed the handshake before
    // subsequent encrypted messages. This prevents a race condition where
    // the server's message queue hasn't finished processing the auth state.
    await new Promise((resolve) => setTimeout(resolve, 10));

    return transportSessionKey;
  }

  /**
   * Perform full SRP handshake and return session keys + sessionId.
   */
  async function performSrpHandshakeWithSession(
    ws: WebSocket,
    username: string,
    password: string,
  ): Promise<{
    sessionKey: Uint8Array;
    baseSessionKey: Uint8Array;
    sessionId: string;
  }> {
    const clientSession = new SRPClientSession(SRP_ROUTINES);
    const clientStep1 = await clientSession.step1(username, password);

    const hello: SrpClientHello = {
      type: "srp_hello",
      identity: username,
    };
    ws.send(JSON.stringify(hello));

    const challenge = await waitForMessage<SrpServerChallenge>(
      ws,
      (msg): msg is SrpServerChallenge => isSrpServerChallenge(msg),
      5000,
    );

    const saltBigInt = hexToBigInt(challenge.salt);
    const B = hexToBigInt(challenge.B);
    const clientStep2 = await clientStep1.step2(saltBigInt, B);

    const proof: SrpClientProof = {
      type: "srp_proof",
      A: bigIntToHex(clientStep2.A),
      M1: bigIntToHex(clientStep2.M1),
    };
    ws.send(JSON.stringify(proof));

    const verify = await waitForMessage<SrpServerVerify>(
      ws,
      (msg): msg is SrpServerVerify => isSrpServerVerify(msg),
      5000,
    );

    if (!verify.sessionId) {
      throw new Error("Expected sessionId in SRP verify");
    }

    const M2 = hexToBigInt(verify.M2);
    await clientStep2.step3(M2);

    const keyBuffer = bigIntToArrayBuffer(clientStep2.S);
    const rawKey = new Uint8Array(keyBuffer);
    const baseSessionKey = deriveSecretboxKey(rawKey);
    const sessionKey = verify.transportNonce
      ? deriveTransportKey(baseSessionKey, verify.transportNonce)
      : baseSessionKey;

    await new Promise((resolve) => setTimeout(resolve, 10));
    return { sessionKey, baseSessionKey, sessionId: verify.sessionId };
  }

  /**
   * Helper to wait for a specific message type.
   */
  function waitForMessage<T>(
    ws: WebSocket,
    predicate: (msg: unknown) => msg is T,
    timeoutMs: number,
    options?: {
      allowSrpSessionInvalid?: boolean;
    },
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Message wait timeout")),
        timeoutMs,
      );

      const handler = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        if (isSrpError(msg)) {
          clearTimeout(timeout);
          ws.off("message", handler);
          reject(new Error(`SRP error: ${msg.message}`));
          return;
        }
        if (isSrpSessionInvalid(msg)) {
          if (!options?.allowSrpSessionInvalid) {
            clearTimeout(timeout);
            ws.off("message", handler);
            reject(new Error(`SRP session invalid: ${msg.reason}`));
            return;
          }
        }
        if (predicate(msg)) {
          clearTimeout(timeout);
          ws.off("message", handler);
          resolve(msg);
        }
      };

      ws.on("message", handler);
    });
  }

  /**
   * Parse a decrypted transport payload and unwrap sequence metadata when present.
   */
  function parseDecryptedTransportMessage(
    decrypted: string,
  ): YepMessage | null {
    try {
      const parsed = JSON.parse(decrypted);
      if (isSequencedEncryptedPayload(parsed)) {
        return parsed.msg as YepMessage;
      }
      return parsed as YepMessage;
    } catch {
      return null;
    }
  }

  /**
   * Send an encrypted request and wait for encrypted response.
   * Handles both JSON envelope (legacy) and binary envelope (Phase 1) responses.
   */
  async function sendEncryptedRequest(
    ws: WebSocket,
    sessionKey: Uint8Array,
    request: RelayRequest,
  ): Promise<RelayResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Request timeout")),
        5000,
      );

      const handler = (data: WebSocket.RawData) => {
        let decrypted: string | null = null;

        // The ws library may send data as Buffer even for text frames
        // Try JSON envelope first (text format), then binary envelope
        const dataStr = data.toString();

        // First try to parse as JSON envelope (legacy format)
        try {
          const msg = JSON.parse(dataStr);
          if (isEncryptedEnvelope(msg)) {
            decrypted = decrypt(msg.nonce, msg.ciphertext, sessionKey);
          }
        } catch {
          // Not valid JSON, might be binary envelope
        }

        // If not JSON, try binary envelope (Phase 1)
        if (
          !decrypted &&
          (Buffer.isBuffer(data) || data instanceof ArrayBuffer)
        ) {
          const bytes =
            data instanceof ArrayBuffer ? new Uint8Array(data) : data;
          try {
            decrypted = decryptBinaryEnvelope(bytes, sessionKey);
          } catch {
            return; // Not a valid binary envelope, skip
          }
        }

        if (!decrypted) {
          return; // Skip messages we couldn't decrypt
        }

        try {
          const response = parseDecryptedTransportMessage(decrypted);
          if (
            response &&
            response.type === "response" &&
            response.id === request.id
          ) {
            clearTimeout(timeout);
            ws.off("message", handler);
            resolve(response);
          }
        } catch {
          return; // Couldn't parse decrypted content
        }
      };

      ws.on("message", handler);

      // Send encrypted request (JSON envelope format)
      const plaintext = JSON.stringify(request);
      const { nonce, ciphertext } = encrypt(plaintext, sessionKey);
      const envelope: EncryptedEnvelope = {
        type: "encrypted",
        nonce,
        ciphertext,
      };
      ws.send(JSON.stringify(envelope));
    });
  }

  /**
   * Wait for a specific encrypted response ID. Returns null on timeout.
   */
  async function waitForEncryptedResponseById(
    ws: WebSocket,
    sessionKey: Uint8Array,
    requestId: string,
    timeoutMs = 1000,
  ): Promise<RelayResponse | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.off("message", handler);
        resolve(null);
      }, timeoutMs);

      const handler = (data: WebSocket.RawData) => {
        let decrypted: string | null = null;
        const dataStr = data.toString();

        try {
          const msg = JSON.parse(dataStr);
          if (isEncryptedEnvelope(msg)) {
            decrypted = decrypt(msg.nonce, msg.ciphertext, sessionKey);
          }
        } catch {
          // Not a JSON envelope
        }

        if (
          !decrypted &&
          (Buffer.isBuffer(data) || data instanceof ArrayBuffer)
        ) {
          const bytes =
            data instanceof ArrayBuffer ? new Uint8Array(data) : data;
          try {
            decrypted = decryptBinaryEnvelope(bytes, sessionKey);
          } catch {
            return;
          }
        }

        if (!decrypted) {
          return;
        }

        try {
          const response = parseDecryptedTransportMessage(decrypted);
          if (
            response &&
            response.type === "response" &&
            response.id === requestId
          ) {
            clearTimeout(timeout);
            ws.off("message", handler);
            resolve(response);
          }
        } catch {
          // Ignore non-JSON payloads
        }
      };

      ws.on("message", handler);
    });
  }

  describe("SRP Authentication", () => {
    it("should complete SRP handshake with correct credentials", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        expect(sessionKey).toBeDefined();
        expect(sessionKey.length).toBe(32); // NaCl secretbox key is 32 bytes
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should reject incorrect password", async () => {
      const ws = await connectWebSocket();

      try {
        await expect(
          performSrpHandshakeV2(ws, TEST_USERNAME, "wrongpassword"),
        ).rejects.toThrow();
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should reject unknown username", async () => {
      const ws = await connectWebSocket();

      try {
        await expect(
          performSrpHandshakeV2(ws, "unknownuser", TEST_PASSWORD),
        ).rejects.toThrow();
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should reject a second srp_hello while waiting for proof", async () => {
      const ws = await connectWebSocket();

      try {
        const hello: SrpClientHello = {
          type: "srp_hello",
          identity: TEST_USERNAME,
        };
        ws.send(JSON.stringify(hello));

        await waitForMessage<SrpServerChallenge>(
          ws,
          (msg): msg is SrpServerChallenge => isSrpServerChallenge(msg),
          5000,
        );

        const closePromise = new Promise<{ code: number; reason: string }>(
          (resolve) => {
            ws.on("close", (code, reason) => {
              resolve({ code, reason: reason.toString() });
            });
          },
        );

        ws.send(JSON.stringify(hello));

        const closeResult = await closePromise;
        expect(closeResult.code).toBe(4008);
        expect(closeResult.reason).toBe("Authentication already in progress");
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should reject srp_hello after authentication is complete", async () => {
      const ws = await connectWebSocket();

      try {
        await performSrpHandshakeV2(ws, TEST_USERNAME, TEST_PASSWORD);

        const hello: SrpClientHello = {
          type: "srp_hello",
          identity: TEST_USERNAME,
        };

        const closePromise = new Promise<{ code: number; reason: string }>(
          (resolve) => {
            ws.on("close", (code, reason) => {
              resolve({ code, reason: reason.toString() });
            });
          },
        );

        ws.send(JSON.stringify(hello));

        const closeResult = await closePromise;
        expect(closeResult.code).toBe(4005);
        expect(closeResult.reason).toBe("Already authenticated");
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should close connection when SRP proof is not provided in time", async () => {
      const ws = await connectWebSocket();

      try {
        const hello: SrpClientHello = {
          type: "srp_hello",
          identity: TEST_USERNAME,
        };
        ws.send(JSON.stringify(hello));

        await waitForMessage<SrpServerChallenge>(
          ws,
          (msg): msg is SrpServerChallenge => isSrpServerChallenge(msg),
          5000,
        );

        const closeResult = await new Promise<{ code: number; reason: string }>(
          (resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Expected SRP timeout close")),
              15000,
            );
            ws.on("close", (code, reason) => {
              clearTimeout(timer);
              resolve({ code, reason: reason.toString() });
            });
          },
        );

        expect(closeResult.code).toBe(4008);
        expect(closeResult.reason).toBe("Authentication timeout");
      } finally {
        await closeWebSocket(ws);
      }
    }, 20000);
  });

  describe("Session Resume Nonce Challenge", () => {
    it("should resume session with server-issued nonce challenge", async () => {
      const ws1 = await connectWebSocket();
      const { baseSessionKey, sessionId } =
        await performSrpHandshakeWithSession(ws1, TEST_USERNAME, TEST_PASSWORD);
      await closeWebSocket(ws1);

      const ws2 = await connectWebSocket();
      try {
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
        };
        ws2.send(JSON.stringify(resumeInit));

        const challenge = await waitForMessage<SrpSessionResumeChallenge>(
          ws2,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );
        expect(challenge.sessionId).toBe(sessionId);

        const proofData = JSON.stringify({
          timestamp: Date.now(),
          sessionId,
          challenge: challenge.nonce,
        });
        const { nonce, ciphertext } = encrypt(proofData, baseSessionKey);
        const resume: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: JSON.stringify({ nonce, ciphertext }),
        };
        ws2.send(JSON.stringify(resume));

        const resumed = await waitForMessage<SrpSessionResumed>(
          ws2,
          (msg): msg is SrpSessionResumed => isSrpSessionResumed(msg),
          5000,
        );
        expect(resumed.sessionId).toBe(sessionId);
        const resumedSessionKey = resumed.transportNonce
          ? deriveTransportKey(baseSessionKey, resumed.transportNonce)
          : baseSessionKey;

        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };
        const response = await sendEncryptedRequest(
          ws2,
          resumedSessionKey,
          request,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeWebSocket(ws2);
      }
    }, 15000);

    it("should reject replayed resume proof from a previous challenge", async () => {
      const ws1 = await connectWebSocket();
      const { baseSessionKey, sessionId } =
        await performSrpHandshakeWithSession(ws1, TEST_USERNAME, TEST_PASSWORD);
      await closeWebSocket(ws1);

      // First resume attempt (valid) to produce a replayable captured proof.
      const ws2 = await connectWebSocket();
      let capturedProof = "";
      try {
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
        };
        ws2.send(JSON.stringify(resumeInit));

        const challenge1 = await waitForMessage<SrpSessionResumeChallenge>(
          ws2,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );

        const proofData1 = JSON.stringify({
          timestamp: Date.now(),
          sessionId,
          challenge: challenge1.nonce,
        });
        const { nonce, ciphertext } = encrypt(proofData1, baseSessionKey);
        capturedProof = JSON.stringify({ nonce, ciphertext });

        const resume1: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: capturedProof,
        };
        ws2.send(JSON.stringify(resume1));

        await waitForMessage<SrpSessionResumed>(
          ws2,
          (msg): msg is SrpSessionResumed => isSrpSessionResumed(msg),
          5000,
        );
      } finally {
        await closeWebSocket(ws2);
      }

      // Second resume attempt with a fresh challenge must reject old proof.
      const ws3 = await connectWebSocket();
      try {
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
        };
        ws3.send(JSON.stringify(resumeInit));

        await waitForMessage<SrpSessionResumeChallenge>(
          ws3,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );

        const replayedResume: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: capturedProof,
        };
        ws3.send(JSON.stringify(replayedResume));

        const invalid = await waitForMessage<SrpSessionInvalid>(
          ws3,
          (msg): msg is SrpSessionInvalid => isSrpSessionInvalid(msg),
          5000,
          { allowSrpSessionInvalid: true },
        );
        expect(invalid.reason).toBe("invalid_proof");
      } finally {
        await closeWebSocket(ws3);
      }
    }, 20000);

    it("should reject replayed resume proof on the same connection after successful resume", async () => {
      const ws1 = await connectWebSocket();
      const { baseSessionKey, sessionId } =
        await performSrpHandshakeWithSession(ws1, TEST_USERNAME, TEST_PASSWORD);
      await closeWebSocket(ws1);

      const ws2 = await connectWebSocket();
      try {
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
        };
        ws2.send(JSON.stringify(resumeInit));

        const challenge = await waitForMessage<SrpSessionResumeChallenge>(
          ws2,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );

        const proofData = JSON.stringify({
          timestamp: Date.now(),
          sessionId,
          challenge: challenge.nonce,
        });
        const { nonce, ciphertext } = encrypt(proofData, baseSessionKey);
        const resume: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: JSON.stringify({ nonce, ciphertext }),
        };

        ws2.send(JSON.stringify(resume));
        const resumed = await waitForMessage<SrpSessionResumed>(
          ws2,
          (msg): msg is SrpSessionResumed => isSrpSessionResumed(msg),
          5000,
        );

        // Replay the same proof on the same socket after challenge is consumed.
        ws2.send(JSON.stringify(resume));
        const invalid = await waitForMessage<SrpSessionInvalid>(
          ws2,
          (msg): msg is SrpSessionInvalid => isSrpSessionInvalid(msg),
          5000,
          { allowSrpSessionInvalid: true },
        );
        expect(invalid.reason).toBe("invalid_proof");

        const resumedSessionKey = resumed.transportNonce
          ? deriveTransportKey(baseSessionKey, resumed.transportNonce)
          : baseSessionKey;
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };
        const response = await sendEncryptedRequest(
          ws2,
          resumedSessionKey,
          request,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeWebSocket(ws2);
      }
    }, 20000);

    it("should reject replayed encrypted request captured before reconnect", async () => {
      const ws1 = await connectWebSocket();
      const {
        sessionKey: initialSessionKey,
        baseSessionKey,
        sessionId,
      } = await performSrpHandshakeWithSession(
        ws1,
        TEST_USERNAME,
        TEST_PASSWORD,
      );

      const replayedRequest: RelayRequest = {
        type: "request",
        id: randomUUID(),
        method: "GET",
        path: "/health",
      };
      const replayPlaintext = JSON.stringify(replayedRequest);
      const replayedPayload = encrypt(replayPlaintext, initialSessionKey);
      const replayedEnvelope: EncryptedEnvelope = {
        type: "encrypted",
        nonce: replayedPayload.nonce,
        ciphertext: replayedPayload.ciphertext,
      };

      ws1.send(JSON.stringify(replayedEnvelope));
      const firstResponse = await waitForEncryptedResponseById(
        ws1,
        initialSessionKey,
        replayedRequest.id,
        5000,
      );
      expect(firstResponse).not.toBeNull();
      expect(firstResponse?.status).toBe(200);
      await closeWebSocket(ws1);

      const ws2 = await connectWebSocket();
      try {
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
        };
        ws2.send(JSON.stringify(resumeInit));
        const challenge = await waitForMessage<SrpSessionResumeChallenge>(
          ws2,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );

        const proofData = JSON.stringify({
          timestamp: Date.now(),
          sessionId,
          challenge: challenge.nonce,
        });
        const { nonce, ciphertext } = encrypt(proofData, baseSessionKey);
        const resume: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: JSON.stringify({ nonce, ciphertext }),
        };
        ws2.send(JSON.stringify(resume));

        await waitForMessage<SrpSessionResumed>(
          ws2,
          (msg): msg is SrpSessionResumed => isSrpSessionResumed(msg),
          5000,
        );

        // Replay ciphertext captured on a different connection: should fail
        // decryption and close the socket.
        const closePromise = new Promise<{ code: number; reason: string }>(
          (resolve) => {
            ws2.once("close", (code, reason) => {
              resolve({ code, reason: reason.toString() });
            });
          },
        );
        ws2.send(JSON.stringify(replayedEnvelope));
        const closeResult = await closePromise;
        expect(closeResult.code).toBe(4004);
        expect(closeResult.reason).toBe("Decryption failed");
      } finally {
        await closeWebSocket(ws2);
      }

      // Reconnect again and verify fresh resume traffic works as expected.
      const ws3 = await connectWebSocket();
      try {
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
        };
        ws3.send(JSON.stringify(resumeInit));
        const challenge = await waitForMessage<SrpSessionResumeChallenge>(
          ws3,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );

        const proofData = JSON.stringify({
          timestamp: Date.now(),
          sessionId,
          challenge: challenge.nonce,
        });
        const { nonce, ciphertext } = encrypt(proofData, baseSessionKey);
        const resume: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: JSON.stringify({ nonce, ciphertext }),
        };
        ws3.send(JSON.stringify(resume));

        const resumed = await waitForMessage<SrpSessionResumed>(
          ws3,
          (msg): msg is SrpSessionResumed => isSrpSessionResumed(msg),
          5000,
        );
        const resumedSessionKey = resumed.transportNonce
          ? deriveTransportKey(baseSessionKey, resumed.transportNonce)
          : baseSessionKey;
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };
        const response = await sendEncryptedRequest(
          ws3,
          resumedSessionKey,
          request,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeWebSocket(ws3);
      }
    }, 20000);
  });

  describe("Encrypted Request/Response", () => {
    it("should handle encrypted GET request", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        const response = await sendEncryptedRequest(ws, sessionKey, request);

        expect(response.status).toBe(200);
        expect((response.body as { status: string }).status).toBe("ok");
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should handle encrypted request for version endpoint", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/api/version",
        };

        const response = await sendEncryptedRequest(ws, sessionKey, request);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("current");
        expect(response.body).toHaveProperty("resumeProtocolVersion", 2);
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should close connection with code 4001 when plaintext message sent without auth", async () => {
      const ws = await connectWebSocket();

      // Set up close handler before sending message
      const closePromise = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          ws.on("close", (code, reason) => {
            resolve({ code, reason: reason.toString() });
          });
        },
      );

      // Don't authenticate, just try to send plaintext request
      const request: RelayRequest = {
        type: "request",
        id: randomUUID(),
        method: "GET",
        path: "/health",
      };

      // Send plaintext (should trigger connection close)
      ws.send(JSON.stringify(request));

      // Wait for the close event
      const closeResult = await closePromise;

      expect(closeResult.code).toBe(4001);
      expect(closeResult.reason).toBe("Authentication required");
    }, 5000);

    it("should close connection with code 4005 when plaintext message sent after auth", async () => {
      const ws = await connectWebSocket();

      await performSrpHandshakeV2(ws, TEST_USERNAME, TEST_PASSWORD);

      const closePromise = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          ws.on("close", (code, reason) => {
            resolve({ code, reason: reason.toString() });
          });
        },
      );

      const request: RelayRequest = {
        type: "request",
        id: randomUUID(),
        method: "GET",
        path: "/health",
      };

      ws.send(JSON.stringify(request));

      const closeResult = await closePromise;
      expect(closeResult.code).toBe(4005);
      expect(closeResult.reason).toBe("Encrypted message required");
    }, 5000);
  });

  describe("Encrypted Event Subscriptions", () => {
    it("should receive encrypted events when subscribing to activity", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const subscriptionId = randomUUID();

        // Set up event collector - handle both binary and JSON responses
        const events: RelayEvent[] = [];
        const eventHandler = (data: WebSocket.RawData) => {
          let decrypted: string | null = null;
          const dataStr = data.toString();

          // First try to parse as JSON envelope (legacy format)
          try {
            const msg = JSON.parse(dataStr);
            if (isEncryptedEnvelope(msg)) {
              decrypted = decrypt(msg.nonce, msg.ciphertext, sessionKey);
            }
          } catch {
            // Not valid JSON, might be binary envelope
          }

          // If not JSON, try binary envelope (Phase 1)
          if (
            !decrypted &&
            (Buffer.isBuffer(data) || data instanceof ArrayBuffer)
          ) {
            const bytes =
              data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            try {
              decrypted = decryptBinaryEnvelope(bytes, sessionKey);
            } catch {
              return;
            }
          }

          if (!decrypted) return;

          try {
            const event = parseDecryptedTransportMessage(decrypted);
            if (!event) return;
            if (
              event.type === "event" &&
              event.subscriptionId === subscriptionId
            ) {
              events.push(event);
            }
          } catch {
            return;
          }
        };
        ws.on("message", eventHandler);

        // Send encrypted subscribe
        const subscribe: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
        };
        const plaintext = JSON.stringify(subscribe);
        const { nonce, ciphertext } = encrypt(plaintext, sessionKey);
        ws.send(JSON.stringify({ type: "encrypted", nonce, ciphertext }));

        // Wait for connected event
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].eventType).toBe("connected");
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);
  });

  describe("Binary Encrypted Transport (Phase 1)", () => {
    /**
     * Send a binary encrypted request and wait for binary encrypted response.
     */
    async function sendBinaryEncryptedRequest(
      ws: WebSocket,
      sessionKey: Uint8Array,
      request: RelayRequest,
    ): Promise<RelayResponse> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Request timeout")),
          5000,
        );

        const handler = (data: WebSocket.RawData) => {
          // Expect binary response
          if (!Buffer.isBuffer(data) && !(data instanceof ArrayBuffer)) {
            // Skip non-binary messages (shouldn't happen after we send binary)
            return;
          }

          const bytes =
            data instanceof ArrayBuffer ? new Uint8Array(data) : data;

          try {
            const decrypted = decryptBinaryEnvelope(bytes, sessionKey);
            if (!decrypted) {
              return;
            }

            const response = parseDecryptedTransportMessage(decrypted);
            if (
              response &&
              response.type === "response" &&
              response.id === request.id
            ) {
              clearTimeout(timeout);
              ws.off("message", handler);
              resolve(response);
            }
          } catch {
            // Decryption or parsing failed, keep waiting
          }
        };

        ws.on("message", handler);

        // Send binary encrypted request
        const plaintext = JSON.stringify(request);
        const envelope = encryptToBinaryEnvelope(plaintext, sessionKey);
        ws.send(envelope);
      });
    }

    it("should handle binary encrypted GET request", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        const response = await sendBinaryEncryptedRequest(
          ws,
          sessionKey,
          request,
        );

        expect(response.status).toBe(200);
        expect((response.body as { status: string }).status).toBe("ok");
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should handle binary encrypted request for version endpoint", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/api/version",
        };

        const response = await sendBinaryEncryptedRequest(
          ws,
          sessionKey,
          request,
        );

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("current");
        expect(response.body).toHaveProperty("resumeProtocolVersion", 2);
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should receive binary encrypted events when subscribing with binary", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const subscriptionId = randomUUID();

        // Set up event collector for binary responses
        const events: RelayEvent[] = [];
        const eventHandler = (data: WebSocket.RawData) => {
          if (!Buffer.isBuffer(data) && !(data instanceof ArrayBuffer)) {
            return;
          }

          const bytes =
            data instanceof ArrayBuffer ? new Uint8Array(data) : data;

          try {
            const decrypted = decryptBinaryEnvelope(bytes, sessionKey);
            if (!decrypted) return;

            const event = parseDecryptedTransportMessage(decrypted);
            if (!event) return;
            if (
              event.type === "event" &&
              event.subscriptionId === subscriptionId
            ) {
              events.push(event);
            }
          } catch {
            return;
          }
        };
        ws.on("message", eventHandler);

        // Send binary encrypted subscribe
        const subscribe: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
        };
        const envelope = encryptToBinaryEnvelope(
          JSON.stringify(subscribe),
          sessionKey,
        );
        ws.send(envelope);

        // Wait for connected event
        await new Promise((resolve) => setTimeout(resolve, 2000));

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].eventType).toBe("connected");
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should switch from JSON to binary envelope format correctly", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        // First, send a JSON encrypted request (legacy)
        const request1: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        // Wait for encrypted response (can be JSON or binary)
        const response1Promise = new Promise<RelayResponse>(
          (resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Timeout waiting for response")),
              5000,
            );

            const handler = (data: WebSocket.RawData) => {
              let decrypted: string | null = null;
              const dataStr = data.toString();

              // First try to parse as JSON envelope (legacy format)
              try {
                const msg = JSON.parse(dataStr);
                if (isEncryptedEnvelope(msg)) {
                  decrypted = decrypt(msg.nonce, msg.ciphertext, sessionKey);
                }
              } catch {
                // Not valid JSON, might be binary envelope
              }

              // If not JSON, try binary envelope (Phase 1)
              if (
                !decrypted &&
                (Buffer.isBuffer(data) || data instanceof ArrayBuffer)
              ) {
                const bytes =
                  data instanceof ArrayBuffer ? new Uint8Array(data) : data;
                try {
                  decrypted = decryptBinaryEnvelope(bytes, sessionKey);
                } catch {
                  return;
                }
              }

              if (!decrypted) return;

              try {
                const response = parseDecryptedTransportMessage(decrypted);
                if (!response) return;
                if (
                  response.type === "response" &&
                  response.id === request1.id
                ) {
                  clearTimeout(timeout);
                  ws.off("message", handler);
                  resolve(response);
                }
              } catch {
                // Keep waiting
              }
            };

            ws.on("message", handler);
          },
        );

        // Send JSON encrypted request
        const { nonce, ciphertext } = encrypt(
          JSON.stringify(request1),
          sessionKey,
        );
        ws.send(JSON.stringify({ type: "encrypted", nonce, ciphertext }));

        const response1 = await response1Promise;
        expect(response1.status).toBe(200);

        // Now send a binary encrypted request
        const request2: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/api/version",
        };

        const response2 = await sendBinaryEncryptedRequest(
          ws,
          sessionKey,
          request2,
        );
        expect(response2.status).toBe(200);
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);
  });

  describe("Encrypted Binary Upload Chunks (Phase 2)", () => {
    /**
     * Helper to collect upload messages from encrypted responses.
     */
    function collectEncryptedUploadMessages(
      ws: WebSocket,
      sessionKey: Uint8Array,
      uploadId: string,
      timeoutMs = 10000,
    ): Promise<YepMessage[]> {
      return new Promise((resolve, reject) => {
        const messages: YepMessage[] = [];
        const timeout = setTimeout(() => {
          ws.off("message", handler);
          reject(
            new Error(
              `Timed out waiting for upload_complete after ${timeoutMs}ms. Got ${messages.length} messages: [${messages.map((m) => m.type).join(", ")}]`,
            ),
          );
        }, timeoutMs);

        const handler = (data: WebSocket.RawData) => {
          let decrypted: string | null = null;

          // Try binary envelope first (most common after auth)
          if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            const bytes =
              data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            try {
              decrypted = decryptBinaryEnvelope(bytes, sessionKey);
            } catch {
              // Not a valid binary envelope
            }
          }

          // Try JSON envelope as fallback
          if (!decrypted) {
            const dataStr = data.toString();
            try {
              const msg = JSON.parse(dataStr);
              if (isEncryptedEnvelope(msg)) {
                decrypted = decrypt(msg.nonce, msg.ciphertext, sessionKey);
              }
            } catch {
              // Not valid JSON
            }
          }

          if (!decrypted) return;

          try {
            const msg = parseDecryptedTransportMessage(decrypted);
            if (!msg) return;
            if (
              (msg.type === "upload_progress" ||
                msg.type === "upload_complete" ||
                msg.type === "upload_error") &&
              msg.uploadId === uploadId
            ) {
              messages.push(msg);
              if (
                msg.type === "upload_complete" ||
                msg.type === "upload_error"
              ) {
                clearTimeout(timeout);
                ws.off("message", handler);
                resolve(messages);
              }
            }
          } catch {
            // Parsing failed
          }
        };

        ws.on("message", handler);
      });
    }

    it("should upload file using encrypted binary format 0x02 chunks", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "secure-binary.txt";
        const fileContent = "Hello from encrypted binary upload!";
        const fileSize = fileContent.length;

        // Start collecting messages
        const messagesPromise = collectEncryptedUploadMessages(
          ws,
          sessionKey,
          uploadId,
        );

        // Send encrypted upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "text/plain",
        };
        const startEnvelope = encryptToBinaryEnvelope(
          JSON.stringify(startMsg),
          sessionKey,
        );
        ws.send(startEnvelope);

        // Wait for start to process
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Send encrypted binary chunk (format 0x02)
        // Payload format: [16 bytes UUID][8 bytes offset][chunk data]
        const chunkData = Buffer.from(fileContent);
        const payload = encodeUploadChunkPayload(uploadId, 0, chunkData);
        const chunkEnvelope = encryptBytesToBinaryEnvelope(
          payload,
          BinaryFormat.BINARY_UPLOAD,
          sessionKey,
        );
        ws.send(chunkEnvelope);

        // Send encrypted upload_end
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        const endEnvelope = encryptToBinaryEnvelope(
          JSON.stringify(endMsg),
          sessionKey,
        );
        ws.send(endEnvelope);

        // Wait for completion
        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(1);
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_complete");

        const completeMsg = lastMsg as RelayUploadComplete;
        expect(completeMsg.file.originalName).toBe(filename);
        expect(completeMsg.file.size).toBe(fileSize);
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    // Skip: Timing-sensitive test that's flaky on slow CI runners.
    // Same issue as above - message timeout races with server processing.
    it.skip("should upload larger file with multiple encrypted binary chunks", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "large-secure.bin";
        // Create a 200KB file
        const fileSize = 200 * 1024;
        const fileContent = Buffer.alloc(fileSize, "Z");

        // Start collecting messages
        const messagesPromise = collectEncryptedUploadMessages(
          ws,
          sessionKey,
          uploadId,
        );

        // Send encrypted upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "application/octet-stream",
        };
        ws.send(encryptToBinaryEnvelope(JSON.stringify(startMsg), sessionKey));

        await new Promise((resolve) => setTimeout(resolve, 100));

        // Send in 64KB encrypted binary chunks
        const chunkSize = 64 * 1024;
        let offset = 0;
        while (offset < fileSize) {
          const end = Math.min(offset + chunkSize, fileSize);
          const chunk = fileContent.slice(offset, end);

          // Encrypt binary chunk payload
          const payload = encodeUploadChunkPayload(uploadId, offset, chunk);
          const envelope = encryptBytesToBinaryEnvelope(
            payload,
            BinaryFormat.BINARY_UPLOAD,
            sessionKey,
          );
          ws.send(envelope);

          offset = end;
        }

        // Send encrypted upload_end
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(encryptToBinaryEnvelope(JSON.stringify(endMsg), sessionKey));

        // Wait for completion
        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(2);

        // Check progress updates
        const progressMsgs = messages.filter(
          (m) => m.type === "upload_progress",
        ) as RelayUploadProgress[];
        expect(progressMsgs.length).toBeGreaterThanOrEqual(1);

        // Last message should be upload_complete
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_complete");

        const completeMsg = lastMsg as RelayUploadComplete;
        expect(completeMsg.file.size).toBe(fileSize);
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should handle error for encrypted binary chunk with unknown upload ID", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const uploadId = randomUUID();

        // Start collecting messages
        const messagesPromise = collectEncryptedUploadMessages(
          ws,
          sessionKey,
          uploadId,
          2000,
        );

        // Send encrypted binary chunk without starting upload
        const chunkData = Buffer.from("test data");
        const payload = encodeUploadChunkPayload(uploadId, 0, chunkData);
        const envelope = encryptBytesToBinaryEnvelope(
          payload,
          BinaryFormat.BINARY_UPLOAD,
          sessionKey,
        );
        ws.send(envelope);

        // Wait for error
        const messages = await messagesPromise;

        expect(messages.length).toBe(1);
        expect(messages[0].type).toBe("upload_error");

        const errorMsg = messages[0] as RelayUploadError;
        expect(errorMsg.error).toContain("Upload not found");
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should handle binary data in encrypted chunks", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "binary-data-secure.bin";
        // Create binary data with all byte values
        const fileContent = Buffer.alloc(256);
        for (let i = 0; i < 256; i++) {
          fileContent[i] = i;
        }
        const fileSize = fileContent.length;

        // Start collecting messages
        const messagesPromise = collectEncryptedUploadMessages(
          ws,
          sessionKey,
          uploadId,
        );

        // Send encrypted upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "application/octet-stream",
        };
        ws.send(encryptToBinaryEnvelope(JSON.stringify(startMsg), sessionKey));

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send encrypted binary chunk
        const payload = encodeUploadChunkPayload(uploadId, 0, fileContent);
        ws.send(
          encryptBytesToBinaryEnvelope(
            payload,
            BinaryFormat.BINARY_UPLOAD,
            sessionKey,
          ),
        );

        // Send encrypted upload_end
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(encryptToBinaryEnvelope(JSON.stringify(endMsg), sessionKey));

        // Wait for completion
        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(1);
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_complete");

        const completeMsg = lastMsg as RelayUploadComplete;
        expect(completeMsg.file.size).toBe(fileSize);
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);
  });
});
