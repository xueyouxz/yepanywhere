/**
 * RelayConnectionGate - Layout route for relay host connections.
 *
 * Used as a layout route for /:relayUsername/* in remote-main.tsx.
 * Manages the relay connection lifecycle:
 * - Extracts relayUsername from URL
 * - Looks up saved host by username
 * - Initiates connection if host found with valid session
 * - Redirects to login if no saved session
 * - Once connected, renders ConnectedAppContent + child routes via Outlet
 */

import { useEffect, useMemo, useState } from "react";
import { Navigate, Outlet, useLocation, useParams } from "react-router-dom";
import { ConnectedAppContent } from "../RemoteApp";
import { HostOfflineModal } from "../components/HostOfflineModal";
import {
  type AutoResumeError,
  useRemoteConnection,
} from "../contexts/RemoteConnectionContext";
import { getHostById, getHostByRelayUsername } from "../lib/hostStorage";

type ConnectionState =
  | "checking"
  | "connecting"
  | "connected"
  | "no_host"
  | "no_session"
  | "error";

/** Create an AutoResumeError from an exception */
function createAutoResumeError(
  err: unknown,
  relayUsername: string,
  relayUrl?: string,
): AutoResumeError {
  const message = err instanceof Error ? err.message : String(err);
  const lowerMessage = message.toLowerCase();

  let reason: AutoResumeError["reason"] = "other";
  if (lowerMessage.includes("server_offline")) {
    reason = "server_offline";
  } else if (lowerMessage.includes("unknown_username")) {
    reason = "unknown_username";
  } else if (
    lowerMessage.includes("resume_incompatible") ||
    lowerMessage.includes("session resume unsupported")
  ) {
    reason = "resume_incompatible";
  } else if (
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("timed out")
  ) {
    reason = "relay_timeout";
  } else if (
    lowerMessage.includes("failed to connect to relay") ||
    lowerMessage.includes("relay connection closed") ||
    lowerMessage.includes("relay connection error")
  ) {
    reason = "relay_unreachable";
  } else if (
    lowerMessage.includes("authentication failed") ||
    lowerMessage.includes("auth") ||
    lowerMessage.includes("session")
  ) {
    reason = "auth_failed";
  }

  return {
    reason,
    mode: "relay",
    relayUsername,
    serverUrl: relayUrl,
    message,
  };
}

/**
 * Layout route that manages relay connection and renders child routes when connected.
 */
