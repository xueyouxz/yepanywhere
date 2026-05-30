import type {
  DeviceServerMessage,
  RemoteClientMessage,
  UploadedFile,
} from "@yep-anywhere/shared";

/**
 * WebSocket close codes that indicate non-retryable errors.
 * The client should not attempt to reconnect for these codes.
 */
export const NON_RETRYABLE_CLOSE_CODES = [
  4001, // Authentication required
  4003, // Forbidden (invalid origin)
] as const;

/**
 * Custom error for WebSocket close events that preserves the close code and reason.
 */
export class WebSocketCloseError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason: string) {
    const message = reason || `WebSocket closed with code ${code}`;
    super(message);
    this.name = "WebSocketCloseError";
    this.code = code;
    this.reason = reason;
  }

  /**
   * Check if this error indicates a non-retryable condition.
   */
  isNonRetryable(): boolean {
    return (NON_RETRYABLE_CLOSE_CODES as readonly number[]).includes(this.code);
  }
}

/**
 * Error thrown when a relay connection needs to be re-established through the relay.
 * This happens when the WebSocket drops and SecureConnection tries to auto-reconnect,
 * but it was originally connected via relay (wsUrl = "relay://").
 */
export class RelayReconnectRequiredError extends Error {
  /** The underlying error that caused the reconnection to fail */
  readonly cause?: Error;

  constructor(cause?: Error) {
    // Use a user-friendly message based on the underlying cause
    const message = formatRelayReconnectError(cause);
    super(message);
    this.name = "RelayReconnectRequiredError";
    this.cause = cause;
  }

  /**
   * Check if this relay error is non-retryable (terminal).
   * Terminal errors won't resolve by retrying (e.g., unknown user, missing config).
   * Transient errors (timeouts, network issues, server_offline) should be retried.
   */
  isNonRetryable(): boolean {
    if (!this.cause) return false;
    const msg = this.cause.message.toLowerCase();
    if (msg.includes("unknown_username")) return true;
    if (msg.includes("missing relay config")) return true;
    return false;
  }
}

/**
 * Format a user-friendly error message for relay reconnection failures.
 */
function formatRelayReconnectError(cause?: Error): string {
  if (!cause) {
    return "Connection lost. Please try again.";
  }

  const msg = cause.message.toLowerCase();

  // Timeout errors - server is unreachable
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("waiting for server")
  ) {
    return "Couldn't reach the server. Make sure your computer is turned on and connected to the internet.";
  }

  // Connection errors - network issue
  if (
    msg.includes("connection error") ||
    msg.includes("connection closed") ||
    msg.includes("failed to connect")
  ) {
    return "Connection failed. Check your internet connection and try again.";
  }

  // Server offline (relay knows about the user but server isn't connected)
  if (msg.includes("server_offline") || msg.includes("not connected")) {
    return "Server is offline. Make sure your server is running and connected to the relay.";
  }

  // Default fallback
  return "Connection lost. Please try again.";
}

/**
 * Error for subscription-level failures (e.g., 404 "No active process for session").
 * Distinguished from transport-level errors so callers can decide whether to retry.
 */
export class SubscriptionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SubscriptionError";
    this.status = status;
  }
}

/**
 * Check if an error is non-retryable (retrying won't help).
 */
export function isNonRetryableError(error: unknown): boolean {
  // Relay errors: only non-retryable if the cause is terminal (e.g., unknown username).
  // Transient causes (timeouts, network issues) are retryable via ConnectionManager backoff.
  if (error instanceof RelayReconnectRequiredError) {
    return error.isNonRetryable();
  }
  // Subscription 4xx errors (e.g., 404 "No active process") won't resolve by retrying.
  // The activity stream will trigger a fresh subscription when the process starts.
  if (
    error instanceof SubscriptionError &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return true;
  }
  return error instanceof WebSocketCloseError && error.isNonRetryable();
}

/**
 * Handle for an active event subscription.
 */
export interface Subscription {
  /** Stop receiving events and close the connection */
  close(): void;
}

/**
 * Handlers for stream events (session or activity).
 */
