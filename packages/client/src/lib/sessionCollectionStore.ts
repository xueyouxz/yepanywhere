import type {
  AgentActivity,
  PendingInputType,
  ProviderName,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { GlobalSessionItem } from "../api/client";
import type { SessionStatus } from "../types";
import type {
  ProcessStateEvent,
  SessionCreatedEvent,
  SessionMetadataChangedEvent,
  SessionSeenEvent,
  SessionStatusEvent,
  SessionUpdatedEvent,
} from "./activityBus";

const NO_OBSERVATION = Number.NEGATIVE_INFINITY;

export interface SessionCollectionRecord {
  id: string;
  title?: string | null;
  fullTitle?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  provider?: ProviderName;
  model?: string;
  projectId?: string;
  projectName?: string;
  ownership?: SessionStatus;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  activeStartedAt?: number;
  parentSessionId?: string;
  initialPrompt?: string;
  executor?: string;
  lastAgentText?: string;
  observedAt: number;
  snapshotObservedAt?: number;
  contentObservedAt?: number;
  metadataObservedAt?: number;
  projectObservedAt?: number;
  lifecycleObservedAt?: number;
  unreadObservedAt?: number;
  eventCreatedAt?: number;
}

export interface SessionCollectionQueryDescriptor {
  scope: "global-sessions";
  projectId?: string | null;
  searchQuery?: string;
  limit?: number;
  includeArchived?: boolean;
  starred?: boolean;
}

export interface SessionCollectionQueryState {
  key: string;
  descriptor: SessionCollectionQueryDescriptor;
  ids: string[];
  hasMore: boolean;
  requestStartedAt: number;
  fetchedAt: number;
}

export interface SessionCollectionState {
  entities: ReadonlyMap<string, SessionCollectionRecord>;
  queries: ReadonlyMap<string, SessionCollectionQueryState>;
}

export interface GlobalSessionsCollectionSnapshot {
  query: SessionCollectionQueryDescriptor;
  sessions: readonly GlobalSessionItem[];
  hasMore: boolean;
  mode?: "replace" | "append";
}

export function createEmptySessionCollectionState(): SessionCollectionState {
  return {
    entities: new Map(),
    queries: new Map(),
  };
}

export function createGlobalSessionsQueryKey(
  descriptor: SessionCollectionQueryDescriptor,
): string {
  const normalized = {
    scope: descriptor.scope,
    projectId: descriptor.projectId ?? null,
    searchQuery: descriptor.searchQuery?.trim() || null,
    limit: descriptor.limit ?? null,
    includeArchived: descriptor.includeArchived === true,
    starred: descriptor.starred === true,
  };
  return JSON.stringify(normalized);
}

function getRecord(
  state: SessionCollectionState,
  sessionId: string,
): SessionCollectionRecord {
  return (
    state.entities.get(sessionId) ?? {
      id: sessionId,
      observedAt: NO_OBSERVATION,
    }
  );
}

function putRecord(
  state: SessionCollectionState,
  record: SessionCollectionRecord,
): SessionCollectionState {
  const entities = new Map(state.entities);
  entities.set(record.id, record);
  return {
    ...state,
    entities,
  };
}

function normalizeActivity(
  activity: AgentActivity | null | undefined,
): AgentActivity | undefined {
  return activity === "in-turn" || activity === "waiting-input"
    ? activity
    : undefined;
}

function isActiveActivity(activity: AgentActivity | undefined): boolean {
  return activity === "in-turn" || activity === "waiting-input";
}

function withContentFields(
  record: SessionCollectionRecord,
  fields: {
    title?: string | null;
    fullTitle?: string | null;
    createdAt?: string;
    updatedAt?: string;
    messageCount?: number;
    provider?: ProviderName;
    model?: string;
    initialPrompt?: string;
    lastAgentText?: string;
  },
  observedAt: number,
): SessionCollectionRecord {
  if (Object.values(fields).every((value) => value === undefined)) {
    return record;
  }
  if (observedAt < (record.contentObservedAt ?? NO_OBSERVATION)) {
    return record;
  }

  return {
    ...record,
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.fullTitle !== undefined ? { fullTitle: fields.fullTitle } : {}),
    ...(fields.createdAt !== undefined ? { createdAt: fields.createdAt } : {}),
    ...(fields.updatedAt !== undefined ? { updatedAt: fields.updatedAt } : {}),
    ...(fields.messageCount !== undefined
      ? { messageCount: fields.messageCount }
      : {}),
    ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    ...(fields.initialPrompt !== undefined
      ? { initialPrompt: fields.initialPrompt }
      : {}),
    ...(fields.lastAgentText !== undefined
      ? { lastAgentText: fields.lastAgentText }
      : {}),
    contentObservedAt: observedAt,
    observedAt: Math.max(record.observedAt, observedAt),
  };
}

