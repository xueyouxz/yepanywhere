import { useMemo, useSyncExternalStore } from "react";
import {
  activityBus,
  type ProcessStateEvent,
  type SessionCreatedEvent,
  type SessionMetadataChangedEvent,
  type SessionSeenEvent,
  type SessionStatusEvent,
  type SessionUpdatedEvent,
} from "./activityBus";
import {
  applyProcessStateChanged,
  applySessionCreated,
  applySessionLifecycleSnapshot,
  applySessionSeen,
  applySessionStatusChanged,
  applySessionUpdated,
  selectAnySessionWorking,
  selectSessionActivity,
  type SessionActivitySelection,
  type SessionLifecycle,
  type SessionLifecycleSnapshotInput,
  type SessionLifecycleState,
} from "./sessionLifecycleStore";

type StoreListener = () => void;
type BusUnsubscribe = () => void;

let snapshot: SessionLifecycleState = new Map();
const listeners = new Set<StoreListener>();
let activityBusUnsubscribers: BusUnsubscribe[] | null = null;

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function updateSnapshot(
  update: (current: SessionLifecycleState) => SessionLifecycleState,
): void {
  snapshot = update(snapshot);
  notifyListeners();
}

function reduceProcessStateChanged(event: ProcessStateEvent): void {
  updateSnapshot((current) => applyProcessStateChanged(current, event));
}

function reduceSessionStatusChanged(event: SessionStatusEvent): void {
  updateSnapshot((current) => applySessionStatusChanged(current, event));
}

function reduceSessionSeen(event: SessionSeenEvent): void {
  updateSnapshot((current) => applySessionSeen(current, event));
}

function reduceSessionUpdated(event: SessionUpdatedEvent): void {
  updateSnapshot((current) =>
    applySessionUpdated(current, {
      sessionId: event.sessionId,
      projectId: event.projectId,
      title: event.title,
      updatedAt: event.updatedAt,
    }),
  );
}

function reduceSessionMetadataChanged(
  event: SessionMetadataChangedEvent,
): void {
  updateSnapshot((current) =>
    applySessionUpdated(current, {
      sessionId: event.sessionId,
      customTitle: event.title,
    }),
  );
}

function reduceSessionCreated(event: SessionCreatedEvent): void {
  updateSnapshot((current) => applySessionCreated(current, event));
}

function startActivityBusSubscription(): void {
  if (activityBusUnsubscribers) {
    return;
  }

  activityBusUnsubscribers = [
    activityBus.on("process-state-changed", reduceProcessStateChanged),
    activityBus.on("session-status-changed", reduceSessionStatusChanged),
    activityBus.on("session-seen", reduceSessionSeen),
    activityBus.on("session-updated", reduceSessionUpdated),
    activityBus.on("session-metadata-changed", reduceSessionMetadataChanged),
    activityBus.on("session-created", reduceSessionCreated),
  ];
}

function stopActivityBusSubscriptionIfIdle(): void {
  if (listeners.size > 0 || !activityBusUnsubscribers) {
    return;
  }

  for (const unsubscribe of activityBusUnsubscribers) {
    unsubscribe();
  }
  activityBusUnsubscribers = null;
}

export function subscribeSessionLifecycle(listener: StoreListener): () => void {
  listeners.add(listener);
  startActivityBusSubscription();

  return () => {
    listeners.delete(listener);
    stopActivityBusSubscriptionIfIdle();
  };
}

export function getSessionLifecycleSnapshot(): SessionLifecycleState {
  return snapshot;
}

export function getSessionLifecycleServerSnapshot(): SessionLifecycleState {
  return snapshot;
}

export function reportSessionLifecycleSnapshot(
  input: SessionLifecycleSnapshotInput,
  requestStartedAt = Date.now(),
): void {
  updateSnapshot((current) =>
    applySessionLifecycleSnapshot(current, input, requestStartedAt),
  );
}

export function reportSessionLifecycleSnapshots(
  inputs: SessionLifecycleSnapshotInput[],
  requestStartedAt = Date.now(),
): void {
  updateSnapshot((current) => {
    let next = current;
    for (const input of inputs) {
      next = applySessionLifecycleSnapshot(next, input, requestStartedAt);
    }
    return next;
  });
}

export function useSessionLifecycleState(): SessionLifecycleState {
  return useSyncExternalStore(
    subscribeSessionLifecycle,
    getSessionLifecycleSnapshot,
    getSessionLifecycleServerSnapshot,
  );
}

export function useSessionLifecycle(
  sessionId: string | null | undefined,
): SessionLifecycle | undefined {
  const state = useSessionLifecycleState();
  return sessionId ? state.get(sessionId) : undefined;
}

export function useSessionActivity(
  sessionId: string | null | undefined,
): SessionActivitySelection {
  return selectSessionActivity(useSessionLifecycle(sessionId));
}

export function useAnySessionWorking(): boolean {
  return selectAnySessionWorking(useSessionLifecycleState());
}

export function useSessionLifecycleMap(
  sessionIds: readonly string[],
): ReadonlyMap<string, SessionLifecycle> {
  const state = useSessionLifecycleState();
  const sessionIdsKey = sessionIds.join("\0");

  return useMemo(() => {
    const selected = new Map<string, SessionLifecycle>();
    for (const sessionId of sessionIds) {
      const entry = state.get(sessionId);
      if (entry) {
        selected.set(sessionId, entry);
      }
    }
    return selected;
  }, [state, sessionIds, sessionIdsKey]);
}

export function resetSessionLifecycleStoreForTests(): void {
  snapshot = new Map();
  listeners.clear();
  if (activityBusUnsubscribers) {
    for (const unsubscribe of activityBusUnsubscribers) {
      unsubscribe();
    }
    activityBusUnsubscribers = null;
  }
}
