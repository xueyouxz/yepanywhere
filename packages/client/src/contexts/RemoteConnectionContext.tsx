/**
 * RemoteConnectionContext - Provides SecureConnection for remote client.
 *
 * This context manages the SecureConnection lifecycle and provides it to
 * the app. Unlike the regular client which uses DirectConnection by default,
 * the remote client ONLY uses SecureConnection.
 *
 * Supports two connection modes:
 * - Direct: Connect via WebSocket URL + SRP auth
 * - Relay: Connect via relay server + relay username + SRP auth
 */

import {
  isRelayClientConnected,
  isRelayClientError,
} from "@yep-anywhere/shared";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  connectionManager,
  getGlobalConnection,
  setGlobalConnection,
} from "../lib/connection";
import {
  SecureConnection,
  type StoredSession,
} from "../lib/connection/SecureConnection";
import type { Connection } from "../lib/connection/types";
import {
  getHostById,
  updateHostSession,
  upsertRelayHost,
} from "../lib/hostStorage";

/** Stored credentials for auto-reconnect */
interface StoredCredentials {
  wsUrl: string;
  username: string;
  /** Session data for resumption (only stored if rememberMe was enabled) */
  session?: StoredSession;
  /** Connection mode: "direct" or "relay" */
  mode?: "direct" | "relay";
  /** Relay username (only for relay mode) */
  relayUsername?: string;
}

/** Relay connection status for UI feedback */
export type RelayConnectionStatus =
  | "idle"
  | "connecting_relay"
  | "waiting_server"
  | "authenticating"
  | "error";

/** Categorized auto-resume failure reason */
export type AutoResumeErrorReason =
  | "server_offline" // Server not connected to relay
  | "unknown_username" // No server with that username on relay
  | "relay_timeout" // Timeout waiting for relay or server
  | "relay_unreachable" // Can't connect to relay server
  | "direct_unreachable" // Can't reach server via direct WebSocket
  | "resume_incompatible" // Server is too old for two-phase session resume
  | "auth_failed" // Session expired or auth error
  | "other"; // Unexpected error

/** Structured error from auto-resume failure */
export interface AutoResumeError {
  reason: AutoResumeErrorReason;
  mode: "relay" | "direct";
  /** Relay username (relay mode only) */
  relayUsername?: string;
  /** Server URL (direct mode) or relay URL (relay mode) */
  serverUrl?: string;
  /** Original error message */
  message: string;
}

/** Options for connecting via relay */
export interface ConnectViaRelayOptions {
  relayUrl: string;
  relayUsername: string;
  srpUsername: string;
  srpPassword: string;
  rememberMe?: boolean;
  onStatusChange?: (status: RelayConnectionStatus) => void;
  /** Optional session for resumption (if provided, srpPassword is ignored) */
  session?: StoredSession;
}

interface RemoteConnectionState {
  /** The active connection (null if not connected) */
  connection: Connection | null;
  /** Whether a connection attempt is in progress */
  isConnecting: boolean;
  /** Whether auto-resume is being attempted (subset of isConnecting) */
  isAutoResuming: boolean;
  /** Error from last connection attempt */
  error: string | null;
  /** Structured error from auto-resume failure (for showing modal) */
  autoResumeError: AutoResumeError | null;
  /** Current host ID from hostStorage (for multi-host tracking) */
  currentHostId: string | null;
  /** Relay username of the current host (derived from currentHostId) */
  currentRelayUsername: string | null;
  /** Set the current host ID (called by RelayConnectionGate after connect) */
  setCurrentHostId: (hostId: string | null) => void;
  /** Whether user intentionally disconnected (prevents auto-redirect) */
  isIntentionalDisconnect: boolean;
  /** Connect to server with credentials (direct mode) */
  connect: (
    wsUrl: string,
    username: string,
    password: string,
    rememberMe?: boolean,
  ) => Promise<void>;
  /** Connect via relay server */
  connectViaRelay: (options: ConnectViaRelayOptions) => Promise<void>;
  /** Disconnect and clear credentials. Set isIntentional=false for programmatic host switches. */
  disconnect: (isIntentional?: boolean) => void;
  /** Clear auto-resume error (e.g., user chose to go to login) */
  clearAutoResumeError: () => void;
  /** Retry auto-resume after failure */
  retryAutoResume: () => void;
  /** Stored server URL (for pre-filling form) */
  storedUrl: string | null;
  /** Stored username (for pre-filling form) */
  storedUsername: string | null;
  /** Whether there's a stored session that can be resumed */
  hasStoredSession: boolean;
  /** Try to resume a stored session (requires password for fallback) */
  resumeSession: (password: string) => Promise<void>;
}

