/**
 * Secure connection for remote access using SRP authentication and NaCl encryption.
 *
 * This implements the Connection interface but routes all traffic through
 * an encrypted WebSocket channel. Uses:
 * - SRP-6a for zero-knowledge password authentication
 * - NaCl secretbox (XSalsa20-Poly1305) for message encryption
 *
 * Protocol logic (request correlation, subscriptions, uploads) is delegated
 * to RelayProtocol. This class owns transport (encrypt/decrypt) and SRP auth.
 */
import type {
  ClientCapabilities,
  DeviceServerMessage,
  OriginMetadata,
  RemoteClientMessage,
  SrpClientHello,
  SrpClientProof,
  SrpSessionResume,
  SrpSessionResumeInit,
  UploadedFile,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFormat,
  encodeUploadChunkPayload,
  isBinaryData,
  isCompressionSupported,
  isEncryptedEnvelope,
  isRelayClientConnected,
  isRelayClientError,
  isSequencedEncryptedPayload,
  isSrpError,
  isSrpServerChallenge,
  isSrpServerVerify,
  isSrpSessionInvalid,
  isSrpSessionResumeChallenge,
  isSrpSessionResumed,
} from "@yep-anywhere/shared";
import { getRelayDebugEnabled } from "../../hooks/useDeveloperMode";
import { getOrCreateBrowserProfileId } from "../storageKeys";
import { RelayProtocol } from "./RelayProtocol";
import {
  decrypt,
  decryptBinaryEnvelopeWithDecompression,
  deriveSecretboxKey,
  deriveTransportKey,
  encrypt,
  encryptBytesToBinaryEnvelope,
  encryptToBinaryEnvelope,
} from "./nacl-wrapper";
import { SrpClientSession } from "./srp-client";
import {
  type Connection,
  RelayReconnectRequiredError,
  type StreamHandlers,
  type Subscription,
  type UploadOptions,
  WebSocketCloseError,
} from "./types";

/** Connection authentication state */
type ConnectionState =
  | "disconnected"
  | "connecting"
  | "srp_resume_init_sent"
  | "srp_resume_proof_sent"
  | "srp_hello_sent"
  | "srp_proof_sent"
  | "authenticated"
  | "failed";

/** Timeout waiting for resume challenge/proof responses before assuming old server protocol. */
const RESUME_PHASE_TIMEOUT_MS = 5000;
const RESUME_INCOMPATIBLE_ERROR =
  "resume_incompatible: session resume unsupported by server";
const UPLOAD_BUFFER_HIGH_WATER_BYTES = 512 * 1024;
const UPLOAD_BUFFER_LOW_WATER_BYTES = 256 * 1024;
const UPLOAD_BUFFER_POLL_MS = 16;

/** Stored session for resumption (persisted to localStorage) */
export interface StoredSession {
  wsUrl: string;
  username: string;
  sessionId: string;
  /** Base64-encoded session key (32 bytes) */
  sessionKey: string;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Secure connection to yepanywhere server using SRP + NaCl encryption.
 *
 * All traffic is authenticated and encrypted. The connection is established
 * in three phases:
 * 1. WebSocket connection
 * 2. SRP authentication handshake
 * 3. Encrypted message exchange
 */
export class SecureConnection implements Connection {
  readonly mode = "secure" as const;

  private ws: WebSocket | null = null;
  private srpSession: SrpClientSession | null = null;
  private sessionKey: Uint8Array | null = null;
  private sessionId: string | null = null;
  private connectionState: ConnectionState = "disconnected";
  private connectionPromise: Promise<void> | null = null;
  private protocol: RelayProtocol;
  private nextOutboundSeq = 0;
  private lastInboundSeq: number | null = null;
  private useLegacyProtocolMode = false;

  // Credentials for authentication
  private username: string;
  private password: string | null;
  private wsUrl: string;

  // Flag indicating this connection was established via relay
  private isRelayConnection = false;

  // Relay connection details for auto-reconnect (only set for relay connections)
  private relayUrl: string | null = null;
  private relayUsername: string | null = null;

  // Stored session for resumption (optional)
  private storedSession: StoredSession | null = null;

  // Callback when session is established (for storing session data)
  private onSessionEstablished?: (session: StoredSession) => void;

  // Callback when connection is lost (for UI state updates)
  private onDisconnect?: (error: Error) => void;

