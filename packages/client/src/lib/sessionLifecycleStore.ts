import type {
  AgentActivity,
  PendingInputType,
  SessionOwnership,
  UrlProjectId,
} from "@yep-anywhere/shared";

export type SessionLifecycleActivity = "in-turn" | "waiting-input";

export interface SessionLifecycle {
  sessionId: string;
  projectId?: UrlProjectId;
  ownership?: SessionOwnership;
  activity?: SessionLifecycleActivity;
  pendingInputType?: PendingInputType;
  hasUnread?: boolean;
  title?: string | null;
  customTitle?: string | null;
  updatedAt?: string;
  /** Last accepted ownership or activity source, for diagnostics. */
  lifecycleObservedAt: number;
  /** Last accepted activity/pending-input source. */
  activityObservedAt: number;
  /** Last accepted ownership source. */
  ownershipObservedAt?: number;
  /** Last accepted unread/attention source. */
  unreadObservedAt?: number;
  /** Last accepted title/update metadata source. */
  metadataObservedAt?: number;
  /** Most recent snapshot request start that reached the reducer. */
  snapshotObservedAt?: number;
}

export type SessionLifecycleState = ReadonlyMap<string, SessionLifecycle>;

export interface ProcessStateChangedInput {
  sessionId: string;
  projectId?: UrlProjectId;
  activity: AgentActivity;
  pendingInputType?: PendingInputType;
}

export interface SessionStatusChangedInput {
  sessionId: string;
  projectId?: UrlProjectId;
  ownership: SessionOwnership;
}

export interface SessionSeenInput {
  sessionId: string;
}

export interface SessionUpdatedInput {
  sessionId: string;
  projectId?: UrlProjectId;
  title?: string | null;
  customTitle?: string | null;
  updatedAt?: string;
}

export interface SessionCreatedInput {
  session: {
    id: string;
    projectId?: UrlProjectId;
    title?: string | null;
    customTitle?: string | null;
    updatedAt?: string;
    ownership?: SessionOwnership;
    activity?: AgentActivity;
    pendingInputType?: PendingInputType;
    hasUnread?: boolean;
  };
}

export interface SessionLifecycleSnapshotInput {
  sessionId: string;
  projectId?: UrlProjectId;
  ownership?: SessionOwnership;
  activity?: AgentActivity | null;
  pendingInputType?: PendingInputType;
  hasUnread?: boolean;
  title?: string | null;
  customTitle?: string | null;
  updatedAt?: string;
  /**
   * True when this snapshot authoritatively includes current activity state.
   * Missing/null/idle activity then clears working state; false leaves it alone.
   */
  includesActivity?: boolean;
}

export interface SessionActivitySelection {
  activity?: SessionLifecycleActivity;
  ownership?: SessionOwnership;
  pendingInputType?: PendingInputType;
  isWorking: boolean;
  needsInput: boolean;
  hasUnread?: boolean;
}

const NO_OBSERVATION = Number.NEGATIVE_INFINITY;

export function normalizeLifecycleActivity(
  activity: AgentActivity | null | undefined,
): SessionLifecycleActivity | undefined {
  return activity === "in-turn" || activity === "waiting-input"
    ? activity
    : undefined;
}

function getEntry(
  state: SessionLifecycleState,
  sessionId: string,
): SessionLifecycle {
  return (
    state.get(sessionId) ?? {
      sessionId,
      lifecycleObservedAt: NO_OBSERVATION,
      activityObservedAt: NO_OBSERVATION,
    }
  );
}

function putEntry(
  state: SessionLifecycleState,
  entry: SessionLifecycle,
): Map<string, SessionLifecycle> {
  const next = new Map(state);
  next.set(entry.sessionId, entry);
  return next;
}

function withProjectId(
  entry: SessionLifecycle,
  projectId: UrlProjectId | undefined,
): SessionLifecycle {
  if (!projectId || entry.projectId === projectId) {
    return entry;
  }
  return { ...entry, projectId };
}

function applyActivityFields(
  entry: SessionLifecycle,
  activity: AgentActivity | null | undefined,
  pendingInputType: PendingInputType | undefined,
  observedAt: number,
): SessionLifecycle {
  if (observedAt < entry.activityObservedAt) {
    return entry;
  }

  const normalizedActivity = normalizeLifecycleActivity(activity);
  return {
    ...entry,
    activity: normalizedActivity,
    pendingInputType:
      normalizedActivity === "waiting-input" ? pendingInputType : undefined,
    activityObservedAt: observedAt,
    lifecycleObservedAt: Math.max(entry.lifecycleObservedAt, observedAt),
  };
}

export function applyProcessStateChanged(
  state: SessionLifecycleState,
  event: ProcessStateChangedInput,
  observedAt = Date.now(),
): Map<string, SessionLifecycle> {
  const entry = withProjectId(
    getEntry(state, event.sessionId),
    event.projectId,
  );
  return putEntry(
    state,
    applyActivityFields(
      entry,
      event.activity,
      event.pendingInputType,
      observedAt,
    ),
  );
}