function withMetadataFields(
  record: SessionCollectionRecord,
  fields: {
    customTitle?: string;
    isArchived?: boolean;
    isStarred?: boolean;
    parentSessionId?: string;
    executor?: string;
  },
  observedAt: number,
): SessionCollectionRecord {
  if (Object.values(fields).every((value) => value === undefined)) {
    return record;
  }
  if (observedAt < (record.metadataObservedAt ?? NO_OBSERVATION)) {
    return record;
  }

  return {
    ...record,
    ...(fields.customTitle !== undefined
      ? { customTitle: fields.customTitle }
      : {}),
    ...(fields.isArchived !== undefined
      ? { isArchived: fields.isArchived }
      : {}),
    ...(fields.isStarred !== undefined ? { isStarred: fields.isStarred } : {}),
    ...(fields.parentSessionId !== undefined
      ? { parentSessionId: fields.parentSessionId }
      : {}),
    ...(fields.executor !== undefined ? { executor: fields.executor } : {}),
    metadataObservedAt: observedAt,
    observedAt: Math.max(record.observedAt, observedAt),
  };
}

function withProjectFields(
  record: SessionCollectionRecord,
  fields: {
    projectId?: string;
    projectName?: string;
  },
  observedAt: number,
): SessionCollectionRecord {
  if (Object.values(fields).every((value) => value === undefined)) {
    return record;
  }
  if (observedAt < (record.projectObservedAt ?? NO_OBSERVATION)) {
    return record;
  }

  return {
    ...record,
    ...(fields.projectId !== undefined ? { projectId: fields.projectId } : {}),
    ...(fields.projectName !== undefined
      ? { projectName: fields.projectName }
      : {}),
    projectObservedAt: observedAt,
    observedAt: Math.max(record.observedAt, observedAt),
  };
}

function withLifecycleFields(
  record: SessionCollectionRecord,
  fields: {
    ownership?: SessionStatus;
    activity?: AgentActivity | null;
    pendingInputType?: PendingInputType;
  },
  observedAt: number,
): SessionCollectionRecord {
  if (
    fields.ownership === undefined &&
    fields.activity === undefined &&
    fields.pendingInputType === undefined
  ) {
    return record;
  }
  if (observedAt < (record.lifecycleObservedAt ?? NO_OBSERVATION)) {
    return record;
  }

  const normalizedActivity = normalizeActivity(fields.activity);
  const wasActive = isActiveActivity(record.activity);
  const isActive = isActiveActivity(normalizedActivity);
  return {
    ...record,
    ...(fields.ownership !== undefined ? { ownership: fields.ownership } : {}),
    activity: normalizedActivity,
    activeStartedAt: isActive
      ? wasActive
        ? record.activeStartedAt
        : observedAt
      : undefined,
    pendingInputType:
      normalizedActivity === "waiting-input"
        ? fields.pendingInputType
        : undefined,
    lifecycleObservedAt: observedAt,
    observedAt: Math.max(record.observedAt, observedAt),
  };
}

function withUnreadField(
  record: SessionCollectionRecord,
  hasUnread: boolean | undefined,
  observedAt: number,
): SessionCollectionRecord {
  if (
    hasUnread === undefined ||
    observedAt < (record.unreadObservedAt ?? NO_OBSERVATION)
  ) {
    return record;
  }

  return {
    ...record,
    hasUnread,
    unreadObservedAt: observedAt,
    observedAt: Math.max(record.observedAt, observedAt),
  };
}

