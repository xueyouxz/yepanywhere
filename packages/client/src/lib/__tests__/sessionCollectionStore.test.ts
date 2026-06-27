import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { GlobalSessionItem } from "../../api/client";
import type { SessionCreatedEvent } from "../activityBus";
import {
  applyGlobalSessionsCollectionSnapshot,
  applySessionCollectionCreated,
  applySessionCollectionMetadataChanged,
  applySessionCollectionProcessStateChanged,
  createEmptySessionCollectionState,
  createGlobalSessionsQueryKey,
  selectRecentSessionRecords,
  selectSessionCollectionRecord,
  selectStarredSessionRecords,
} from "../sessionCollectionStore";

const PROJECT_ID = "project-1" as UrlProjectId;
const NOW = Date.parse("2026-06-27T12:00:00.000Z");
const RECENT = "2026-06-27T11:00:00.000Z";

function globalSession(
  id: string,
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id,
    title: `Session ${id}`,
    fullTitle: `Session ${id}`,
    createdAt: RECENT,
    updatedAt: RECENT,
    messageCount: 1,
    provider: "claude",
    projectId: PROJECT_ID,
    projectName: "Project",
    ownership: { owner: "none" },
    isArchived: false,
    isStarred: false,
    ...overrides,
  };
}

function createdEvent(id: string): SessionCreatedEvent {
  return {
    type: "session-created",
    session: {
      id,
      projectId: PROJECT_ID,
      title: `Session ${id}`,
      fullTitle: `Session ${id}`,
      createdAt: RECENT,
      updatedAt: RECENT,
      messageCount: 1,
      ownership: { owner: "self", processId: "process-1" },
      provider: "claude",
      activity: "in-turn",
    },
    timestamp: RECENT,
  };
}