export function RelayConnectionGate() {
  const { relayUsername } = useParams<{ relayUsername: string }>();
  const location = useLocation();
  const {
    connection,
    connectViaRelay,
    isAutoResuming,
    setCurrentHostId,
    currentHostId,
    isIntentionalDisconnect,
    disconnect,
  } = useRemoteConnection();

  const [state, setState] = useState<ConnectionState>("checking");
  const [error, setError] = useState<AutoResumeError | null>(null);
  const returnTo = useMemo(
    () => `${location.pathname}${location.search}${location.hash}`,
    [location.hash, location.pathname, location.search],
  );
  const relayLoginTarget = useMemo(() => {
    const params = new URLSearchParams();
    if (relayUsername) {
      params.set("u", relayUsername);
    }
    const host = relayUsername ? getHostByRelayUsername(relayUsername) : null;
    if (host?.relayUrl) {
      params.set("r", host.relayUrl);
    }
    params.set("returnTo", returnTo);
    return `/login/relay?${params.toString()}`;
  }, [relayUsername, returnTo]);

  // Attempt to connect when username changes
  useEffect(() => {
    if (!relayUsername) {
      setState("no_host");
      return;
    }

    // If already connected, check if it's to the right host
    if (connection) {
      const currentHost = currentHostId ? getHostById(currentHostId) : null;
      const connectedRelayUsername = currentHost?.relayUsername;

      if (connectedRelayUsername === relayUsername) {
        setState("connected");
        return;
      }

      // If currentHostId is not set (e.g., after auto-resume from old storage),
      // try to find the host by relay username and set it
      if (!currentHostId) {
        const hostByUsername = getHostByRelayUsername(relayUsername);
        if (hostByUsername) {
          console.log(
            `[RelayConnectionGate] Connection without hostId, setting to "${hostByUsername.id}" for "${relayUsername}"`,
          );
          setCurrentHostId(hostByUsername.id);
          setState("connected");
          return;
        }
        console.log(
          `[RelayConnectionGate] Connection without hostId and no saved host for "${relayUsername}", redirecting to login`,
        );
        disconnect(false);
        setState("no_host");
        return;
      }

      // Connected to a different host - disconnect and let the effect reconnect
      console.log(
        `[RelayConnectionGate] Host mismatch: connected to "${connectedRelayUsername}" but URL wants "${relayUsername}", switching...`,
      );
      disconnect(false);
      setState("connecting");
      return;
    }

    // If user intentionally disconnected (e.g., clicked "Switch Host"),
    // don't try to reconnect - they're navigating away
    if (isIntentionalDisconnect) {
      console.log(
        `[RelayConnectionGate] Intentional disconnect, not reconnecting to "${relayUsername}"`,
      );
      return;
    }

    // If auto-resume is in progress, wait for it
    if (isAutoResuming) {
      console.log(
        `[RelayConnectionGate] Auto-resume in progress, waiting... (relayUsername="${relayUsername}")`,
      );
      setState("connecting");
      return;
    }

    // Look up saved host by relay username
    const host = getHostByRelayUsername(relayUsername);
    console.log(
      `[RelayConnectionGate] Looking up host for "${relayUsername}":`,
      host
        ? {
            id: host.id,
            hasSession: !!host.session,
            hasRelayUrl: !!host.relayUrl,
          }
        : "not found",
    );

    if (!host) {
      console.log(
        `[RelayConnectionGate] No saved host for "${relayUsername}", redirecting to login`,
      );
      setState("no_host");
      return;
    }

    if (!host.session || !host.relayUrl) {
      console.log(
        `[RelayConnectionGate] Host "${relayUsername}" has no session or relayUrl, redirecting to login`,
      );
      setState("no_session");
      return;
    }

    // Attempt to connect using saved session
    setState("connecting");
    // Set host ID before auth so session refresh callbacks can sync hostStorage.
    setCurrentHostId(host.id);

    connectViaRelay({
      relayUrl: host.relayUrl,
      relayUsername: host.relayUsername ?? relayUsername,
      srpUsername: host.srpUsername,
      srpPassword: "", // Ignored when session is provided
      rememberMe: true,
      onStatusChange: () => {},
      session: host.session,
    })
      .then(() => {
        setState("connected");
      })
      .catch((err) => {
        setError(
          createAutoResumeError(
            err,
            host.relayUsername ?? relayUsername,
            host.relayUrl,
          ),
        );
        setState("error");
      });
  }, [
    relayUsername,
    connection,
    connectViaRelay,
    isAutoResuming,
    setCurrentHostId,
    currentHostId,
    isIntentionalDisconnect,
    disconnect,
  ]);

  switch (state) {
    case "checking":
    case "connecting":
      return (
        <div className="auto-resume-loading">
          <div className="loading-spinner" />
          <p>Connecting to {relayUsername}...</p>
        </div>
      );

    case "no_host":
    case "no_session":
      return <Navigate to={relayLoginTarget} replace />;

    case "error": {
      const defaultError: AutoResumeError = {
        reason: "other",
        mode: "relay",
        relayUsername: relayUsername ?? "",
        message: "Connection failed",
      };
      if ((error ?? defaultError).reason === "auth_failed") {
        return <Navigate to={relayLoginTarget} replace />;
      }
      return (
        <HostOfflineModal
          error={error ?? defaultError}
          onRetry={() => {
            setState("connecting");
            setError(null);
            const host = getHostByRelayUsername(relayUsername ?? "");
            if (host?.relayUrl && host.relayUsername && host.session) {
              connectViaRelay({
                relayUrl: host.relayUrl,
                relayUsername: host.relayUsername,
                srpUsername: host.srpUsername,
                srpPassword: "", // Ignored when session is provided
                rememberMe: true,
                onStatusChange: () => {},
                session: host.session,
              })
                .then(() => {
                  setCurrentHostId(host.id);
                  setState("connected");
                })
                .catch((err) => {
                  setError(
                    createAutoResumeError(
                      err,
                      host.relayUsername ?? relayUsername ?? "",
                      host.relayUrl,
                    ),
                  );
                  setState("error");
                });
            } else {
              setState("no_session");
            }
          }}
          onGoToLogin={() => setState("no_session")}
        />
      );
    }

    case "connected":
      return (
        <ConnectedAppContent>
          <Outlet />
        </ConnectedAppContent>
      );
  }
}
