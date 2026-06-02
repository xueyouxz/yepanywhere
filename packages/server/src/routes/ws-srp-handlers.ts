import { randomBytes } from "node:crypto";
import type {
  SrpClientHello,
  SrpClientProof,
  SrpError,
  SrpServerChallenge,
  SrpServerVerify,
  SrpSessionInvalid,
  SrpSessionResume,
  SrpSessionResumeChallenge,
  SrpSessionResumeInit,
  SrpSessionResumed,
} from "@yep-anywhere/shared";
import {
  SrpServerSession,
  deriveSecretboxKey,
  deriveTransportKey,
  encrypt,
} from "../crypto/index.js";
import type {
  RemoteAccessService,
  RemoteSessionService,
} from "../remote-access/index.js";
import type { ConnectionState, WSAdapter } from "./ws-relay-handlers.js";
import {
  hasEstablishedSrpTransport,
  isSrpProofPending,
} from "./ws-transport-auth.js";
import { RESUME_PROTOCOL_VERSION } from "./version.js";

/** Maximum age for a resume challenge nonce (60s) */
const RESUME_CHALLENGE_MAX_AGE_MS = 60 * 1000;
/** Max time to complete SRP hello -> proof before dropping the connection */
const SRP_HANDSHAKE_TIMEOUT_MS = 10 * 1000;
/** Per-connection srp_hello burst capacity */
const SRP_CONN_HELLO_CAPACITY = 6;
/** Per-connection srp_hello refill rate (tokens per minute) */
const SRP_CONN_HELLO_REFILL_PER_MIN = 6;
/** Per-username srp_hello burst capacity */
const SRP_USERNAME_HELLO_CAPACITY = 30;
/** Per-username srp_hello refill rate (tokens per minute) */
const SRP_USERNAME_HELLO_REFILL_PER_MIN = 30;
/** Temporary cooldown applied when hello bucket is exhausted */
const SRP_HELLO_COOLDOWN_MS = 15 * 1000;
/** Base cooldown after failed proof (doubles per failure) */
const SRP_FAILED_PROOF_BASE_COOLDOWN_MS = 5 * 1000;
/** Max cooldown after repeated failed proofs */
const SRP_FAILED_PROOF_MAX_COOLDOWN_MS = 5 * 60 * 1000;
/** Keep idle per-username limiter entries for at most 30 minutes */
const SRP_USERNAME_LIMITER_TTL_MS = 30 * 60 * 1000;
/** Soft cap to prevent unbounded growth from random identity spam */
const SRP_USERNAME_LIMITER_MAX_ENTRIES = 1024;

interface SrpTokenBucket {
  capacity: number;
  refillPerMs: number;
  tokens: number;
  lastRefillAt: number;
}

interface SrpLimiterState {
  helloBucket: SrpTokenBucket;
  blockedUntil: number;
  failedProofCount: number;
}

const usernameSrpLimiters = new Map<
  string,
  SrpLimiterState & { lastSeenAt: number }
>();

function createTokenBucket(
  capacity: number,
  refillPerMinute: number,
): SrpTokenBucket {
  return {
    capacity,
    refillPerMs: refillPerMinute / 60_000,
    tokens: capacity,
    lastRefillAt: Date.now(),
  };
}

export function createInitialSrpLimiterState(): ConnectionState["srpLimiter"] {
  return {
    helloBucket: createTokenBucket(
      SRP_CONN_HELLO_CAPACITY,
      SRP_CONN_HELLO_REFILL_PER_MIN,
    ),
    blockedUntil: 0,
    failedProofCount: 0,
    handshakeTimeout: null,
  };
}

function refillTokenBucket(bucket: SrpTokenBucket, now: number): void {
  if (now <= bucket.lastRefillAt) return;
  const elapsed = now - bucket.lastRefillAt;
  const refill = elapsed * bucket.refillPerMs;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refill);
  bucket.lastRefillAt = now;
}