  /**
   * Create a new secure connection with password authentication.
   */
  constructor(
    wsUrl: string,
    username: string,
    password: string,
    onSessionEstablished?: (session: StoredSession) => void,
    onDisconnect?: (error: Error) => void,
  ) {
    this.wsUrl = wsUrl;
    this.username = username;
    this.password = password;
    this.onSessionEstablished = onSessionEstablished;
    this.onDisconnect = onDisconnect;

    this.protocol = new RelayProtocol(
      {
        sendMessage: (msg) => this.send(msg),
        sendUploadChunk: async (id, offset, chunk) => {
          if (this.useLegacyProtocolMode) {
            this.send({
              type: "upload_chunk",
              uploadId: id,
              offset,
              data: uint8ToBase64(chunk),
            });
            await this.waitForUploadBackpressure();
            return;
          }

          const payload = encodeUploadChunkPayload(id, offset, chunk);
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
          }
          if (!this.sessionKey) {
            throw new Error("Not authenticated");
          }
          const envelope = encryptBytesToBinaryEnvelope(
            payload,
            BinaryFormat.BINARY_UPLOAD,
            this.sessionKey,
          );
          this.ws.send(envelope);
          await this.waitForUploadBackpressure();
        },
        ensureConnected: () => this.ensureConnected(),
        isConnected: () =>
          this.connectionState === "authenticated" &&
          this.ws?.readyState === WebSocket.OPEN,
      },
      {
        debugEnabled: () => getRelayDebugEnabled(),
        logPrefix: "[SecureConnection]",
      },
    );
  }

  /**
   * Create a secure connection from a stored session.
   * Will attempt to resume the session, falling back to full SRP if the session is invalid.
   */
  static fromStoredSession(
    storedSession: StoredSession,
    password: string,
    onSessionEstablished?: (session: StoredSession) => void,
    onDisconnect?: (error: Error) => void,
  ): SecureConnection {
    const conn = new SecureConnection(
      storedSession.wsUrl,
      storedSession.username,
      password,
      onSessionEstablished,
      onDisconnect,
    );
    conn.storedSession = storedSession;
    return conn;
  }

  /**
   * Create a secure connection for resume-only mode (no password fallback).
   * Will attempt to resume the session and fail if the session is invalid.
   * Use this for automatic reconnection on page load.
   */
  static forResumeOnly(
    storedSession: StoredSession,
    onSessionEstablished?: (session: StoredSession) => void,
    onDisconnect?: (error: Error) => void,
  ): SecureConnection {
    const conn = new SecureConnection(
      storedSession.wsUrl,
      storedSession.username,
      "", // No password - resume only
      onSessionEstablished,
      onDisconnect,
    );
    conn.storedSession = storedSession;
    conn.password = null; // Mark as resume-only
    return conn;
  }

  /**
   * Create a secure connection for resume-only mode using an existing WebSocket.
   * Used for relay connections where we need to reconnect through the relay first,
   * then resume the SRP session on the paired socket.
   */
  static async forResumeOnlyWithSocket(
    ws: WebSocket,
    storedSession: StoredSession,
    onSessionEstablished?: (session: StoredSession) => void,
    relayConfig?: { relayUrl: string; relayUsername: string },
    onDisconnect?: (error: Error) => void,
  ): Promise<SecureConnection> {
    const conn = new SecureConnection(
      "", // No URL needed - socket already connected
      storedSession.username,
      "", // No password - resume only
      onSessionEstablished,
      onDisconnect,
    );
    conn.ws = ws;
    conn.storedSession = storedSession;
    conn.password = null; // Mark as resume-only
    conn.isRelayConnection = true;
    if (relayConfig) {
      conn.relayUrl = relayConfig.relayUrl;
      conn.relayUsername = relayConfig.relayUsername;
    }

    // Resume the session on the existing socket
    await conn.resumeOnExistingSocket();
    return conn;
  }