const RemoteConnectionContext = createContext<RemoteConnectionState | null>(
  null,
);

const STORAGE_KEY = "yep-anywhere-remote-credentials";

function loadStoredCredentials(): StoredCredentials | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored) as StoredCredentials;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function saveCredentials(
  wsUrl: string,
  username: string,
  session?: StoredSession,
): void {
  try {
    const creds: StoredCredentials = { wsUrl, username, session };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
  } catch {
    // Ignore storage errors
  }
}

function updateStoredSession(session: StoredSession): void {
  try {
    const stored = loadStoredCredentials();
    if (stored) {
      stored.session = session;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    }
  } catch {
    // Ignore storage errors
  }
}

function clearStoredCredentials(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

/** Categorize an error message into a structured AutoResumeErrorReason */
function categorizeError(message: string): AutoResumeErrorReason {
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes("resume_incompatible") ||
    lowerMessage.includes("session resume unsupported")
  ) {
    return "resume_incompatible";
  }

  // Relay-specific errors
  if (lowerMessage.includes("server_offline")) {
    return "server_offline";
  }
  if (lowerMessage.includes("unknown_username")) {
    return "unknown_username";
  }
  if (
    lowerMessage.includes("waiting for server timed out") ||
    lowerMessage.includes("relay connection timeout")
  ) {
    return "relay_timeout";
  }
  if (
    lowerMessage.includes("failed to connect to relay") ||
    lowerMessage.includes("relay connection closed") ||
    lowerMessage.includes("relay connection error")
  ) {
    return "relay_unreachable";
  }

  // Direct connection errors
  if (
    lowerMessage.includes("websocket") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("connection refused") ||
    lowerMessage.includes("failed to connect") ||
    lowerMessage.includes("connection failed") ||
    lowerMessage.includes("network error")
  ) {
    return "direct_unreachable";
  }

  // Auth errors
  if (
    lowerMessage.includes("authentication") ||
    lowerMessage.includes("session") ||
    lowerMessage.includes("invalid_identity") ||
    lowerMessage.includes("unauthorized")
  ) {
    return "auth_failed";
  }

  return "other";
}

interface Props {
  children: ReactNode;
}

