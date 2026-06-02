/**
 * SRP-6a handshake message types for zero-knowledge password authentication.
 *
 * Flow:
 * 1. Client → Server: SrpClientHello (identity)
 * 2. Server → Client: SrpServerChallenge (salt, B)
 * 3. Client → Server: SrpClientProof (A, M1)
 * 4. Server → Client: SrpServerVerify (M2) or SrpError
 */

import type { OriginMetadata } from "../connection.js";

/** Client initiates SRP handshake with identity */
export interface SrpClientHello {
  type: "srp_hello";
  /** Username/identity */
  identity: string;
  /** Browser profile identifier for session tracking */
  browserProfileId?: string;
  /** Origin metadata for device/browser identification */
  originMetadata?: OriginMetadata;
}

/** Server responds with salt and ephemeral public value B */
export interface SrpServerChallenge {
  type: "srp_challenge";
  /** Salt used to generate verifier (hex string) */
  salt: string;
  /** Server ephemeral public value (hex string) */
  B: string;
}

/** Client sends ephemeral public value and proof that it knows the password */
export interface SrpClientProof {
  type: "srp_proof";
  /** Client ephemeral public value (hex string) */
  A: string;
  /** Client proof value M1 (hex string) */
  M1: string;
}

/** Server verifies client and proves it knows verifier */
export interface SrpServerVerify {
  type: "srp_verify";
  /** Server proof value M2 (hex string) */
  M2: string;
  /** Session ID for session resumption; current relay clients require it. */
  sessionId?: string;
  /**
   * Server-issued per-connection nonce used to derive the traffic key from the
   * SRP/session key. Current relay clients require it.
   */
  transportNonce?: string;
  /**
   * Encrypted server-authenticated metadata for pinning protocol floors after
   * full SRP login. Current relay clients require it.
   */
  serverInfoProof?: string;
}

/** SRP error codes */
export type SrpErrorCode =
  | "invalid_identity"
  | "invalid_proof"
  | "server_error";

// ============================================================================
// Session Resumption (skip SRP handshake with stored session key)
// ============================================================================

/** Client starts a resume handshake and requests a server nonce challenge */
export interface SrpSessionResumeInit {
  type: "srp_resume_init";
  /** Username/identity */
  identity: string;
  /** Session ID from previous authentication */
  sessionId: string;
  /**
   * Client-issued nonce for mutual resume authentication. Current servers
   * require it; it is echoed inside the encrypted server proof.
   */
  clientNonce?: string;
}

/** Server provides a nonce challenge for session resume proof */
export interface SrpSessionResumeChallenge {
  type: "srp_resume_challenge";
  /** Session ID being resumed */
  sessionId: string;
  /** Server-issued nonce challenge (base64) */
  nonce: string;
}

/** Client sends resume proof bound to the server nonce challenge */
export interface SrpSessionResume {
  type: "srp_resume";
  /** Username/identity */
  identity: string;
  /** Session ID from previous authentication */
  sessionId: string;
  /** Encrypted proof payload proving key possession */
  proof: string;
}

/** Server confirms session resumed successfully */
export interface SrpSessionResumed {
  type: "srp_resumed";
  /** Session ID that was resumed */
  sessionId: string;
  /**
   * Server-issued per-connection nonce used to derive the traffic key from the
   * persisted session key. Current relay clients require it.
   */
  transportNonce?: string;
  /**
   * Encrypted proof that the server possesses the stored resume key and is
   * accepting this specific resume attempt. Current relay clients require it.
   */
  serverProof?: string;
}

/** Reasons a session cannot be resumed */
export type SrpSessionInvalidReason = "expired" | "unknown" | "invalid_proof";

/** Server indicates session is invalid, client must do full SRP */
export interface SrpSessionInvalid {
  type: "srp_invalid";
  /** Why the session could not be resumed */
  reason: SrpSessionInvalidReason;
}

/** SRP error (authentication failed) */
export interface SrpError {
  type: "srp_error";
  /** Error code */
  code: SrpErrorCode;
  /** Human-readable message */
  message: string;
}

/** All SRP messages from client to server */
export type SrpClientMessage =
  | SrpClientHello
  | SrpClientProof
  | SrpSessionResumeInit
  | SrpSessionResume;

/** All SRP messages from server to client */
export type SrpServerMessage =
  | SrpServerChallenge
  | SrpServerVerify
  | SrpError
  | SrpSessionResumeChallenge
  | SrpSessionResumed
  | SrpSessionInvalid;

/** All SRP protocol messages */
export type SrpMessage = SrpClientMessage | SrpServerMessage;

/** Type guards */
export function isSrpClientHello(msg: unknown): msg is SrpClientHello {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpClientHello).type === "srp_hello"
  );
}

export function isSrpClientProof(msg: unknown): msg is SrpClientProof {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpClientProof).type === "srp_proof"
  );
}

export function isSrpServerChallenge(msg: unknown): msg is SrpServerChallenge {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpServerChallenge).type === "srp_challenge"
  );
}

export function isSrpServerVerify(msg: unknown): msg is SrpServerVerify {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpServerVerify).type === "srp_verify"
  );
}

export function isSrpError(msg: unknown): msg is SrpError {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpError).type === "srp_error"
  );
}

export function isSrpSessionResume(msg: unknown): msg is SrpSessionResume {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpSessionResume).type === "srp_resume"
  );
}

export function isSrpSessionResumeInit(
  msg: unknown,
): msg is SrpSessionResumeInit {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpSessionResumeInit).type === "srp_resume_init"
  );
}

export function isSrpSessionResumeChallenge(
  msg: unknown,
): msg is SrpSessionResumeChallenge {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpSessionResumeChallenge).type === "srp_resume_challenge"
  );
}

export function isSrpSessionResumed(msg: unknown): msg is SrpSessionResumed {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpSessionResumed).type === "srp_resumed"
  );
}

export function isSrpSessionInvalid(msg: unknown): msg is SrpSessionInvalid {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpSessionInvalid).type === "srp_invalid"
  );
}