function tryConsumeToken(bucket: SrpTokenBucket, now: number): boolean {
  refillTokenBucket(bucket, now);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function failedProofCooldownMs(failedProofCount: number): number {
  if (failedProofCount <= 1) {
    return 0;
  }
  const exponent = Math.max(0, failedProofCount - 2);
  const cooldown = SRP_FAILED_PROOF_BASE_COOLDOWN_MS * 2 ** exponent;
  return Math.min(SRP_FAILED_PROOF_MAX_COOLDOWN_MS, cooldown);
}

function clearSrpHandshakeTimeout(connState: ConnectionState): void {
  if (connState.srpLimiter.handshakeTimeout) {
    clearTimeout(connState.srpLimiter.handshakeTimeout);
    connState.srpLimiter.handshakeTimeout = null;
  }
}

function cleanupSrpHandshakeState(connState: ConnectionState): void {
  clearSrpHandshakeTimeout(connState);
  connState.srpSession = null;
  connState.pendingResumeChallenge = null;
  if (connState.authState !== "authenticated") {
    connState.authState = "unauthenticated";
  }
}

function cleanupUsernameSrpLimiters(now: number): void {
  for (const [username, limiter] of usernameSrpLimiters) {
    if (now - limiter.lastSeenAt <= SRP_USERNAME_LIMITER_TTL_MS) {
      continue;
    }
    if (limiter.blockedUntil > now) {
      continue;
    }
    usernameSrpLimiters.delete(username);
  }
}

function getUsernameLimiter(username: string, now: number): SrpLimiterState {
  if (usernameSrpLimiters.size >= SRP_USERNAME_LIMITER_MAX_ENTRIES) {
    cleanupUsernameSrpLimiters(now);
  }

  let limiter = usernameSrpLimiters.get(username);
  if (!limiter) {
    limiter = {
      helloBucket: createTokenBucket(
        SRP_USERNAME_HELLO_CAPACITY,
        SRP_USERNAME_HELLO_REFILL_PER_MIN,
      ),
      blockedUntil: 0,
      failedProofCount: 0,
      lastSeenAt: now,
    };
    usernameSrpLimiters.set(username, limiter);
  } else {
    limiter.lastSeenAt = now;
  }
  return limiter;
}

function applyFailedProofPenalty(
  limiter: SrpLimiterState,
  now: number,
  extraCooldownMs = 0,
): void {
  limiter.failedProofCount += 1;
  const cooldown = failedProofCooldownMs(limiter.failedProofCount);
  limiter.blockedUntil = Math.max(
    limiter.blockedUntil,
    now + cooldown + extraCooldownMs,
  );
}

function resetFailedProofPenalty(limiter: SrpLimiterState): void {
  limiter.failedProofCount = 0;
  limiter.blockedUntil = 0;
}

function sendSrpRateLimited(ws: WSAdapter): void {
  sendSrpMessage(ws, {
    type: "srp_error",
    code: "invalid_proof",
    message: "Too many authentication attempts. Try again shortly.",
  });
}

function enforceSrpHelloRateLimit(
  ws: WSAdapter,
  connState: ConnectionState,
  usernameLimiter: SrpLimiterState | null,
  now: number,
): boolean {
  const connLimiter = connState.srpLimiter;

  if (connLimiter.blockedUntil > now) {
    sendSrpRateLimited(ws);
    ws.close(4008, "Rate limit exceeded");
    return false;
  }

  if (!tryConsumeToken(connLimiter.helloBucket, now)) {
    connLimiter.blockedUntil = Math.max(
      connLimiter.blockedUntil,
      now + SRP_HELLO_COOLDOWN_MS,
    );
    sendSrpRateLimited(ws);
    ws.close(4008, "Rate limit exceeded");
    return false;
  }

  if (!usernameLimiter) {
    return true;
  }

  if (usernameLimiter.blockedUntil > now) {
    sendSrpRateLimited(ws);
    ws.close(4008, "Rate limit exceeded");
    return false;
  }

  if (!tryConsumeToken(usernameLimiter.helloBucket, now)) {
    usernameLimiter.blockedUntil = Math.max(
      usernameLimiter.blockedUntil,
      now + SRP_HELLO_COOLDOWN_MS,
    );
    sendSrpRateLimited(ws);
    ws.close(4008, "Rate limit exceeded");
    return false;
  }

  return true;
}

function startSrpHandshakeTimeout(
  ws: WSAdapter,
  connState: ConnectionState,
): void {
  clearSrpHandshakeTimeout(connState);
  const timeout = setTimeout(() => {
    if (!isSrpProofPending(connState)) return;
    cleanupSrpHandshakeState(connState);
    ws.close(4008, "Authentication timeout");
  }, SRP_HANDSHAKE_TIMEOUT_MS);
  timeout.unref?.();
  connState.srpLimiter.handshakeTimeout = timeout;
}

export function cleanupSrpConnectionState(connState: ConnectionState): void {
  cleanupSrpHandshakeState(connState);
  connState.sessionKey = null;
  connState.baseSessionKey = null;
  connState.nextOutboundSeq = 0;
  connState.lastInboundSeq = null;
}

function createResumeServerProof(params: {
  sessionId: string;
  serverNonce: string;
  clientNonce: string;
  resumeProtocolVersion: number;
  key: Uint8Array;
}): string {
  const proofData = JSON.stringify({
    type: "srp_resume_server_proof",
    sessionId: params.sessionId,
    serverNonce: params.serverNonce,
    clientNonce: params.clientNonce,
    resumeProtocolVersion: params.resumeProtocolVersion,
  });
  return JSON.stringify(encrypt(proofData, params.key));
}

function createSrpVerifyServerInfoProof(params: {
  sessionId: string;
  transportNonce: string;
  resumeProtocolVersion: number;
  key: Uint8Array;
}): string {
  const proofData = JSON.stringify({
    type: "srp_verify_server_info",
    sessionId: params.sessionId,
    transportNonce: params.transportNonce,
    resumeProtocolVersion: params.resumeProtocolVersion,
  });
  return JSON.stringify(encrypt(proofData, params.key));
}

/**
 * Send a plaintext SRP message (always unencrypted during handshake).
 */
export function sendSrpMessage(
  ws: WSAdapter,
  msg:
    | SrpServerChallenge
    | SrpServerVerify
    | SrpError
    | SrpSessionResumeChallenge
    | SrpSessionResumed
    | SrpSessionInvalid,
): void {
  ws.send(JSON.stringify(msg));
}

/**
 * Handle session resume init and issue a one-time nonce challenge.
 */
export async function handleSrpResumeInit(
  ws: WSAdapter,
  connState: ConnectionState,
  msg: SrpSessionResumeInit,
  remoteSessionService: RemoteSessionService | undefined,
): Promise<void> {
  if (!remoteSessionService) {
    sendSrpMessage(ws, {
      type: "srp_invalid",
      reason: "unknown",
    });
    return;
  }

  // Resume init is only invalid when this socket already has an established SRP
  // transport key. Trusted local policy may set authenticated without SRP.
  if (hasEstablishedSrpTransport(connState)) {
    sendSrpMessage(ws, {
      type: "srp_invalid",
      reason: "invalid_proof",
    });
    return;
  }

  if (!msg.clientNonce) {
    sendSrpMessage(ws, {
      type: "srp_invalid",
      reason: "invalid_proof",
    });
    return;
  }

  try {
    const session = remoteSessionService.getSession(msg.sessionId);

    // Keep failure mode generic (don't leak session validity details).
    if (!session || session.username !== msg.identity) {
      sendSrpMessage(ws, {
        type: "srp_invalid",
        reason: "invalid_proof",
      });
      return;
    }

    const nonce = randomBytes(24).toString("base64");
    connState.pendingResumeChallenge = {
      nonce,
      clientNonce: msg.clientNonce,
      sessionId: msg.sessionId,
      username: msg.identity,
      issuedAt: Date.now(),
    };

    sendSrpMessage(ws, {
      type: "srp_resume_challenge",
      sessionId: msg.sessionId,
      nonce,
    });

    console.log(
      `[WS Relay] Resume challenge sent for ${msg.identity} (${msg.sessionId})`,
    );
  } catch (err) {
    console.error("[WS Relay] Session resume init error:", err);
    sendSrpMessage(ws, {
      type: "srp_invalid",
      reason: "unknown",
    });
  }
}

/**
 * Handle SRP session resume proof (reconnect with stored session).
 */
export async function handleSrpResume(
  ws: WSAdapter,
  connState: ConnectionState,
  msg: SrpSessionResume,
  remoteSessionService: RemoteSessionService | undefined,
): Promise<void> {
  if (!remoteSessionService) {
    sendSrpMessage(ws, {
      type: "srp_invalid",
      reason: "unknown",
    });
    return;
  }

  try {
    const pendingChallenge = connState.pendingResumeChallenge;
    connState.pendingResumeChallenge = null;

    if (
      !pendingChallenge ||
      pendingChallenge.sessionId !== msg.sessionId ||
      pendingChallenge.username !== msg.identity
    ) {
      sendSrpMessage(ws, {
        type: "srp_invalid",
        reason: "invalid_proof",
      });
      return;
    }

    if (Date.now() - pendingChallenge.issuedAt > RESUME_CHALLENGE_MAX_AGE_MS) {
      sendSrpMessage(ws, {
        type: "srp_invalid",
        reason: "invalid_proof",
      });
      return;
    }

    const session = await remoteSessionService.validateProof(
      msg.sessionId,
      msg.proof,
      pendingChallenge.nonce,
    );

    if (!session) {
      console.log(
        `[WS Relay] Session resume failed for ${msg.identity}: invalid or expired`,
      );
      sendSrpMessage(ws, {
        type: "srp_invalid",
        reason: "invalid_proof",
      });
      return;
    }

    if (session.username !== msg.identity) {
      console.warn(
        `[WS Relay] Session resume identity mismatch: ${msg.identity} vs ${session.username}`,
      );
      sendSrpMessage(ws, {
        type: "srp_invalid",
        reason: "invalid_proof",
      });
      return;
    }

    const baseSessionKey = Buffer.from(session.sessionKey, "base64");
    const transportNonce = pendingChallenge.nonce;
    const serverProof = createResumeServerProof({
      sessionId: session.sessionId,
      serverNonce: pendingChallenge.nonce,
      clientNonce: pendingChallenge.clientNonce,
      resumeProtocolVersion: RESUME_PROTOCOL_VERSION,
      key: baseSessionKey,
    });
    connState.baseSessionKey = baseSessionKey;
    connState.sessionKey = deriveTransportKey(baseSessionKey, transportNonce);
    connState.authState = "authenticated";
    connState.requiresEncryptedMessages = true;
    connState.username = session.username;
    connState.sessionId = session.sessionId;
    connState.nextOutboundSeq = 0;
    connState.lastInboundSeq = null;

    // Update lastConnectedAt to track active connection time
    await remoteSessionService.updateLastConnected(session.sessionId);

    sendSrpMessage(ws, {
      type: "srp_resumed",
      sessionId: session.sessionId,
      transportNonce,
      serverProof,
    });

    console.log(
      `[WS Relay] Session resumed for ${msg.identity} (${msg.sessionId})`,
    );
  } catch (err) {
    console.error("[WS Relay] Session resume error:", err);
    sendSrpMessage(ws, {
      type: "srp_invalid",
      reason: "unknown",
    });
  }
}

/**
 * Handle SRP hello message (start of authentication).
 */
export async function handleSrpHello(
  ws: WSAdapter,
  connState: ConnectionState,
  msg: SrpClientHello,
  remoteAccessService: RemoteAccessService | undefined,
): Promise<void> {
  const now = Date.now();
  cleanupUsernameSrpLimiters(now);

  if (isSrpProofPending(connState)) {
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "invalid_proof",
      message: "Authentication already in progress",
    });
    ws.close(4008, "Authentication already in progress");
    return;
  }
  // Only reject hello when SRP is already established. Trusted local policy may
  // set authenticated without SRP transport.
  if (hasEstablishedSrpTransport(connState)) {
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "invalid_proof",
      message: "Already authenticated",
    });
    ws.close(4005, "Already authenticated");
    return;
  }

  if (!remoteAccessService) {
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "server_error",
      message: "Remote access not configured",
    });
    return;
  }

  const credentials = remoteAccessService.getCredentials();
  if (!credentials) {
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "invalid_identity",
      message: "Remote access not configured",
    });
    return;
  }

  const configuredUsername = remoteAccessService.getUsername();
  const usernameLimiter =
    configuredUsername && msg.identity === configuredUsername
      ? getUsernameLimiter(configuredUsername, now)
      : null;
  if (!enforceSrpHelloRateLimit(ws, connState, usernameLimiter, now)) {
    return;
  }

  if (msg.identity !== configuredUsername) {
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "invalid_identity",
      message: "Unknown identity",
    });
    return;
  }

  try {
    cleanupSrpHandshakeState(connState);
    connState.srpSession = new SrpServerSession();
    connState.username = msg.identity;

    // Capture connection metadata for session tracking
    connState.browserProfileId = msg.browserProfileId ?? null;
    connState.originMetadata = msg.originMetadata ?? null;

    const { B } = await connState.srpSession.generateChallenge(
      msg.identity,
      credentials.salt,
      credentials.verifier,
    );

    const challenge: SrpServerChallenge = {
      type: "srp_challenge",
      salt: credentials.salt,
      B,
    };
    sendSrpMessage(ws, challenge);
    connState.authState = "srp_waiting_proof";
    startSrpHandshakeTimeout(ws, connState);

    console.log(`[WS Relay] SRP challenge sent for ${msg.identity}`);
  } catch (err) {
    console.error("[WS Relay] SRP hello error:", err);
    cleanupSrpHandshakeState(connState);
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "server_error",
      message: "Authentication failed",
    });
  }
}