export function RemoteConnectionProvider({ children }: Props) {
  // Load stored credentials synchronously to determine initial state
  const initialStored = loadStoredCredentials();

  const [connection, setConnection] = useState<SecureConnection | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  // Initialize isAutoResuming to true if we have a stored session to resume
  // This prevents a flash of the login form before auto-resume starts
  const [isAutoResuming, setIsAutoResuming] = useState(
    () => !!initialStored?.session,
  );
  const [error, setError] = useState<string | null>(null);
  const [autoResumeError, setAutoResumeError] =
    useState<AutoResumeError | null>(null);
  // Track current host ID for multi-host support
  const [currentHostId, setCurrentHostIdState] = useState<string | null>(null);
  // Keep currentHostId in a ref so handleSessionEstablished always has latest value
  const currentHostIdRef = useRef<string | null>(null);
  const setCurrentHostId = useCallback((hostId: string | null) => {
    currentHostIdRef.current = hostId;
    setCurrentHostIdState(hostId);
  }, []);
  // Track if we've attempted auto-resume (to prevent repeated attempts)
  const [autoResumeAttempted, setAutoResumeAttempted] = useState(false);
  // Track intentional disconnect (to prevent auto-redirect back to host after Switch Host)
  const [isIntentionalDisconnect, setIsIntentionalDisconnect] = useState(false);

  // Keep stored credentials in ref for updates during the component lifecycle
  const storedRef = useRef(initialStored);
  storedRef.current = loadStoredCredentials();

  // Track whether we want to remember sessions
  const rememberMeRef = useRef(false);

  // Callback for when a new session is established (to store it)
  const handleSessionEstablished = useCallback((session: StoredSession) => {
    if (rememberMeRef.current) {
      console.log("[RemoteConnection] Storing session for resumption");
      // Save to old storage (for backwards compatibility)
      updateStoredSession(session);

      // Also save to hostStorage for multi-host support
      const hostId = currentHostIdRef.current;
      if (hostId) {
        console.log("[RemoteConnection] Also updating hostStorage for", hostId);
        updateHostSession(hostId, session);
      }
    }
  }, []);

  // Callback for when connection is lost unexpectedly.
  // Feed the error to ConnectionManager which will attempt reconnection.
  // Do NOT clear React connection state here — defer that until ConnectionManager
  // emits 'disconnected' (all retries exhausted or non-retryable error).
  const handleDisconnect = useCallback((error: Error) => {
    console.log("[RemoteConnection] Connection lost:", error.message);
    connectionManager.handleError(error);
  }, []);

  const connect = useCallback(
    async (
      wsUrl: string,
      username: string,
      password: string,
      rememberMe = false,
    ) => {
      setIsConnecting(true);
      setError(null);
      setIsIntentionalDisconnect(false);
      rememberMeRef.current = rememberMe;

      try {
        // If rememberMe is true, save credentials BEFORE auth so the onSessionEstablished
        // callback can update them. The callback fires during SRP handshake, before
        // conn.fetch() returns.
        if (rememberMe) {
          saveCredentials(wsUrl, username);
        }

        // Create and authenticate connection
        const conn = new SecureConnection(
          wsUrl,
          username,
          password,
          rememberMe ? handleSessionEstablished : undefined,
          handleDisconnect,
        );

        // Test the connection by making a simple request
        // This triggers the SRP handshake and verifies auth
        await conn.fetch("/auth/status");

        // Set global connection BEFORE setConnection to avoid race condition
        // where children render and try to use fetchJSON before globalConnection is set
        setGlobalConnection(conn);
        setConnection(conn);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Connection failed";
        setError(message);
        throw err;
      } finally {
        setIsConnecting(false);
      }
    },
    [handleSessionEstablished, handleDisconnect],
  );

  const resumeSession = useCallback(
    async (password: string) => {
      const currentStored = storedRef.current;
      if (!currentStored?.session) {
        throw new Error("No stored session to resume");
      }

      setIsConnecting(true);
      setError(null);
      rememberMeRef.current = true; // If resuming, we want to keep remembering

      try {
        // Create connection from stored session
        const conn = SecureConnection.fromStoredSession(
          currentStored.session,
          password,
          handleSessionEstablished,
          handleDisconnect,
        );

        // Test the connection - this will try resume, fall back to SRP if needed
        await conn.fetch("/auth/status");

        // Set global connection BEFORE setConnection to avoid race condition
        setGlobalConnection(conn);
        setConnection(conn);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Session resume failed";
        setError(message);
        throw err;
      } finally {
        setIsConnecting(false);
      }
    },
    [handleSessionEstablished, handleDisconnect],
  );

  const connectViaRelay = useCallback(
    async (options: ConnectViaRelayOptions) => {
      const {
        relayUrl,
        relayUsername,
        srpUsername,
        srpPassword,
        rememberMe = false,
        onStatusChange,
        session,
      } = options;

      setIsConnecting(true);
      setError(null);
      setIsIntentionalDisconnect(false);
      rememberMeRef.current = rememberMe;
      onStatusChange?.("connecting_relay");

      try {
        // 1. Connect to relay server
        const ws = new WebSocket(relayUrl);
        ws.binaryType = "arraybuffer";

        // Wait for WebSocket to open
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

        // 2. Send client_connect message
        onStatusChange?.("waiting_server");
        ws.send(
          JSON.stringify({ type: "client_connect", username: relayUsername }),
        );

        // 3. Wait for client_connected or error
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
                // Successfully paired with server
                resolve();
              } else if (isRelayClientError(msg)) {
                ws.close();
                reject(new Error(msg.reason));
              } else {
                // Unexpected message - might be server sending first message
                // This shouldn't happen, but treat as success
                resolve();
              }
            } catch {
              // JSON parse error - unexpected message format
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

        // 4. Now we have a direct pipe to yepanywhere server - do SRP auth
        onStatusChange?.("authenticating");

        // Store credentials if rememberMe
        if (rememberMe) {
          saveCredentials(relayUrl, srpUsername, undefined);
          const stored = loadStoredCredentials();
          if (stored) {
            stored.mode = "relay";
            stored.relayUsername = relayUsername;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
          }
        }

        // Create SecureConnection using the existing WebSocket
        // If session is provided, use resume-only mode; otherwise do fresh SRP auth
        let conn: SecureConnection;
        if (session) {
          conn = await SecureConnection.forResumeOnlyWithSocket(
            ws,
            session,
            rememberMe ? handleSessionEstablished : undefined,
            { relayUrl, relayUsername },
            handleDisconnect,
          );
        } else {
          conn = await SecureConnection.connectWithExistingSocket(
            ws,
            srpUsername,
            srpPassword,
            rememberMe ? handleSessionEstablished : undefined,
            { relayUrl, relayUsername },
            handleDisconnect,
          );
        }

        // Test the connection
        await conn.fetch("/auth/status");

        // Set global connection
        setGlobalConnection(conn);
        setConnection(conn);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Connection failed";
        setError(message);
        onStatusChange?.("error");
        throw err;
      } finally {
        setIsConnecting(false);
      }
    },
    [handleSessionEstablished, handleDisconnect],
  );

  const disconnect = useCallback(
    (isIntentional = true) => {
      // Use flushSync to ensure state updates are processed synchronously
      // before any navigation happens. This prevents race conditions where
      // ConnectionGate might redirect back to the host before seeing the disconnect.
      flushSync(() => {
        if (connection) {
          connection.close();
          setGlobalConnection(null);
          setConnection(null);
        }
        clearStoredCredentials();
        setError(null);
        setAutoResumeError(null);
        // Clear host ID and optionally mark as intentional disconnect
        // Use isIntentional=false for programmatic host switches (e.g., browser back/forward)
        setCurrentHostId(null);
        setIsIntentionalDisconnect(isIntentional);
      });
    },
    [connection, setCurrentHostId],
  );

  const clearAutoResumeError = useCallback(() => {
    setAutoResumeError(null);
  }, []);

  const retryAutoResume = useCallback(() => {
    // Clear error and allow another attempt
    setAutoResumeError(null);
    setAutoResumeAttempted(false);
  }, []);

  // Auto-resume on mount if we have a stored session
  useEffect(() => {
    const currentStored = storedRef.current;

    // Only attempt once, and only if we have a stored session
    if (autoResumeAttempted || !currentStored?.session) {
      return;
    }

    setAutoResumeAttempted(true);

    // Try to resume the stored session without password
    const storedSession = currentStored.session;
    if (!storedSession) return; // Already checked above, but satisfies TypeScript

    const attemptAutoResume = async () => {
      console.log(
        "[RemoteConnection] Attempting auto-resume from stored session",
      );
      setIsConnecting(true);
      setIsAutoResuming(true);
      setError(null);
      rememberMeRef.current = true;

      try {
        let conn: SecureConnection;

        if (currentStored.mode === "relay") {
          // Relay mode: reconnect through relay, then resume SRP session
          console.log("[RemoteConnection] Auto-resume via relay");
          const relayUrl = currentStored.wsUrl;
          const relayUsername = currentStored.relayUsername;

          if (!relayUrl || !relayUsername) {
            throw new Error("Missing relay credentials for auto-resume");
          }

          // 1. Connect to relay server
          const ws = new WebSocket(relayUrl);
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

          // 2. Send client_connect message
          ws.send(
            JSON.stringify({ type: "client_connect", username: relayUsername }),
          );

          // 3. Wait for client_connected or error
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

          // 4. Create SecureConnection for resume using the existing socket
          conn = await SecureConnection.forResumeOnlyWithSocket(
            ws,
            storedSession,
            handleSessionEstablished,
            { relayUrl, relayUsername },
            handleDisconnect,
          );
        } else {
          // Direct mode: just create connection and resume
          conn = SecureConnection.forResumeOnly(
            storedSession,
            handleSessionEstablished,
            handleDisconnect,
          );
        }

        // Test the connection - this will try resume only
        await conn.fetch("/auth/status");

        console.log("[RemoteConnection] Auto-resume successful");
        if (currentStored.mode === "relay") {
          const relayUrl = currentStored.wsUrl;
          const relayUsername = currentStored.relayUsername;

          if (relayUrl && relayUsername) {
            const host = upsertRelayHost({
              relayUrl,
              relayUsername,
              srpUsername: currentStored.username,
              session: storedSession,
            });
            setCurrentHostId(host.id);
          }
        }
        // Set global connection BEFORE setConnection to avoid race condition
        setGlobalConnection(conn);
        setConnection(conn);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(
          "[RemoteConnection] Auto-resume failed, user will need to re-authenticate:",
          message,
        );

        // Create structured error for the modal
        const reason = categorizeError(message);
        const isRelay = currentStored.mode === "relay";

        // Only show the modal for connection failures, not auth failures
        // Auth failures should go straight to login form
        if (reason !== "auth_failed" && reason !== "other") {
          setAutoResumeError({
            reason,
            mode: isRelay ? "relay" : "direct",
            relayUsername: isRelay ? currentStored.relayUsername : undefined,
            serverUrl: currentStored.wsUrl,
            message,
          });
        }
        // If auth_failed or other, just show login form (no modal)
      } finally {
        setIsConnecting(false);
        setIsAutoResuming(false);
      }
    };

    void attemptAutoResume();
  }, [
    autoResumeAttempted,
    handleSessionEstablished,
    handleDisconnect,
    setCurrentHostId,
  ]);

  // Listen for ConnectionManager state changes to sync React state.
  // When reconnection succeeds, restore the React connection state.
  // When reconnection is in progress, keep current state (don't flash to login).
  // When disconnected (all retries exhausted), clear connection and show error.
  useEffect(() => {
    const unsubState = connectionManager.on("stateChange", (state) => {
      if (state === "connected") {
        const globalConn = getGlobalConnection();
        if (globalConn && !connection) {
          console.log(
            "[RemoteConnection] ConnectionManager connected, restoring React state",
          );
          setConnection(globalConn as SecureConnection);
          setError(null);
          setAutoResumeError(null);
        }
      }
      // 'reconnecting' — do nothing, keep current UI state
    });

    const unsubFailed = connectionManager.on("reconnectFailed", (error) => {
      console.log(
        "[RemoteConnection] ConnectionManager reconnect failed:",
        error.message,
      );
      setConnection(null);
      const reason = categorizeError(error.message);
      const currentStored = storedRef.current;
      const isRelay = currentStored?.mode === "relay";
      if (reason !== "auth_failed" && reason !== "other") {
        setAutoResumeError({
          reason,
          mode: isRelay ? "relay" : "direct",
          relayUsername: isRelay ? currentStored?.relayUsername : undefined,
          serverUrl: currentStored?.wsUrl,
          message: error.message,
        });
      } else {
        setError(`Connection lost: ${error.message}`);
      }
    });

    return () => {
      unsubState();
      unsubFailed();
    };
  }, [connection]);

  // Track connection in ref for cleanup (avoids stale closure issues)
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  // Clean up connection on unmount only (not on connection changes)
  // Using empty deps + ref avoids the cleanup running when connection changes
  useEffect(() => {
    return () => {
      if (connectionRef.current) {
        connectionRef.current.close();
        setGlobalConnection(null);
      }
    };
  }, []);

  const currentRelayUsername = useMemo(
    () =>
      currentHostId
        ? (getHostById(currentHostId)?.relayUsername ?? null)
        : null,
    [currentHostId],
  );

  const value: RemoteConnectionState = {
    connection,
    isConnecting,
    isAutoResuming,
    error,
    autoResumeError,
    currentHostId,
    currentRelayUsername,
    setCurrentHostId,
    isIntentionalDisconnect,
    connect,
    connectViaRelay,
    disconnect,
    clearAutoResumeError,
    retryAutoResume,
    storedUrl: storedRef.current?.wsUrl ?? null,
    storedUsername: storedRef.current?.username ?? null,
    hasStoredSession: !!storedRef.current?.session,
    resumeSession,
  };

  return (
    <RemoteConnectionContext.Provider value={value}>
      {children}
    </RemoteConnectionContext.Provider>
  );
}

export function useRemoteConnection(): RemoteConnectionState {
  const context = useContext(RemoteConnectionContext);
  if (!context) {
    throw new Error(
      "useRemoteConnection must be used within RemoteConnectionProvider",
    );
  }
  return context;
}

/**
 * Hook to optionally access remote connection state.
 * Returns null if not within a RemoteConnectionProvider (e.g., non-remote mode).
 */
export function useOptionalRemoteConnection(): RemoteConnectionState | null {
  return useContext(RemoteConnectionContext);
}

/**
 * Hook to get the connection, throwing if not connected.
 * Use this in components that require an active connection.
 */
export function useRequiredConnection(): Connection {
  const { connection } = useRemoteConnection();
  if (!connection) {
    throw new Error("No active connection");
  }
  return connection;
}
