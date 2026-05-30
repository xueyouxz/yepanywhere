import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Subscription,
  connectionManager,
  getGlobalConnection,
  getWebSocketConnection,
  isNonRetryableError,
} from "../lib/connection";
import { logSessionUiTrace } from "../lib/diagnostics/uiTrace";

interface UseSessionStreamOptions {
  onMessage: (data: { eventType: string; [key: string]: unknown }) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
}

function summarizeStreamPayload(
  eventType: string,
  data: unknown,
): Record<string, unknown> {
  const record =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return {
    eventType,
    sdkType: typeof record.type === "string" ? record.type : undefined,
    subtype: typeof record.subtype === "string" ? record.subtype : undefined,
    role: typeof record.role === "string" ? record.role : undefined,
    state: typeof record.state === "string" ? record.state : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    tempId: typeof record.tempId === "string" ? record.tempId : undefined,
    deferredCount: Array.isArray(record.messages)
      ? record.messages.length
      : undefined,
  };
}

export function useSessionStream(
  sessionId: string | null,
  options: UseSessionStreamOptions,
) {
  const [connected, setConnected] = useState(false);
  const wsSubscriptionRef = useRef<Subscription | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Track connected sessionId to skip StrictMode double-mount (not reset in cleanup)
  const mountedSessionIdRef = useRef<string | null>(null);
  // True during intentional cleanup — suppresses reconnect in onClose handler
  const cleaningUpRef = useRef(false);

  const connect = useCallback(() => {
    if (!sessionId) {
      // Reset tracking when sessionId becomes null so we can reconnect later
      // (e.g., when status goes idle → owned again for the same session)
      mountedSessionIdRef.current = null;
      logSessionUiTrace("session-stream-disabled");
      return;
    }

    // Don't create duplicate connections
    if (wsSubscriptionRef.current) return;

    // Skip StrictMode double-mount (same sessionId, already connected once)
    if (mountedSessionIdRef.current === sessionId) return;
    mountedSessionIdRef.current = sessionId;

    // Check for global connection first (remote mode with SecureConnection)
    const globalConn = getGlobalConnection();
    if (globalConn) {
      connectWithConnection(sessionId, globalConn);
      return;
    }

    // Local mode: always use WebSocket
    connectWithConnection(sessionId, getWebSocketConnection());
  }, [sessionId]);

  /**
   * Connect using a provided connection (remote or local WebSocket).
   */
  const connectWithConnection = useCallback(
    (
      sessionId: string,
      connection: {
        subscribeSession: (
          sessionId: string,
          handlers: {
            onEvent: (
              eventType: string,
              eventId: string | undefined,
              data: unknown,
            ) => void;
            onOpen?: () => void;
            onError?: (err: Error) => void;
            onClose?: () => void;
          },
          lastEventId?: string,
        ) => Subscription;
      },
    ) => {
      // Close any existing subscription before creating a new one.
      // Clear ref BEFORE close() so isStale() returns true for the old
      // subscription's handlers if they fire synchronously during close.
      if (wsSubscriptionRef.current) {
        const old = wsSubscriptionRef.current;
        wsSubscriptionRef.current = null;
        old.close();
      }

      // Track this specific subscription instance for staleness detection.
      // When ConnectionManager reconnects, a new subscription replaces this one.
      // Without this guard, the old subscription's late-firing onClose would
      // clear the new subscription's state (wsSubscriptionRef, mountedSessionIdRef).
      let sub: Subscription | null = null;
      const isStale = () => sub !== null && wsSubscriptionRef.current !== sub;

      const handlers = {
        onEvent: (
          eventType: string,
          eventId: string | undefined,
          data: unknown,
        ) => {
          connectionManager.recordEvent();
          if (eventType === "heartbeat") {
            connectionManager.recordHeartbeat();
            return;
          }
          logSessionUiTrace("session-stream-event", {
            sessionId,
            eventId: eventId ?? null,
            ...summarizeStreamPayload(eventType, data),
          });
          if (eventId) {
            lastEventIdRef.current = eventId;
          }
          optionsRef.current.onMessage({
            ...(data as Record<string, unknown>),
            eventType,
          });
        },
        onOpen: () => {
          if (isStale()) return;
          logSessionUiTrace("session-stream-open", { sessionId });
          setConnected(true);
          connectionManager.markConnected();
          optionsRef.current.onOpen?.();
        },
        onError: (error: Error) => {
          if (isStale()) return;
          logSessionUiTrace("session-stream-error", {
            sessionId,
            message: error.message,
            nonRetryable: isNonRetryableError(error),
          });
          setConnected(false);
          wsSubscriptionRef.current = null;
          mountedSessionIdRef.current = null;
          optionsRef.current.onError?.(new Event("error"));

          // Don't signal ConnectionManager for subscription-level 404s
          if (isNonRetryableError(error)) {
            console.warn(
              "[useSessionStream] Non-retryable error, not reconnecting:",
              error.message,
            );
            return;
          }
          connectionManager.handleError(error);
        },
        onClose: () => {
          if (cleaningUpRef.current) return;
          if (isStale()) return;
          logSessionUiTrace("session-stream-close", { sessionId });
          setConnected(false);
          wsSubscriptionRef.current = null;
          mountedSessionIdRef.current = null;
        },
      };

      logSessionUiTrace("session-stream-subscribe", {
        sessionId,
        lastEventId: lastEventIdRef.current ?? null,
      });
      sub = connection.subscribeSession(
        sessionId,
        handlers,
        lastEventIdRef.current ?? undefined,
      );
      wsSubscriptionRef.current = sub;
    },
    [],
  );

  // Listen for ConnectionManager state changes to re-subscribe
  useEffect(() => {
    return connectionManager.on("stateChange", (state) => {
      if (state === "reconnecting" || state === "disconnected") {
        logSessionUiTrace("session-stream-transport-state", {
          sessionId,
          state,
        });
        // Proactively tear down the session subscription. Without this,
        // the "connected" stateChange can fire before the old subscription's
        // onClose, causing the !wsSubscriptionRef.current guard to skip
        // reconnection — leaving the session stream permanently disconnected
        // while the underlying transport is fine.
        if (wsSubscriptionRef.current) {
          const old = wsSubscriptionRef.current;
          wsSubscriptionRef.current = null;
          old.close();
        }
        setConnected(false);
        mountedSessionIdRef.current = null;
      }
      if (state === "connected" && sessionId && !wsSubscriptionRef.current) {
        logSessionUiTrace("session-stream-transport-reconnect", { sessionId });
        connect();
      }
    });
  }, [sessionId, connect]);

  // Force reconnect (e.g., after process restart)
  const reconnect = useCallback(() => {
    if (!sessionId) return;
    logSessionUiTrace("session-stream-reconnect-requested", { sessionId });
    if (wsSubscriptionRef.current) {
      const old = wsSubscriptionRef.current;
      wsSubscriptionRef.current = null;
      old.close();
    }
    mountedSessionIdRef.current = null;
    setConnected(false);
    // Defer so the close completes before reconnecting
    setTimeout(() => connect(), 50);
  }, [sessionId, connect]);

  useEffect(() => {
    connect();

    return () => {
      // Set flag BEFORE close() so onClose handler doesn't schedule a ghost reconnect
      cleaningUpRef.current = true;
      wsSubscriptionRef.current?.close();
      wsSubscriptionRef.current = null;
      // Reset mountedSessionIdRef so the next mount can connect
      // This is needed for StrictMode where cleanup runs between mounts
      mountedSessionIdRef.current = null;
      cleaningUpRef.current = false;
    };
  }, [connect]);

  return { connected, reconnect };
}