function upsertSnapshotRecord(
  state: SessionCollectionState,
  row: GlobalSessionItem,
  requestStartedAt: number,
): SessionCollectionState {
  let record = getRecord(state, row.id);

  record = withContentFields(
    record,
    {
      title: row.title,
      fullTitle: row.fullTitle,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: row.messageCount,
      provider: row.provider,
      model: row.model,
      initialPrompt: row.initialPrompt,
      lastAgentText: row.lastAgentText,
    },
    requestStartedAt,
  );

  record = withMetadataFields(
    record,
    {
      customTitle: row.customTitle,
      isArchived: row.isArchived,
      isStarred: row.isStarred,
      parentSessionId: row.parentSessionId,
      executor: row.executor,
    },
    requestStartedAt,
  );

  record = withProjectFields(
    record,
    {
      projectId: row.projectId,
      projectName: row.projectName,
    },
    requestStartedAt,
  );

  record = withLifecycleFields(
    record,
    {
      ownership: row.ownership,
      activity: row.activity,
      pendingInputType: row.pendingInputType,
    },
    requestStartedAt,
  );

  record = withUnreadField(record, row.hasUnread, requestStartedAt);

  record = {
    ...record,
    snapshotObservedAt: Math.max(
      record.snapshotObservedAt ?? NO_OBSERVATION,
      requestStartedAt,
    ),
    observedAt: Math.max(record.observedAt, requestStartedAt),
  };

  return putRecord(state, record);
}

function upsertQuery(
  state: SessionCollectionState,
  snapshot: GlobalSessionsCollectionSnapshot,
  requestStartedAt: number,
): SessionCollectionState {
  const key = createGlobalSessionsQueryKey(snapshot.query);
  const existing = state.queries.get(key);
  if (existing && requestStartedAt < existing.requestStartedAt) {
    return state;
  }

  const incomingIds = snapshot.sessions.map((session) => session.id);
  const ids =
    snapshot.mode === "append" && existing
      ? [
          ...existing.ids,
          ...incomingIds.filter((id) => !existing.ids.includes(id)),
        ]
      : incomingIds;

  const queries = new Map(state.queries);
  queries.set(key, {
    key,
    descriptor: snapshot.query,
    ids,
    hasMore: snapshot.hasMore,
    requestStartedAt,
    fetchedAt: Date.now(),
  });

  return {
    ...state,
    queries,
  };
}

export function applyGlobalSessionsCollectionSnapshot(
  state: SessionCollectionState,
  snapshot: GlobalSessionsCollectionSnapshot,
  requestStartedAt = Date.now(),
): SessionCollectionState {
  let next = state;
  for (const row of snapshot.sessions) {
    next = upsertSnapshotRecord(next, row, requestStartedAt);
  }
  return upsertQuery(next, snapshot, requestStartedAt);
}

export function applySessionCollectionCreated(
  state: SessionCollectionState,
  event: SessionCreatedEvent,
  observedAt = Date.now(),
): SessionCollectionState {
  const session = event.session;
  let record = getRecord(state, session.id);

  record = withContentFields(
    record,
    {
      title: session.title,
      fullTitle: session.fullTitle,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      provider: session.provider,
      model: session.model,
      initialPrompt: session.initialPrompt,
      lastAgentText: session.lastAgentText,
    },
    observedAt,
  );

  record = withMetadataFields(
    record,
    {
      customTitle: session.customTitle,
      isArchived: session.isArchived,
      isStarred: session.isStarred,
      parentSessionId: session.parentSessionId,
    },
    observedAt,
  );

  record = withProjectFields(
    record,
    {
      projectId: session.projectId,
      projectName: session.projectId,
    },
    observedAt,
  );

  record = withLifecycleFields(
    record,
    {
      ownership: session.ownership,
      activity: session.activity,
      pendingInputType: session.pendingInputType,
    },
    observedAt,
  );

  record = withUnreadField(record, session.hasUnread, observedAt);

  return putRecord(state, {
    ...record,
    eventCreatedAt: observedAt,
    observedAt: Math.max(record.observedAt, observedAt),
  });
}

export function applySessionCollectionUpdated(
  state: SessionCollectionState,
  event: SessionUpdatedEvent,
  observedAt = Date.now(),
): SessionCollectionState {
  const record = withContentFields(
    getRecord(state, event.sessionId),
    {
      title: event.title,
      updatedAt: event.updatedAt,
      messageCount: event.messageCount,
      model: event.model,
      lastAgentText: event.lastAgentText,
    },
    observedAt,
  );
  return putRecord(state, record);
}

export function applySessionCollectionMetadataChanged(
  state: SessionCollectionState,
  event: SessionMetadataChangedEvent,
  observedAt = Date.now(),
): SessionCollectionState {
  const record = withMetadataFields(
    getRecord(state, event.sessionId),
    {
      customTitle: event.title,
      isArchived: event.archived,
      isStarred: event.starred,
      parentSessionId: event.parentSessionId ?? undefined,
    },
    observedAt,
  );
  const withProject = withProjectFields(
    record,
    { projectId: event.projectId },
    observedAt,
  );
  return putRecord(state, withProject);
}

