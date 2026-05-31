import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Subscription,
  connectionManager,
  getGlobalConnection,
  getWebSocketConnection,
  isNonRetryableError,
} from "../lib/connection";

export interface SessionWatchTarget {
  sessionId: string;
  projectId: string;
  provider?: string;
}

interface UseSessionWatchStreamOptions {
  onChange: () => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
}

function getSessionWatchTargetKey(
  target: SessionWatchTarget | null,
): string | null {
  if (!target) {
    return null;
  }
  return `${target.projectId}\0${target.sessionId}\0${target.provider ?? ""}`;
}

/**
 * Focused session file-change subscription.
 *
 * Used by session detail pages for non-owned sessions so updates are driven by
 * a targeted server watch for the currently viewed session file.
 */
export function useSessionWatchStream(
  target: SessionWatchTarget | null,
  options: UseSessionWatchStreamOptions,
) {
  const [connected, setConnected] = useState(false);
  const wsSubscriptionRef = useRef<Subscription | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const targetRef = useRef(target);
  targetRef.current = target;
  const mountedKeyRef = useRef<string | null>(null);
  const cleaningUpRef = useRef(false);
  const targetKey = getSessionWatchTargetKey(target);

  const connectWithConnection = useCallback(
    (
      sessionTarget: SessionWatchTarget,
      connection: {
        subscribeSessionWatch: (
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
          options?: { projectId?: string; provider?: string },
        ) => Subscription;
      },
    ) => {
      if (wsSubscriptionRef.current) {
        const old = wsSubscriptionRef.current;
        wsSubscriptionRef.current = null;
        old.close();
      }

      let sub: Subscription | null = null;
      const isStale = () => sub !== null && wsSubscriptionRef.current !== sub;

      const handlers = {
        onEvent: (
          eventType: string,
          _eventId: string | undefined,
          _data: unknown,
        ) => {
          connectionManager.recordEvent();
          if (eventType === "heartbeat") {
            connectionManager.recordHeartbeat();
            return;
          }
          if (eventType === "session-watch-change") {
            optionsRef.current.onChange();
          }
        },
        onOpen: () => {
          if (isStale()) return;
          setConnected(true);
          connectionManager.markConnected();
          optionsRef.current.onOpen?.();
        },
        onError: (error: Error) => {
          if (isStale()) return;
          setConnected(false);
          wsSubscriptionRef.current = null;
          mountedKeyRef.current = null;
          optionsRef.current.onError?.(new Event("error"));
          if (isNonRetryableError(error)) {
            console.warn(
              "[useSessionWatchStream] Non-retryable error, not reconnecting:",
              error.message,
            );
            return;
          }
          connectionManager.handleError(error);
        },
        onClose: () => {
          if (cleaningUpRef.current) return;
          if (isStale()) return;
          setConnected(false);
          wsSubscriptionRef.current = null;
          mountedKeyRef.current = null;
        },
      };

      sub = connection.subscribeSessionWatch(
        sessionTarget.sessionId,
        handlers,
        {
          projectId: sessionTarget.projectId,
          provider: sessionTarget.provider,
        },
      );
      wsSubscriptionRef.current = sub;
    },
    [],
  );

  const connect = useCallback(() => {
    const currentTarget = targetRef.current;
    if (!currentTarget || !targetKey) {
      mountedKeyRef.current = null;
      return;
    }

    if (wsSubscriptionRef.current) return;
    if (mountedKeyRef.current === targetKey) return;
    mountedKeyRef.current = targetKey;

    const globalConn = getGlobalConnection();
    if (globalConn) {
      connectWithConnection(currentTarget, globalConn);
      return;
    }

    connectWithConnection(currentTarget, getWebSocketConnection());
  }, [connectWithConnection, targetKey]);

  useEffect(() => {
    return connectionManager.on("stateChange", (state) => {
      if (state === "reconnecting" || state === "disconnected") {
        if (wsSubscriptionRef.current) {
          const old = wsSubscriptionRef.current;
          wsSubscriptionRef.current = null;
          old.close();
        }
        setConnected(false);
        mountedKeyRef.current = null;
      }
      if (state === "connected" && targetKey && !wsSubscriptionRef.current) {
        connect();
      }
    });
  }, [targetKey, connect]);

  useEffect(() => {
    connect();
    return () => {
      cleaningUpRef.current = true;
      wsSubscriptionRef.current?.close();
      wsSubscriptionRef.current = null;
      mountedKeyRef.current = null;
      cleaningUpRef.current = false;
    };
  }, [connect]);

  return { connected };
}