export function applySessionStatusChanged(
  state: SessionLifecycleState,
  event: SessionStatusChangedInput,
  observedAt = Date.now(),
): Map<string, SessionLifecycle> {
  const current = withProjectId(
    getEntry(state, event.sessionId),
    event.projectId,
  );
  if (observedAt < (current.ownershipObservedAt ?? NO_OBSERVATION)) {
    return new Map(state);
  }

  let entry: SessionLifecycle = {
    ...current,
    ownership: event.ownership,
    ownershipObservedAt: observedAt,
    lifecycleObservedAt: Math.max(current.lifecycleObservedAt, observedAt),
  };

  if (
    event.ownership.owner === "none" &&
    observedAt >= current.activityObservedAt
  ) {
    entry = applyActivityFields(entry, "idle", undefined, observedAt);
  }

  return putEntry(state, entry);
}

export function applySessionSeen(
  state: SessionLifecycleState,
  event: SessionSeenInput,
  observedAt = Date.now(),
): Map<string, SessionLifecycle> {
  const entry = getEntry(state, event.sessionId);
  if (observedAt < (entry.unreadObservedAt ?? NO_OBSERVATION)) {
    return new Map(state);
  }

  return putEntry(state, {
    ...entry,
    hasUnread: false,
    unreadObservedAt: observedAt,
  });
}

export function applySessionUpdated(
  state: SessionLifecycleState,
  event: SessionUpdatedInput,
  observedAt = Date.now(),
): Map<string, SessionLifecycle> {
  const current = withProjectId(
    getEntry(state, event.sessionId),
    event.projectId,
  );
  if (observedAt < (current.metadataObservedAt ?? NO_OBSERVATION)) {
    return new Map(state);
  }

  return putEntry(state, {
    ...current,
    ...(event.title !== undefined ? { title: event.title } : {}),
    ...(event.customTitle !== undefined
      ? { customTitle: event.customTitle }
      : {}),
    ...(event.updatedAt !== undefined ? { updatedAt: event.updatedAt } : {}),
    metadataObservedAt: observedAt,
  });
}

export function applySessionCreated(
  state: SessionLifecycleState,
  event: SessionCreatedInput,
  observedAt = Date.now(),
): Map<string, SessionLifecycle> {
  const snapshot: SessionLifecycleSnapshotInput = {
    sessionId: event.session.id,
    projectId: event.session.projectId,
    ownership: event.session.ownership,
    activity: event.session.activity,
    pendingInputType: event.session.pendingInputType,
    hasUnread: event.session.hasUnread,
    title: event.session.title,
    customTitle: event.session.customTitle,
    updatedAt: event.session.updatedAt,
    includesActivity: true,
  };
  return applySessionLifecycleSnapshot(state, snapshot, observedAt);
}

export function applySessionLifecycleSnapshot(
  state: SessionLifecycleState,
  snapshot: SessionLifecycleSnapshotInput,
  requestStartedAt: number,
): Map<string, SessionLifecycle> {
  let entry = withProjectId(
    getEntry(state, snapshot.sessionId),
    snapshot.projectId,
  );

  entry = {
    ...entry,
    snapshotObservedAt: Math.max(
      entry.snapshotObservedAt ?? NO_OBSERVATION,
      requestStartedAt,
    ),
  };

  if (requestStartedAt >= (entry.metadataObservedAt ?? NO_OBSERVATION)) {
    entry = {
      ...entry,
      ...(snapshot.title !== undefined ? { title: snapshot.title } : {}),
      ...(snapshot.customTitle !== undefined
        ? { customTitle: snapshot.customTitle }
        : {}),
      ...(snapshot.updatedAt !== undefined
        ? { updatedAt: snapshot.updatedAt }
        : {}),
      metadataObservedAt: requestStartedAt,
    };
  }

  if (
    snapshot.hasUnread !== undefined &&
    requestStartedAt >= (entry.unreadObservedAt ?? NO_OBSERVATION)
  ) {
    entry = {
      ...entry,
      hasUnread: snapshot.hasUnread,
      unreadObservedAt: requestStartedAt,
    };
  }

  if (
    snapshot.ownership !== undefined &&
    requestStartedAt >= (entry.ownershipObservedAt ?? NO_OBSERVATION)
  ) {
    entry = {
      ...entry,
      ownership: snapshot.ownership,
      ownershipObservedAt: requestStartedAt,
      lifecycleObservedAt: Math.max(
        entry.lifecycleObservedAt,
        requestStartedAt,
      ),
    };
  }

  if (snapshot.includesActivity === true) {
    if (requestStartedAt >= entry.activityObservedAt) {
      entry = applyActivityFields(
        entry,
        snapshot.activity,
        snapshot.pendingInputType,
        requestStartedAt,
      );
    }
  }

  return putEntry(state, entry);
}

export function selectSessionActivity(
  entry: SessionLifecycle | undefined,
): SessionActivitySelection {
  const activity = entry?.activity;
  return {
    activity,
    ownership: entry?.ownership,
    pendingInputType: entry?.pendingInputType,
    isWorking: activity === "in-turn",
    needsInput: activity === "waiting-input",
    hasUnread: entry?.hasUnread,
  };
}

export function selectAnySessionWorking(state: SessionLifecycleState): boolean {
  for (const entry of state.values()) {
    if (entry.activity === "in-turn") {
      return true;
    }
  }
  return false;
}