export function applySessionCollectionStatusChanged(
  state: SessionCollectionState,
  event: SessionStatusEvent,
  observedAt = Date.now(),
): SessionCollectionState {
  let record = getRecord(state, event.sessionId);
  record = withProjectFields(record, { projectId: event.projectId }, observedAt);
  record = withLifecycleFields(
    record,
    {
      ownership: event.ownership,
      activity: event.ownership.owner === "none" ? "idle" : record.activity,
      pendingInputType: record.pendingInputType,
    },
    observedAt,
  );
  return putRecord(state, record);
}

export function applySessionCollectionProcessStateChanged(
  state: SessionCollectionState,
  event: ProcessStateEvent,
  observedAt = Date.now(),
): SessionCollectionState {
  let record = getRecord(state, event.sessionId);
  record = withProjectFields(record, { projectId: event.projectId }, observedAt);
  record = withLifecycleFields(
    record,
    {
      activity: event.activity,
      pendingInputType: event.pendingInputType,
    },
    observedAt,
  );
  return putRecord(state, record);
}

export function applySessionCollectionSeen(
  state: SessionCollectionState,
  event: SessionSeenEvent,
  observedAt = Date.now(),
): SessionCollectionState {
  const record = withUnreadField(
    getRecord(state, event.sessionId),
    false,
    observedAt,
  );
  return putRecord(state, record);
}

export function selectSessionCollectionRecord(
  state: SessionCollectionState,
  sessionId: string | null | undefined,
): SessionCollectionRecord | undefined {
  return sessionId ? state.entities.get(sessionId) : undefined;
}

function updatedAtMs(record: SessionCollectionRecord): number {
  return record.updatedAt ? Date.parse(record.updatedAt) || 0 : 0;
}

function byUpdatedAtDesc(
  a: SessionCollectionRecord,
  b: SessionCollectionRecord,
): number {
  return updatedAtMs(b) - updatedAtMs(a);
}

function activeStartedAtMs(record: SessionCollectionRecord): number {
  return record.activeStartedAt ?? record.eventCreatedAt ?? record.observedAt;
}

function byActiveStartedAtDesc(
  a: SessionCollectionRecord,
  b: SessionCollectionRecord,
): number {
  return activeStartedAtMs(b) - activeStartedAtMs(a);
}

export function selectStarredSessionRecords(
  state: SessionCollectionState,
): SessionCollectionRecord[] {
  return Array.from(state.entities.values())
    .filter((record) => record.isStarred === true && record.isArchived !== true)
    .sort(byUpdatedAtDesc);
}

export function selectRecentSessionRecords(
  state: SessionCollectionState,
  now = Date.now(),
): SessionCollectionRecord[] {
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const records = Array.from(state.entities.values()).filter(
    (record) =>
      record.isStarred !== true &&
      record.isArchived !== true &&
      updatedAtMs(record) >= oneDayAgo,
  );

  const active = records
    .filter((record) => isActiveActivity(record.activity))
    .sort(byActiveStartedAtDesc);
  const idle = records
    .filter((record) => !isActiveActivity(record.activity))
    .sort(byUpdatedAtDesc);

  return [...active, ...idle];
}

export function selectOlderSessionRecords(
  state: SessionCollectionState,
  now = Date.now(),
): SessionCollectionRecord[] {
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  return Array.from(state.entities.values())
    .filter(
      (record) =>
        record.isStarred !== true &&
        record.isArchived !== true &&
        updatedAtMs(record) < oneDayAgo,
    )
    .sort(byUpdatedAtDesc);
}

export function selectSessionCollectionQueryRecords(
  state: SessionCollectionState,
  query: SessionCollectionQueryDescriptor,
): SessionCollectionRecord[] {
  const key = createGlobalSessionsQueryKey(query);
  const queryState = state.queries.get(key);
  if (!queryState) {
    return [];
  }

  return queryState.ids.flatMap((id) => {
    const record = state.entities.get(id);
    return record ? [record] : [];
  });
}

export function toProjectId(projectId: string | UrlProjectId): UrlProjectId {
  return projectId as UrlProjectId;
}