describe("sessionCollectionStore", () => {
  it("keeps an event-created entity when an older snapshot omits it", () => {
    let state = applySessionCollectionCreated(
      createEmptySessionCollectionState(),
      createdEvent("new-session"),
      200,
    );

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [],
        hasMore: false,
        mode: "replace",
      },
      100,
    );

    expect(selectSessionCollectionRecord(state, "new-session")).toMatchObject({
      id: "new-session",
      activity: "in-turn",
    });
    expect(selectRecentSessionRecords(state, NOW).map((s) => s.id)).toEqual([
      "new-session",
    ]);
  });

  it("moves starred rows between derived projections from one entity", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptySessionCollectionState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [globalSession("session-1")],
        hasMore: false,
      },
      100,
    );

    expect(selectRecentSessionRecords(state, NOW).map((s) => s.id)).toEqual([
      "session-1",
    ]);
    expect(selectStarredSessionRecords(state)).toEqual([]);

    state = applySessionCollectionMetadataChanged(
      state,
      {
        type: "session-metadata-changed",
        sessionId: "session-1",
        starred: true,
        timestamp: "2026-06-27T12:00:01.000Z",
      },
      200,
    );

    expect(selectRecentSessionRecords(state, NOW)).toEqual([]);
    expect(selectStarredSessionRecords(state).map((s) => s.id)).toEqual([
      "session-1",
    ]);
  });

  it("keeps active recent rows stable when updatedAt changes", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptySessionCollectionState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession("active-a", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-a" },
            updatedAt: "2026-06-27T11:00:00.000Z",
          }),
          globalSession("active-b", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-b" },
            updatedAt: "2026-06-27T11:05:00.000Z",
          }),
        ],
        hasMore: false,
      },
      100,
    );

    expect(selectRecentSessionRecords(state, NOW).map((s) => s.id)).toEqual([
      "active-a",
      "active-b",
    ]);

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession("active-b", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-b" },
            updatedAt: "2026-06-27T11:10:00.000Z",
          }),
          globalSession("active-a", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-a" },
            updatedAt: "2026-06-27T11:01:00.000Z",
          }),
        ],
        hasMore: false,
      },
      200,
    );

    expect(selectRecentSessionRecords(state, NOW).map((s) => s.id)).toEqual([
      "active-a",
      "active-b",
    ]);
  });

  it("keeps active starred rows stable when updatedAt changes", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptySessionCollectionState(),
      {
        query: { scope: "global-sessions", starred: true, limit: 50 },
        sessions: [
          globalSession("active-a", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-a" },
            isStarred: true,
            updatedAt: "2026-06-27T11:00:00.000Z",
          }),
          globalSession("active-b", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-b" },
            isStarred: true,
            updatedAt: "2026-06-27T11:05:00.000Z",
          }),
        ],
        hasMore: false,
      },
      100,
    );

    expect(selectStarredSessionRecords(state).map((s) => s.id)).toEqual([
      "active-a",
      "active-b",
    ]);

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", starred: true, limit: 50 },
        sessions: [
          globalSession("active-b", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-b" },
            isStarred: true,
            updatedAt: "2026-06-27T11:10:00.000Z",
          }),
          globalSession("active-a", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-a" },
            isStarred: true,
            updatedAt: "2026-06-27T11:01:00.000Z",
          }),
        ],
        hasMore: false,
      },
      200,
    );

    expect(selectStarredSessionRecords(state).map((s) => s.id)).toEqual([
      "active-a",
      "active-b",
    ]);
  });

  it("pins active starred rows above idle starred rows", () => {
    const state = applyGlobalSessionsCollectionSnapshot(
      createEmptySessionCollectionState(),
      {
        query: { scope: "global-sessions", starred: true, limit: 50 },
        sessions: [
          globalSession("idle-new", {
            isStarred: true,
            updatedAt: "2026-06-27T11:30:00.000Z",
          }),
          globalSession("active-old", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-old" },
            isStarred: true,
            updatedAt: "2026-06-27T11:00:00.000Z",
          }),
        ],
        hasMore: false,
      },
      100,
    );

    expect(selectStarredSessionRecords(state).map((s) => s.id)).toEqual([
      "active-old",
      "idle-new",
    ]);
  });

  it("pins newly active recent rows above idle rows", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptySessionCollectionState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession("idle-new", {
            updatedAt: "2026-06-27T11:30:00.000Z",
          }),
          globalSession("idle-old", {
            updatedAt: "2026-06-27T11:00:00.000Z",
          }),
        ],
        hasMore: false,
      },
      100,
    );

    state = applySessionCollectionProcessStateChanged(
      state,
      {
        type: "process-state-changed",
        projectId: PROJECT_ID,
        sessionId: "idle-old",
        activity: "in-turn",
        timestamp: "2026-06-27T11:45:00.000Z",
      },
      200,
    );

    expect(selectRecentSessionRecords(state, NOW).map((s) => s.id)).toEqual([
      "idle-old",
      "idle-new",
    ]);
  });

  it("does not let an older snapshot undo newer metadata", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptySessionCollectionState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [globalSession("session-1", { isStarred: false })],
        hasMore: false,
      },
      100,
    );
    state = applySessionCollectionMetadataChanged(
      state,
      {
        type: "session-metadata-changed",
        sessionId: "session-1",
        starred: true,
        timestamp: "2026-06-27T12:00:01.000Z",
      },
      200,
    );
    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [globalSession("session-1", { isStarred: false })],
        hasMore: false,
      },
      150,
    );

    expect(selectSessionCollectionRecord(state, "session-1")?.isStarred).toBe(
      true,
    );
  });

  it("stores query ids separately from entity facts", () => {
    const query = {
      scope: "global-sessions" as const,
      starred: true,
      limit: 50,
    };
    const state = applyGlobalSessionsCollectionSnapshot(
      createEmptySessionCollectionState(),
      {
        query,
        sessions: [globalSession("starred", { isStarred: true })],
        hasMore: true,
      },
      100,
    );

    const key = createGlobalSessionsQueryKey(query);
    expect(state.queries.get(key)).toMatchObject({
      ids: ["starred"],
      hasMore: true,
    });
    expect(selectSessionCollectionRecord(state, "starred")).toMatchObject({
      id: "starred",
      isStarred: true,
    });
  });
});