  /**
   * Perform session resume on an already-connected WebSocket.
   * Used by forResumeOnlyWithSocket for relay connections.
   */
  private resumeOnExistingSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket is not open"));
        return;
      }

      if (!this.storedSession) {
        reject(new Error("No stored session for resume"));
        return;
      }

      console.log("[SecureConnection] Resuming session on existing socket");
      this.connectionState = "connecting";

      let authResolveHandler: () => void = () => {};
      let authRejectHandler: (err: Error) => void = () => {};

      const authPromise = new Promise<void>((res, rej) => {
        authResolveHandler = res;
        authRejectHandler = rej;
      });

      const ws = this.ws;

      ws.onerror = (event) => {
        console.error("[SecureConnection] Error:", event);
      };

      ws.onclose = (event) => {
        this.handleSocketClose(event, authRejectHandler);
      };

      ws.onmessage = (event) => {
        armResumeTimeout();
        this.handleSrpResumeResponse(
          event.data,
          authResolveHandler,
          authRejectHandler,
        );
      };

      let resumeTimeout: ReturnType<typeof setTimeout> | null = null;
      const armResumeTimeout = () => {
        if (resumeTimeout) {
          clearTimeout(resumeTimeout);
        }
        resumeTimeout = setTimeout(() => {
          if (
            this.connectionState !== "srp_resume_init_sent" &&
            this.connectionState !== "srp_resume_proof_sent"
          ) {
            return;
          }
          this.connectionState = "failed";
          authRejectHandler(new Error(RESUME_INCOMPATIBLE_ERROR));
          ws.close();
        }, RESUME_PHASE_TIMEOUT_MS);
      };

      // Start resume handshake by requesting a nonce challenge.
      const resumeInit: SrpSessionResumeInit = {
        type: "srp_resume_init",
        identity: this.username,
        sessionId: this.storedSession.sessionId,
      };
      ws.send(JSON.stringify(resumeInit));
      this.connectionState = "srp_resume_init_sent";
      console.log("[SecureConnection] SRP resume init sent");
      armResumeTimeout();

      authPromise
        .then(() => {
          if (resumeTimeout) clearTimeout(resumeTimeout);
          resolve();
        })
        .catch((err) => {
          if (resumeTimeout) clearTimeout(resumeTimeout);
          reject(err);
        });
    });
  }

  /**
   * Generate a resume proof bound to the server-issued challenge.
   */
  private generateResumeProof(
    base64SessionKey: string,
    challenge: string,
    sessionId: string,
  ): string {
    const sessionKeyBytes = Uint8Array.from(atob(base64SessionKey), (c) =>
      c.charCodeAt(0),
    );
    const timestamp = Date.now();
    const proofData = JSON.stringify({ timestamp, challenge, sessionId });
    const { nonce, ciphertext } = encrypt(proofData, sessionKeyBytes);
    return JSON.stringify({ nonce, ciphertext });
  }

  /**
   * Start the full SRP handshake (when session resume fails or no stored session).
   */
  private async startFullSrpHandshake(
    authRejectHandler: (err: Error) => void,
  ): Promise<void> {
    if (!this.password) {
      throw new Error("Password required for SRP authentication");
    }

    console.log("[SecureConnection] Starting full SRP handshake");
    this.srpSession = new SrpClientSession();
    await this.srpSession.generateHello(this.username, this.password);

    const browserProfileId = getOrCreateBrowserProfileId();
    const originMetadata: OriginMetadata = {
      origin: window.location.origin,
      scheme: window.location.protocol.replace(":", ""),
      hostname: window.location.hostname,
      port: window.location.port
        ? Number.parseInt(window.location.port, 10)
        : null,
      userAgent: navigator.userAgent,
    };

    const hello: SrpClientHello = {
      type: "srp_hello",
      identity: this.username,
      browserProfileId,
      originMetadata,
    };
    this.ws?.send(JSON.stringify(hello));
    this.connectionState = "srp_hello_sent";
    console.log("[SecureConnection] SRP hello sent");
  }

  /**
   * Handle session resume response.
   */
  private async handleSrpResumeResponse(
    data: string,
    resolve: () => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      const msg = JSON.parse(data);

      if (isSrpSessionResumeChallenge(msg)) {
        if (!this.storedSession) {
          reject(new Error("No stored session for resumption"));
          return;
        }
        if (msg.sessionId !== this.storedSession.sessionId) {
          reject(new Error("Resume challenge session mismatch"));
          this.ws?.close();
          return;
        }

        const proof = this.generateResumeProof(
          this.storedSession.sessionKey,
          msg.nonce,
          this.storedSession.sessionId,
        );
        const resume: SrpSessionResume = {
          type: "srp_resume",
          identity: this.username,
          sessionId: this.storedSession.sessionId,
          proof,
        };
        this.ws?.send(JSON.stringify(resume));
        this.connectionState = "srp_resume_proof_sent";
        console.log("[SecureConnection] SRP resume proof sent");
        return;
      }

      if (isSrpSessionResumed(msg)) {
        console.log("[SecureConnection] Session resumed successfully");
        if (!this.storedSession) {
          reject(new Error("No stored session for resumption"));
          return;
        }
        const baseSessionKey = Uint8Array.from(
          atob(this.storedSession.sessionKey),
          (c) => c.charCodeAt(0),
        );
        if (!msg.transportNonce) {
          console.warn(
            "[SecureConnection] Missing transport nonce on resume; using legacy traffic key",
          );
        }
        this.useLegacyProtocolMode = !msg.transportNonce;
        this.sessionKey = msg.transportNonce
          ? deriveTransportKey(baseSessionKey, msg.transportNonce)
          : baseSessionKey;
        this.sessionId = msg.sessionId;
        this.connectionState = "authenticated";
        this.resetSequenceState();

        if (this.ws) {
          this.ws.onmessage = (event) => this.handleMessage(event.data);
        }

        this.sendCapabilities();
        resolve();
        return;
      }

      if (isSrpSessionInvalid(msg)) {
        if (!this.password) {
          console.log(
            `[SecureConnection] Session resume failed: ${msg.reason} (no password for fallback)`,
          );
          this.connectionState = "failed";
          reject(new Error(`Session invalid: ${msg.reason}`));
          this.ws?.close();
          return;
        }

        console.log(
          `[SecureConnection] Session resume failed: ${msg.reason}, falling back to SRP`,
        );
        this.storedSession = null;
        await this.startFullSrpHandshake(reject);
        return;
      }

      if (isSrpError(msg)) {
        console.error(
          "[SecureConnection] SRP error during resume:",
          msg.message,
        );
        this.connectionState = "failed";
        reject(new Error(`Authentication failed: ${msg.message}`));
        this.ws?.close();
        return;
      }

      console.warn("[SecureConnection] Unexpected message during resume:", msg);
      this.connectionState = "failed";
      reject(
        new Error(
          `Unexpected message during resume: ${msg?.type ?? "unknown"}`,
        ),
      );
      this.ws?.close();
    } catch (err) {
      console.error("[SecureConnection] Resume response error:", err);
      this.connectionState = "failed";
      reject(err instanceof Error ? err : new Error(String(err)));
      this.ws?.close();
    }
  }

  /**
   * Ensure connection is authenticated, reconnecting if necessary.
   */
  private async ensureConnected(): Promise<void> {
    if (
      this.ws?.readyState === WebSocket.OPEN &&
      this.connectionState === "authenticated"
    ) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.connectAndAuthenticate();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  /**
   * Handle WebSocket close events. Extracted to avoid duplication across
   * connectAndAuthenticate, resumeOnExistingSocket, and authenticateOnExistingSocket.
   */
  private handleSocketClose(
    event: CloseEvent,
    authRejectHandler?: (err: Error) => void,
  ): void {
    console.log("[SecureConnection] Closed:", event.code, event.reason);
    const wasAuthenticated = this.connectionState === "authenticated";
    this.ws = null;
    this.sessionKey = null;
    this.srpSession = null;
    this.useLegacyProtocolMode = false;
    this.resetSequenceState();

    const closeError = new WebSocketCloseError(event.code, event.reason);

    if (!wasAuthenticated) {
      this.connectionState = "failed";
      authRejectHandler?.(closeError);
    } else {
      this.connectionState = "disconnected";
      this.onDisconnect?.(closeError);
    }

    this.protocol.rejectAllPending(closeError);
    this.protocol.notifySubscriptionsClosed(closeError);
  }

  /**
   * Connect to the WebSocket server and perform SRP authentication.
   */
  private connectAndAuthenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Relay connections need to go through the relay again
      if (this.isRelayConnection) {
        if (this.relayUrl && this.relayUsername && this.storedSession) {
          console.log(
            "[SecureConnection] Relay connection dropped, attempting auto-reconnect",
          );
          this.reconnectThroughRelay()
            .then(resolve)
            .catch((err) => {
              console.error(
                "[SecureConnection] Relay auto-reconnect failed:",
                err,
              );
              reject(
                new RelayReconnectRequiredError(
                  err instanceof Error ? err : new Error(String(err)),
                ),
              );
            });
          return;
        }
        console.log(
          "[SecureConnection] Cannot reconnect relay connection (missing config or session)",
        );
        reject(
          new RelayReconnectRequiredError(
            new Error("Missing relay config or stored session"),
          ),
        );
        return;
      }

      console.log("[SecureConnection] Connecting to", this.wsUrl);
      this.connectionState = "connecting";

      const ws = new WebSocket(this.wsUrl);
      ws.binaryType = "arraybuffer";

      let authResolveHandler: () => void = () => {};
      let authRejectHandler: (err: Error) => void = () => {};

      const authPromise = new Promise<void>((res, rej) => {
        authResolveHandler = res;
        authRejectHandler = rej;
      });
      let resumeTimeout: ReturnType<typeof setTimeout> | null = null;

      const clearResumeTimeout = () => {
        if (resumeTimeout) {
          clearTimeout(resumeTimeout);
          resumeTimeout = null;
        }
      };

      const armResumeTimeout = () => {
        clearResumeTimeout();
        resumeTimeout = setTimeout(() => {
          if (
            this.connectionState !== "srp_resume_init_sent" &&
            this.connectionState !== "srp_resume_proof_sent"
          ) {
            return;
          }

          if (this.password) {
            console.log(
              "[SecureConnection] Session resume timed out, falling back to full SRP",
            );
            this.storedSession = null;
            this.startFullSrpHandshake(authRejectHandler).catch((err) => {
              this.connectionState = "failed";
              authRejectHandler(
                err instanceof Error ? err : new Error(String(err)),
              );
              ws.close();
            });
            return;
          }

          this.connectionState = "failed";
          authRejectHandler(new Error(RESUME_INCOMPATIBLE_ERROR));
          ws.close();
        }, RESUME_PHASE_TIMEOUT_MS);
      };

      ws.onopen = async () => {
        console.log("[SecureConnection] WebSocket connected");
        this.ws = ws;

        try {
          if (this.storedSession) {
            console.log("[SecureConnection] Attempting session resumption");
            const resumeInit: SrpSessionResumeInit = {
              type: "srp_resume_init",
              identity: this.username,
              sessionId: this.storedSession.sessionId,
            };
            ws.send(JSON.stringify(resumeInit));
            this.connectionState = "srp_resume_init_sent";
            console.log("[SecureConnection] SRP resume init sent");
            armResumeTimeout();
            return;
          }

          await this.startFullSrpHandshake(authRejectHandler);
        } catch (err) {
          console.error("[SecureConnection] Connection error:", err);
          this.connectionState = "failed";
          authRejectHandler(
            err instanceof Error ? err : new Error(String(err)),
          );
          ws.close();
        }
      };

      ws.onerror = (event) => {
        console.error("[SecureConnection] Error:", event);
      };

      ws.onclose = (event) => {
        this.handleSocketClose(event, authRejectHandler);
      };

      ws.onmessage = async (event) => {
        if (
          this.connectionState === "srp_resume_init_sent" ||
          this.connectionState === "srp_resume_proof_sent"
        ) {
          armResumeTimeout();
          await this.handleSrpResumeResponse(
            event.data,
            authResolveHandler,
            authRejectHandler,
          );
        } else if (this.connectionState === "srp_hello_sent") {
          await this.handleSrpChallenge(
            event.data,
            authResolveHandler,
            authRejectHandler,
          );
        } else if (this.connectionState === "srp_proof_sent") {
          await this.handleSrpVerify(
            event.data,
            authResolveHandler,
            authRejectHandler,
          );
        } else if (this.connectionState === "authenticated") {
          this.handleMessage(event.data);
        }
      };

      const timeout = setTimeout(() => {
        if (this.connectionState !== "authenticated") {
          ws.close();
          this.connectionState = "failed";
          reject(new Error("Connection timeout"));
        }
      }, 30000);

      authPromise
        .then(() => {
          clearResumeTimeout();
          clearTimeout(timeout);
          resolve();
        })
        .catch((err) => {
          clearResumeTimeout();
          clearTimeout(timeout);
          reject(err);
        });
    });
  }

  /**
   * Reconnect through relay server and resume SRP session.
   */
  private async reconnectThroughRelay(): Promise<void> {
    if (!this.relayUrl || !this.relayUsername || !this.storedSession) {
      throw new Error("Missing relay config or stored session for reconnect");
    }

    console.log("[SecureConnection] Connecting to relay:", this.relayUrl);
    this.connectionState = "connecting";

    const ws = new WebSocket(this.relayUrl);
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Relay connection timeout"));
      }, 15000);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Failed to connect to relay server"));
      };
    });

    console.log("[SecureConnection] Relay connected, sending client_connect");

    ws.send(
      JSON.stringify({ type: "client_connect", username: this.relayUsername }),
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Waiting for server timed out"));
      }, 30000);

      ws.onmessage = (event) => {
        clearTimeout(timeout);
        try {
          const msg = JSON.parse(event.data as string);
          if (isRelayClientConnected(msg)) {
            console.log("[SecureConnection] Relay paired with server");
            resolve();
          } else if (isRelayClientError(msg)) {
            ws.close();
            reject(new Error(msg.reason));
          } else {
            resolve();
          }
        } catch {
          ws.close();
          reject(new Error("Invalid relay response"));
        }
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        reject(new Error("Relay connection closed"));
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Relay connection error"));
      };
    });

    console.log("[SecureConnection] Resuming SRP session on new relay socket");
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    this.ws = ws;
    await this.resumeOnExistingSocket();
  }

  /**
   * Handle SRP challenge message from server.
   */
  private async handleSrpChallenge(
    data: string,
    resolve: () => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      const msg = JSON.parse(data);

      if (isSrpError(msg)) {
        console.error("[SecureConnection] SRP error:", msg.message);
        this.connectionState = "failed";
        reject(new Error(`Authentication failed: ${msg.message}`));
        this.ws?.close();
        return;
      }

      if (!isSrpServerChallenge(msg)) {
        console.warn(
          "[SecureConnection] Unexpected message during SRP challenge:",
          msg,
        );
        this.connectionState = "failed";
        reject(
          new Error(
            `Unexpected message during SRP challenge: ${msg?.type ?? "unknown"}`,
          ),
        );
        this.ws?.close();
        return;
      }

      if (!this.srpSession) {
        reject(new Error("No SRP session"));
        return;
      }

      console.log("[SecureConnection] Received SRP challenge");

      const { A, M1 } = await this.srpSession.processChallenge(msg.salt, msg.B);

      const proof: SrpClientProof = {
        type: "srp_proof",
        A,
        M1,
      };
      this.ws?.send(JSON.stringify(proof));
      this.connectionState = "srp_proof_sent";
      console.log("[SecureConnection] SRP proof sent");
    } catch (err) {
      console.error("[SecureConnection] SRP challenge error:", err);
      this.connectionState = "failed";
      reject(err instanceof Error ? err : new Error(String(err)));
      this.ws?.close();
    }
  }

  /**
   * Handle SRP verify message from server.
   */
  private async handleSrpVerify(
    data: string,
    resolve: () => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      const msg = JSON.parse(data);

      if (isSrpError(msg)) {
        console.error("[SecureConnection] SRP error:", msg.message);
        this.connectionState = "failed";
        reject(new Error(`Authentication failed: ${msg.message}`));
        this.ws?.close();
        return;
      }

      if (!isSrpServerVerify(msg)) {
        console.warn(
          "[SecureConnection] Unexpected message during SRP verify:",
          msg,
        );
        this.connectionState = "failed";
        reject(
          new Error(
            `Unexpected message during SRP verify: ${msg?.type ?? "unknown"}`,
          ),
        );
        this.ws?.close();
        return;
      }

      if (!this.srpSession) {
        reject(new Error("No SRP session"));
        return;
      }

      console.log("[SecureConnection] Received SRP verify");

      const valid = await this.srpSession.verifyServer(msg.M2);
      if (!valid) {
        console.error("[SecureConnection] Server verification failed");
        this.connectionState = "failed";
        reject(new Error("Server verification failed"));
        this.ws?.close();
        return;
      }

      const rawKey = this.srpSession.getSessionKey();
      if (!rawKey) {
        reject(new Error("No session key"));
        return;
      }
      const baseSessionKey = deriveSecretboxKey(rawKey);
      if (!msg.transportNonce) {
        console.warn(
          "[SecureConnection] Missing transport nonce on verify; using legacy traffic key",
        );
      }
      this.useLegacyProtocolMode = !msg.transportNonce;
      this.sessionKey = msg.transportNonce
        ? deriveTransportKey(baseSessionKey, msg.transportNonce)
        : baseSessionKey;
      this.sessionId = msg.sessionId ?? null;
      this.connectionState = "authenticated";
      this.resetSequenceState();

      if (this.sessionId) {
        const sessionKeyBase64 = btoa(
          Array.from(baseSessionKey)
            .map((b) => String.fromCharCode(b))
            .join(""),
        );
        this.storedSession = {
          wsUrl: this.wsUrl,
          username: this.username,
          sessionId: this.sessionId,
          sessionKey: sessionKeyBase64,
        };
        this.onSessionEstablished?.(this.storedSession);
      }

      this.sendCapabilities();

      console.log("[SecureConnection] Authentication complete");
      resolve();
    } catch (err) {
      console.error("[SecureConnection] SRP verify error:", err);
      this.connectionState = "failed";
      reject(err instanceof Error ? err : new Error(String(err)));
      this.ws?.close();
    }
  }

  /**
   * Handle incoming WebSocket messages (after authentication).
   */
  private async handleMessage(data: unknown): Promise<void> {
    if (!this.sessionKey) {
      console.warn("[SecureConnection] No session key for decryption");
      return;
    }

    let decrypted: string | null = null;

    if (isBinaryData(data)) {
      try {
        decrypted = await decryptBinaryEnvelopeWithDecompression(
          data,
          this.sessionKey,
        );
        if (!decrypted) {
          console.warn("[SecureConnection] Failed to decrypt binary envelope");
          return;
        }
      } catch (err) {
        console.warn("[SecureConnection] Binary envelope error:", err);
        return;
      }
    } else if (typeof data === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        console.warn("[SecureConnection] Failed to parse message:", data);
        return;
      }

      if (!isEncryptedEnvelope(parsed)) {
        console.warn(
          "[SecureConnection] Received unencrypted message after auth",
        );
        return;
      }

      decrypted = decrypt(parsed.nonce, parsed.ciphertext, this.sessionKey);
      if (!decrypted) {
        console.warn("[SecureConnection] Failed to decrypt JSON envelope");
        return;
      }
    } else {
      console.warn("[SecureConnection] Ignoring unknown message type");
      return;
    }

    let msg: YepMessage;
    try {
      const payload = JSON.parse(decrypted);
      if (isSequencedEncryptedPayload(payload)) {
        if (
          this.lastInboundSeq !== null &&
          payload.seq <= this.lastInboundSeq
        ) {
          console.warn(
            `[SecureConnection] Replay/old sequence rejected: seq=${payload.seq}, last=${this.lastInboundSeq}`,
          );
          this.ws?.close(4004, "Replay detected");
          return;
        }
        this.lastInboundSeq = payload.seq;
        msg = payload.msg as YepMessage;
      } else if (this.useLegacyProtocolMode) {
        msg = payload as YepMessage;
      } else {
        console.warn("[SecureConnection] Missing/invalid encrypted sequence");
        this.ws?.close(4004, "Invalid sequence");
        return;
      }
    } catch {
      console.warn(
        "[SecureConnection] Failed to parse decrypted message:",
        decrypted,
      );
      return;
    }

    this.protocol.routeMessage(msg);
  }

  /**
   * Send an encrypted message over the WebSocket.
   */
  private send(msg: RemoteClientMessage): void {
    const websocketOpenState =
      typeof WebSocket !== "undefined" ? WebSocket.OPEN : 1;
    if (!this.ws || this.ws.readyState !== websocketOpenState) {
      throw new Error("WebSocket not connected");
    }
    if (!this.sessionKey) {
      throw new Error("Not authenticated");
    }

    if (this.useLegacyProtocolMode) {
      const plaintext = JSON.stringify(msg);
      const { nonce, ciphertext } = encrypt(plaintext, this.sessionKey);
      this.ws.send(JSON.stringify({ type: "encrypted", nonce, ciphertext }));
      return;
    }

    const plaintext = JSON.stringify({ seq: this.nextOutboundSeq, msg });
    this.nextOutboundSeq += 1;
    const envelope = encryptToBinaryEnvelope(plaintext, this.sessionKey);
    this.ws.send(envelope);
  }

  private resetSequenceState(): void {
    this.nextOutboundSeq = 0;
    this.lastInboundSeq = null;
  }

  /**
   * Send client capabilities to the server.
   * Called immediately after SRP authentication completes.
   */
  private sendCapabilities(): void {
    if (this.useLegacyProtocolMode) {
      console.log(
        "[SecureConnection] Skipping capabilities for legacy server protocol",
      );
      return;
    }

    const formats: number[] = [BinaryFormat.JSON, BinaryFormat.BINARY_UPLOAD];

    if (isCompressionSupported()) {
      formats.push(BinaryFormat.COMPRESSED_JSON);
    }

    const msg: ClientCapabilities = {
      type: "client_capabilities",
      formats: formats as ClientCapabilities["formats"],
    };

    console.log(
      `[SecureConnection] Sending capabilities: formats=${formats.map((f) => `0x${f.toString(16).padStart(2, "0")}`).join(", ")}`,
    );

    try {
      this.send(msg);
    } catch (err) {
      console.warn("[SecureConnection] Failed to send capabilities:", err);
    }
  }

  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    return this.protocol.fetch<T>(path, init);
  }

  async fetchBlob(path: string): Promise<Blob> {
    return this.protocol.fetchBlob(path);
  }

  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
  ): Subscription {
    return this.protocol.subscribeSession(sessionId, handlers, lastEventId);
  }

  subscribeActivity(handlers: StreamHandlers): Subscription {
    return this.protocol.subscribeActivity(handlers);
  }

  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: {
      projectId?: string;
      provider?: string;
    },
  ): Subscription {
    return this.protocol.subscribeSessionWatch(sessionId, handlers, options);
  }

  async upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    return this.protocol.upload(projectId, sessionId, file, options);
  }

  /**
   * Send a keepalive ping to verify the connection is alive.
   */
  sendPing(id: string): void {
    this.protocol.sendPing(id);
  }

  /**
   * Register a callback for pong responses.
   */
  setOnPong(cb: (id: string) => void): void {
    this.protocol.setOnPong(cb);
  }

  sendMessage(msg: RemoteClientMessage): void {
    this.send(msg);
  }

  onDeviceMessage(handler: (msg: DeviceServerMessage) => void): () => void {
    return this.protocol.onDeviceMessage(handler);
  }

  private async waitForUploadBackpressure(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount <= UPLOAD_BUFFER_HIGH_WATER_BYTES) return;

    while (
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount > UPLOAD_BUFFER_LOW_WATER_BYTES
    ) {
      await wait(UPLOAD_BUFFER_POLL_MS);
    }

    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
  }

  /**
   * Close the secure connection.
   */
  close(): void {
    this.protocol.close();

    this.sessionKey = null;
    this.srpSession = null;
    this.useLegacyProtocolMode = false;
    this.connectionState = "disconnected";

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Force reconnection of the underlying WebSocket.
   * ConnectionManager handles re-subscription; this just tears down and rebuilds the transport.
   */
  async forceReconnect(): Promise<void> {
    console.log(
      `[SecureConnection] Force reconnecting... wsState=${this.ws?.readyState}, connState=${this.connectionState}, isRelay=${this.isRelayConnection}`,
    );

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }

    const reconnectError = new Error("Connection reconnecting");
    this.protocol.rejectAllPending(reconnectError);
    // Force all stream handlers (activity/session) to transition closed so
    // higher-level consumers can re-subscribe after authentication resumes.
    this.protocol.notifySubscriptionsClosed(reconnectError);

    // Reset connection state but keep session info for resumption
    this.connectionState = "disconnected";
    this.connectionPromise = null;
    this.useLegacyProtocolMode = false;

    await this.ensureConnected();
    console.log(
      `[SecureConnection] Force reconnect complete, connState=${this.connectionState}`,
    );
  }

  /**
   * Check if the connection is authenticated.
   */
  isAuthenticated(): boolean {
    return this.connectionState === "authenticated" && this.sessionKey !== null;
  }

  /**
   * Connect using an existing WebSocket that's already connected through a relay.
   * Skips WebSocket creation and goes straight to SRP authentication.
   */
  static async connectWithExistingSocket(
    ws: WebSocket,
    username: string,
    password: string,
    onSessionEstablished?: (session: StoredSession) => void,
    relayConfig?: { relayUrl: string; relayUsername: string },
    onDisconnect?: (error: Error) => void,
  ): Promise<SecureConnection> {
    const conn = new SecureConnection(
      "", // No URL needed - socket already connected
      username,
      password,
      onSessionEstablished,
      onDisconnect,
    );
    conn.ws = ws;
    conn.isRelayConnection = true;
    if (relayConfig) {
      conn.relayUrl = relayConfig.relayUrl;
      conn.relayUsername = relayConfig.relayUsername;
    }
    ws.binaryType = "arraybuffer";

    await conn.authenticateOnExistingSocket();
    return conn;
  }

  /**
   * Perform SRP authentication on an already-connected WebSocket.
   */
  private authenticateOnExistingSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket is not open"));
        return;
      }

      console.log("[SecureConnection] Authenticating on existing socket");
      this.connectionState = "connecting";

      let authResolveHandler: () => void = () => {};
      let authRejectHandler: (err: Error) => void = () => {};

      const authPromise = new Promise<void>((res, rej) => {
        authResolveHandler = res;
        authRejectHandler = rej;
      });

      const ws = this.ws;

      ws.onerror = (event) => {
        console.error("[SecureConnection] Error:", event);
      };

      ws.onclose = (event) => {
        this.handleSocketClose(event, authRejectHandler);
      };

      ws.onmessage = async (event) => {
        if (this.connectionState === "srp_hello_sent") {
          await this.handleSrpChallenge(
            event.data,
            authResolveHandler,
            authRejectHandler,
          );
        } else if (this.connectionState === "srp_proof_sent") {
          await this.handleSrpVerify(
            event.data,
            authResolveHandler,
            authRejectHandler,
          );
        } else if (this.connectionState === "authenticated") {
          this.handleMessage(event.data);
        }
      };

      // Start SRP handshake (no session resume for relay connections)
      this.startFullSrpHandshake(authRejectHandler).catch((err) => {
        console.error("[SecureConnection] SRP handshake error:", err);
        this.connectionState = "failed";
        authRejectHandler(err instanceof Error ? err : new Error(String(err)));
        ws.close();
      });

      const timeout = setTimeout(() => {
        if (this.connectionState !== "authenticated") {
          ws.close();
          this.connectionState = "failed";
          reject(new Error("Authentication timeout"));
        }
      }, 30000);

      authPromise
        .then(() => {
          clearTimeout(timeout);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
    });
  }
}