/**
 * Handle SRP proof message (client proves knowledge of password).
 */
export async function handleSrpProof(
  ws: WSAdapter,
  connState: ConnectionState,
  msg: SrpClientProof,
  clientA: string,
  remoteSessionService: RemoteSessionService | undefined,
): Promise<void> {
  if (!connState.srpSession || !isSrpProofPending(connState)) {
    cleanupSrpHandshakeState(connState);
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "server_error",
      message: "Unexpected proof message",
    });
    return;
  }

  clearSrpHandshakeTimeout(connState);

  try {
    const result = await connState.srpSession.verifyProof(clientA, msg.M1);

    if (!result) {
      const now = Date.now();
      console.warn(
        `[WS Relay] SRP authentication failed for ${connState.username}`,
      );
      applyFailedProofPenalty(connState.srpLimiter, now);
      if (connState.username) {
        applyFailedProofPenalty(
          getUsernameLimiter(connState.username, now),
          now,
        );
      }
      sendSrpMessage(ws, {
        type: "srp_error",
        code: "invalid_proof",
        message: "Authentication failed",
      });
      cleanupSrpHandshakeState(connState);
      ws.close(4001, "Authentication failed");
      return;
    }

    const rawKey = connState.srpSession.getSessionKey();
    if (!rawKey) {
      throw new Error("No session key after successful proof");
    }
    const baseSessionKey = deriveSecretboxKey(rawKey);
    const transportNonce = randomBytes(24).toString("base64");
    connState.baseSessionKey = baseSessionKey;
    connState.sessionKey = deriveTransportKey(baseSessionKey, transportNonce);
    connState.authState = "authenticated";
    connState.requiresEncryptedMessages = true;
    connState.pendingResumeChallenge = null;
    connState.nextOutboundSeq = 0;
    connState.lastInboundSeq = null;
    resetFailedProofPenalty(connState.srpLimiter);
    if (connState.username) {
      resetFailedProofPenalty(
        getUsernameLimiter(connState.username, Date.now()),
      );
    }

    let sessionId: string | undefined;
    console.log("[WS Relay] Session creation check:", {
      hasRemoteSessionService: !!remoteSessionService,
      hasUsername: !!connState.username,
      username: connState.username,
    });
    if (remoteSessionService && connState.username) {
      sessionId = await remoteSessionService.createSession(
        connState.username,
        baseSessionKey,
        {
          browserProfileId: connState.browserProfileId ?? undefined,
          userAgent: connState.originMetadata?.userAgent,
          origin: connState.originMetadata?.origin,
        },
      );
      connState.sessionId = sessionId;
      console.log("[WS Relay] Session created:", sessionId);
    }

    const verify: SrpServerVerify = {
      type: "srp_verify",
      M2: result.M2,
      sessionId,
      transportNonce,
      serverInfoProof: sessionId
        ? createSrpVerifyServerInfoProof({
            sessionId,
            transportNonce,
            resumeProtocolVersion: RESUME_PROTOCOL_VERSION,
            key: baseSessionKey,
          })
        : undefined,
    };
    sendSrpMessage(ws, verify);

    console.log(
      `[WS Relay] SRP authentication successful for ${connState.username}${sessionId ? ` (session: ${sessionId})` : ""}`,
    );
  } catch (err) {
    const now = Date.now();
    applyFailedProofPenalty(connState.srpLimiter, now);
    if (connState.username) {
      applyFailedProofPenalty(getUsernameLimiter(connState.username, now), now);
    }
    console.error("[WS Relay] SRP proof error:", err);
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "server_error",
      message: "Authentication failed",
    });
    cleanupSrpHandshakeState(connState);
    ws.close(4001, "Authentication failed");
  }
}