export interface StreamHandlers {
  /** Called for each event with type, optional ID, and data */
  onEvent: (
    eventType: string,
    eventId: string | undefined,
    data: unknown,
  ) => void;
  /** Called when connection opens */
  onOpen?: () => void;
  /** Called on error (will attempt reconnect for recoverable errors) */
  onError?: (error: Error) => void;
  /** Called when stream ends. Error is provided if transport closed unexpectedly. */
  onClose?: (error?: Error) => void;
}

/**
 * Options for file upload.
 */
export interface UploadOptions {
  /** Progress callback with bytes uploaded so far */
  onProgress?: (bytesUploaded: number) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Chunk size in bytes (default 64KB) */
  chunkSize?: number;
  /** Image dimensions of the actual uploaded file, if known */
  imageDimensions?: {
    width: number;
    height: number;
  };
}

/**
 * Connection abstraction for client-server communication.
 *
 * Implementations:
 * - DirectConnection: Uses native fetch for REST, WebSocket for uploads (localhost)
 * - WebSocketConnection: Multiplexes everything over a single WebSocket (localhost subscriptions)
 * - SecureConnection: Multiplexes everything over encrypted WebSocket (remote/relay)
 *
 * The interface abstracts HTTP requests, WebSocket subscriptions, and file uploads
 * so they can be routed through different transports.
 */
export interface Connection {
  /** Connection mode identifier */
  readonly mode: "direct" | "secure";

  /**
   * Make a JSON API request.
   *
   * @param path - Request path (e.g., "/sessions")
   * @param init - Fetch options (method, body, headers, etc.)
   * @returns Parsed JSON response
   * @throws Error with status property on HTTP errors
   */
  fetch<T>(path: string, init?: RequestInit): Promise<T>;

  /**
   * Fetch binary data (images, files) and return as Blob.
   *
   * @param path - Request path (e.g., "/projects/.../upload/image.png")
   * @returns Blob containing the binary data
   * @throws Error on HTTP errors
   */
  fetchBlob(path: string): Promise<Blob>;

  /**
   * Subscribe to session events via WebSocket.
   *
   * Events include: message, status, connected, error, complete, heartbeat,
   * markdown-augment, pending, edit-augment, session-id-changed, etc.
   *
   * @param sessionId - Session to subscribe to
   * @param handlers - Event callbacks
   * @param lastEventId - Resume from this event ID (optional)
   * @returns Subscription handle with close() method
   */
  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
  ): Subscription;

  /**
   * Subscribe to activity events via WebSocket.
   *
   * Events include: file-change, session-status-changed, session-created,
   * session-updated, session-seen, process-state-changed, etc.
   *
   * @param handlers - Event callbacks
   * @returns Subscription handle with close() method
   */
  subscribeActivity(handlers: StreamHandlers): Subscription;

  /**
   * Subscribe to focused file-change events for a specific session file.
   *
   * Used by session detail UI for non-owned sessions to get reliable, targeted
   * updates without depending on broad activity-tree file watching behavior.
   *
   * @param sessionId - Session to watch
   * @param handlers - Event callbacks
   * @param options - Optional project/provider hints for server-side resolution
   * @returns Subscription handle with close() method
   */
  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: {
      projectId?: string;
      provider?: string;
    },
  ): Subscription;

  /**
   * Upload a file to a session.
   *
   * @param projectId - Project ID (URL-encoded format)
   * @param sessionId - Session ID
   * @param file - File to upload
   * @param options - Upload options (progress, abort signal)
   * @returns Uploaded file metadata
   */
  upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile>;

  /**
   * Force reconnection of the underlying transport.
   * Useful when the connection may have gone stale (e.g., mobile wake from sleep).
   * Optional - only SecureConnection implements this.
   */
  forceReconnect?(): Promise<void>;

  /**
   * Send a raw protocol message (bypassing REST).
   * Used for emulator signaling messages.
   * Optional - only WebSocket-based connections support this.
   */
  sendMessage?(msg: RemoteClientMessage): void;

  /**
   * Register a handler for emulator signaling messages from the server.
   * Returns an unsubscribe function.
   * Optional - only WebSocket-based connections support this.
   */
  onDeviceMessage?(handler: (msg: DeviceServerMessage) => void): () => void;
}
