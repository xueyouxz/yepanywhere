import { useSyncExternalStore } from "react";
import { api } from "../../api/client";
import {
  getRemoteLogCollectionEnabled,
  subscribeDeveloperMode,
} from "../../hooks/useDeveloperMode";
import { ClientLogCollector } from "./ClientLogCollector";

export const clientLogCollector = new ClientLogCollector();

const SERVER_REQUEST_POLL_MS = 10_000;
const TAB_DISABLE_KEY = "yep-anywhere-client-log-collection-disabled";

export type ClientLogCollectionReason = "client" | "server" | "client+server";

export interface ClientLogCollectionStatus {
  active: boolean;
  localRequested: boolean;
  serverRequested: boolean;
  disabledForTab: boolean;
  reason: ClientLogCollectionReason | null;
}

const statusListeners = new Set<() => void>();
let serverRequested = false;
let disabledForTab = loadTabDisabled();
let currentStatus: ClientLogCollectionStatus = buildStatus();
let developerModeUnsubscribe: (() => void) | null = null;
let serverPollTimer: ReturnType<typeof setInterval> | null = null;
let initCount = 0;
let refreshGeneration = 0;

function loadTabDisabled(): boolean {
  try {
    return sessionStorage.getItem(TAB_DISABLE_KEY) === "true";
  } catch {
    return false;
  }
}

function persistTabDisabled(disabled: boolean): void {
  try {
    if (disabled) {
      sessionStorage.setItem(TAB_DISABLE_KEY, "true");
    } else {
      sessionStorage.removeItem(TAB_DISABLE_KEY);
    }
  } catch {
    // Ignore storage failures; the in-memory flag still applies.
  }
}

function buildStatus(): ClientLogCollectionStatus {
  const localRequested = getRemoteLogCollectionEnabled();
  const active = !disabledForTab && (localRequested || serverRequested);
  let reason: ClientLogCollectionReason | null = null;
  if (active) {
    reason =
      localRequested && serverRequested
        ? "client+server"
        : localRequested
          ? "client"
          : "server";
  }
  return {
    active,
    localRequested,
    serverRequested,
    disabledForTab,
    reason,
  };
}

function sameStatus(
  a: ClientLogCollectionStatus,
  b: ClientLogCollectionStatus,
): boolean {
  return (
    a.active === b.active &&
    a.localRequested === b.localRequested &&
    a.serverRequested === b.serverRequested &&
    a.disabledForTab === b.disabledForTab &&
    a.reason === b.reason
  );
}

function notifyStatusListeners(): void {
  for (const listener of statusListeners) {
    listener();
  }
}

function applyCollectionStatus(): void {
  const nextStatus = buildStatus();
  if (nextStatus.active) {
    void clientLogCollector.start();
  } else {
    clientLogCollector.stop();
  }

  if (!sameStatus(nextStatus, currentStatus)) {
    currentStatus = nextStatus;
    notifyStatusListeners();
  } else {
    currentStatus = nextStatus;
  }
}

async function refreshServerLogCollectionRequest(): Promise<void> {
  const generation = refreshGeneration;
  try {
    const response = await api.getServerSettings();
    if (generation !== refreshGeneration) return;
    serverRequested = response.settings.clientLogCollectionRequested === true;
    applyCollectionStatus();
  } catch {
    // Fetch failures must not opt clients in. Preserve the previous known server
    // request so a transient reconnect does not flap active collection off.
  }
}

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function getStatusSnapshot(): ClientLogCollectionStatus {
  return currentStatus;
}

export function useClientLogCollectionStatus(): ClientLogCollectionStatus {
  return useSyncExternalStore(subscribeStatus, getStatusSnapshot);
}

export function isClientLogCollectionActive(): boolean {
  return currentStatus.active;
}

export function disableClientLogCollectionForTab(): void {
  disabledForTab = true;
  persistTabDisabled(true);
  applyCollectionStatus();
}

/**
 * Initialize client log collection based on the developer mode setting and
 * the server's diagnostic collection request.
 * Returns a cleanup function.
 */
export function initClientLogCollection(): () => void {
  initCount += 1;
  if (initCount === 1) {
    disabledForTab = loadTabDisabled();
    currentStatus = buildStatus();
    applyCollectionStatus();
    developerModeUnsubscribe = subscribeDeveloperMode(applyCollectionStatus);
    void refreshServerLogCollectionRequest();
    serverPollTimer = setInterval(() => {
      void refreshServerLogCollectionRequest();
    }, SERVER_REQUEST_POLL_MS);
  }

  return () => {
    initCount -= 1;
    if (initCount > 0) return;
    initCount = 0;
    refreshGeneration += 1;
    developerModeUnsubscribe?.();
    developerModeUnsubscribe = null;
    if (serverPollTimer) {
      clearInterval(serverPollTimer);
      serverPollTimer = null;
    }
    serverRequested = false;
    currentStatus = buildStatus();
    clientLogCollector.stop();
    notifyStatusListeners();
  };
}
