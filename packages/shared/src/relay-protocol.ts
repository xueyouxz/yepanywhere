/**
 * Relay server protocol types for routing yepanywhere servers and phone clients.
 *
 * The relay server is a "dumb pipe" that matches clients to servers based on
 * username, then forwards encrypted messages without inspection. This enables
 * phone clients to connect to yepanywhere servers behind NAT.
 *
 * Flow:
 * 1. Yepanywhere server connects to relay, sends server_register
 * 2. Relay responds with server_registered or server_rejected
 * 3. Phone client connects to relay, sends client_connect with username
 * 4. Relay pairs phone to server's waiting connection
 * 5. All subsequent messages forwarded without inspection (E2E encrypted)
 */

// ============================================================================
// Server Registration (Yepanywhere -> Relay)
// ============================================================================

/** Yepanywhere server registers with relay, claiming a username */
export interface RelayServerCompatibilityMetadata {
  /** Yep Anywhere app version running on the server. */
  appVersion?: string;
  /** Session resume protocol version supported by this server. */
  resumeProtocolVersion?: number;
  /** Future render protocol version for hosted client/server compatibility. */
  renderProtocolVersion?: number;
  /** Feature capabilities supported by this server. */
  capabilities?: string[];
}

export type RelayChannel = "app" | "speech";
export type RelayNonDefaultChannel = Exclude<RelayChannel, "app">;

export const DEFAULT_RELAY_CHANNEL: RelayChannel = "app";
export const SPEECH_RELAY_CHANNEL: RelayNonDefaultChannel = "speech";

/** Yepanywhere server registers with relay, claiming a username */
export interface RelayServerRegister {
  type: "server_register";
  /** Username for clients to connect to */
  username: string;
  /** Installation ID for ownership verification (allows reconnection) */
  installId: string;
  /** Optional compatibility metadata for relay observability. */
  appVersion?: string;
  /** Optional session resume protocol version. */
  resumeProtocolVersion?: number;
  /** Optional future render protocol version. */
  renderProtocolVersion?: number;
  /** Optional feature capabilities. */
  capabilities?: string[];
}

/** Yepanywhere server registers a named non-default relay channel. */
export interface RelayServerChannelRegister
  extends Omit<RelayServerRegister, "type"> {
  type: "server_register_channel";
  channel: RelayNonDefaultChannel;
}

/** Relay confirms server registration succeeded */
export interface RelayServerRegistered {
  type: "server_registered";
}

/** Reasons a server registration can be rejected */
export type RelayServerRejectedReason = "username_taken" | "invalid_username";

/** Relay rejects server registration */
export interface RelayServerRejected {
  type: "server_rejected";
  /** Why registration failed */
  reason: RelayServerRejectedReason;
}

// ============================================================================
// Client Connection (Phone -> Relay)
// ============================================================================

/** Phone client requests connection to a server by username */
export interface RelayClientConnect {
  type: "client_connect";
  /** Username of server to connect to */
  username: string;
}

/** Phone client requests a named non-default relay channel. */
export interface RelayClientChannelConnect {
  type: "client_connect_channel";
  /** Username of server to connect to */
  username: string;
  channel: RelayNonDefaultChannel;
}

/** Relay confirms client connected to server */
export interface RelayClientConnected {
  type: "client_connected";
}

/** Reasons a client connection can fail */
export type RelayClientErrorReason = "server_offline" | "unknown_username";

/** Relay reports client connection error */
export interface RelayClientError {
  type: "client_error";
  /** Why connection failed */
  reason: RelayClientErrorReason;
}

// ============================================================================
// Union Types
// ============================================================================

/** Messages from yepanywhere server to relay */
export type RelayServerMessage =
  | RelayServerRegister
  | RelayServerChannelRegister;

/** Responses from relay to yepanywhere server */
export type RelayServerResponse = RelayServerRegistered | RelayServerRejected;

/** Messages from phone client to relay */
export type RelayClientMessage = RelayClientConnect | RelayClientChannelConnect;

/** Responses from relay to phone client */
export type RelayClientResponse = RelayClientConnected | RelayClientError;

