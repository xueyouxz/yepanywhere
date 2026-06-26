import type { ConnectionInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { activityBus } from "../lib/activityBus";

interface ConnectedDevicesState {
  /** Map of browserProfileId to connection info */
  connections: Map<string, ConnectionInfo>;
  isLoading: boolean;
  error: string | null;
}

/**
 * Hook for managing connected browser profiles with real-time updates.
 *
 * Fetches initial connection data from the server, then subscribes to
 * browser-tab-connected and browser-tab-disconnected events for real-time updates.
 */
export function useConnectedDevices() {
  const [state, setState] = useState<ConnectedDevicesState>({
    connections: new Map(),
    isLoading: true,
    error: null,
  });

  // `quiet` skips the loading/error flash: used by the reconnect/visibility
  // backstop so an already-rendered device list doesn't flicker to a spinner.
  const fetchConnections = useCallback(async (quiet = false) => {
    if (!quiet) setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      const { connections } = await api.getConnections();
      const connectionMap = new Map<string, ConnectionInfo>();
      for (const conn of connections) {
        connectionMap.set(conn.browserProfileId, conn);
      }
      setState((s) => ({
        ...s,
        connections: connectionMap,
        isLoading: false,
        error: null,
      }));
    } catch (err) {
      console.error("[useConnectedDevices] Failed to fetch:", err);
      if (quiet) return;
      setState((s) => ({
        ...s,
        isLoading: false,
        error:
          err instanceof Error ? err.message : "Failed to load connections",
      }));
    }
  }, []);

  const refetch = useCallback(() => fetchConnections(false), [fetchConnections]);

  // Fetch on mount
  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  // Subscribe to real-time connection events
  useEffect(() => {
    const unsubConnect = activityBus.on("browser-tab-connected", (event) => {
      setState((s) => {
        const newConnections = new Map(s.connections);
        newConnections.set(event.browserProfileId, {
          browserProfileId: event.browserProfileId,
          connectionCount: event.tabCount,
          connectedAt: event.timestamp,
          // deviceName will come from the push subscription, not the connection event
          deviceName: s.connections.get(event.browserProfileId)?.deviceName,
        });
        return { ...s, connections: newConnections };
      });
    });

    const unsubDisconnect = activityBus.on(
      "browser-tab-disconnected",
      (event) => {
        setState((s) => {
          const newConnections = new Map(s.connections);
          if (event.tabCount === 0) {
            // All tabs closed for this browser profile
            newConnections.delete(event.browserProfileId);
          } else {
            // Update the connection count
            const existing = newConnections.get(event.browserProfileId);
            if (existing) {
              newConnections.set(event.browserProfileId, {
                ...existing,
                connectionCount: event.tabCount,
              });
            }
          }
          return { ...s, connections: newConnections };
        });
      },
    );

    // Also refetch on reconnect to ensure we have accurate data — quietly, so
    // the device list doesn't flash a loading state on every reconnect.
    const unsubReconnect = activityBus.on("reconnect", () => {
      fetchConnections(true);
    });

    // Refetch on visibility restore (also quiet)
    const unsubRefresh = activityBus.on("refresh", () => {
      fetchConnections(true);
    });

    return () => {
      unsubConnect();
      unsubDisconnect();
      unsubReconnect();
      unsubRefresh();
    };
  }, [fetchConnections]);

  return {
    ...state,
    /** Array of connections for easier rendering */
    connectionList: Array.from(state.connections.values()),
    refetch,
  };
}