/** All relay routing protocol messages (before pairing) */
export type RelayRoutingMessage =
  | RelayServerMessage
  | RelayServerResponse
  | RelayClientMessage
  | RelayClientResponse;

// ============================================================================
// Type Guards
// ============================================================================

/** Type guard for server registration message */
export function isRelayServerRegister(
  msg: unknown,
): msg is RelayServerRegister {
  const register = msg as RelayServerRegister;
  return (
    typeof msg === "object" &&
    msg !== null &&
    register.type === "server_register" &&
    typeof register.username === "string" &&
    typeof register.installId === "string" &&
    (register.appVersion === undefined ||
      typeof register.appVersion === "string") &&
    (register.resumeProtocolVersion === undefined ||
      typeof register.resumeProtocolVersion === "number") &&
    (register.renderProtocolVersion === undefined ||
      typeof register.renderProtocolVersion === "number") &&
    (register.capabilities === undefined ||
      (Array.isArray(register.capabilities) &&
        register.capabilities.every(
          (capability) => typeof capability === "string",
        )))
  );
}

/** Type guard for non-default server channel registration. */
export function isRelayServerChannelRegister(
  msg: unknown,
): msg is RelayServerChannelRegister {
  const register = msg as RelayServerChannelRegister;
  return (
    typeof msg === "object" &&
    msg !== null &&
    register.type === "server_register_channel" &&
    register.channel === SPEECH_RELAY_CHANNEL &&
    typeof register.username === "string" &&
    typeof register.installId === "string" &&
    (register.appVersion === undefined ||
      typeof register.appVersion === "string") &&
    (register.resumeProtocolVersion === undefined ||
      typeof register.resumeProtocolVersion === "number") &&
    (register.renderProtocolVersion === undefined ||
      typeof register.renderProtocolVersion === "number") &&
    (register.capabilities === undefined ||
      (Array.isArray(register.capabilities) &&
        register.capabilities.every(
          (capability) => typeof capability === "string",
        )))
  );
}

/** Type guard for server registered response */
export function isRelayServerRegistered(
  msg: unknown,
): msg is RelayServerRegistered {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as RelayServerRegistered).type === "server_registered"
  );
}

/** Type guard for server rejected response */
export function isRelayServerRejected(
  msg: unknown,
): msg is RelayServerRejected {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as RelayServerRejected).type === "server_rejected" &&
    ((msg as RelayServerRejected).reason === "username_taken" ||
      (msg as RelayServerRejected).reason === "invalid_username")
  );
}

/** Type guard for client connect message */
export function isRelayClientConnect(msg: unknown): msg is RelayClientConnect {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as RelayClientConnect).type === "client_connect" &&
    typeof (msg as RelayClientConnect).username === "string"
  );
}

/** Type guard for non-default client channel connection. */
export function isRelayClientChannelConnect(
  msg: unknown,
): msg is RelayClientChannelConnect {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as RelayClientChannelConnect).type === "client_connect_channel" &&
    typeof (msg as RelayClientChannelConnect).username === "string" &&
    (msg as RelayClientChannelConnect).channel === SPEECH_RELAY_CHANNEL
  );
}

/** Type guard for client connected response */
export function isRelayClientConnected(
  msg: unknown,
): msg is RelayClientConnected {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as RelayClientConnected).type === "client_connected"
  );
}

/** Type guard for client error response */
export function isRelayClientError(msg: unknown): msg is RelayClientError {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as RelayClientError).type === "client_error" &&
    ((msg as RelayClientError).reason === "server_offline" ||
      (msg as RelayClientError).reason === "unknown_username")
  );
}

// ============================================================================
// Username Validation
// ============================================================================

/**
 * Valid username format: 3-32 lowercase alphanumeric characters and hyphens.
 * Must start and end with alphanumeric character.
 * Examples: "alice", "dev-server", "my-home-pc"
 */
export const USERNAME_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/**
 * Validates a relay username format.
 * @param username - The username to validate
 * @returns true if the username matches the required format
 */
export function isValidRelayUsername(username: string): boolean {
  return USERNAME_REGEX.test(username);
}
