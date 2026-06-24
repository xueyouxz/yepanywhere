import type { SessionOwnership, UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  applyProcessStateChanged,
  applySessionCreated,
  applySessionLifecycleSnapshot,
  applySessionStatusChanged,
  selectAnySessionWorking,
  selectSessionActivity,
  type SessionLifecycleState,
} from "../sessionLifecycleStore";

const PROJECT_ID = "project-1" as UrlProjectId;
const SELF_OWNER: SessionOwnership = {
  owner: "self",
  processId: "process-1",
};

function emptyState(): SessionLifecycleState {
  return new Map();
}

describe("sessionLifecycleStore", () => {
  it("does not treat owned reusable processes as working", () => {
    const state = applySessionLifecycleSnapshot(
      emptyState(),
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        ownership: SELF_OWNER,
        includesActivity: true,
      },
      100,
    );

    const activity = selectSessionActivity(state.get("session-1"));
    expect(activity.ownership).toEqual(SELF_OWNER);
    expect(activity.isWorking).toBe(false);
    expect(activity.needsInput).toBe(false);
    expect(selectAnySessionWorking(state)).toBe(false);
  });

  it("clears working activity and pending input on idle", () => {
    let state = applyProcessStateChanged(
      emptyState(),
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "waiting-input",
        pendingInputType: "tool-approval",
      },
      100,
    );
    state = applyProcessStateChanged(
      state,
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "idle",
      },
      200,
    );

    const entry = state.get("session-1");
    expect(entry?.activity).toBeUndefined();
    expect(entry?.pendingInputType).toBeUndefined();
    expect(selectSessionActivity(entry)).toMatchObject({
      isWorking: false,
      needsInput: false,
    });
  });

  it("treats waiting-input as attention, not working", () => {
    const state = applyProcessStateChanged(
      emptyState(),
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "waiting-input",
        pendingInputType: "user-question",
      },
      100,
    );

    expect(selectSessionActivity(state.get("session-1"))).toMatchObject({
      activity: "waiting-input",
      pendingInputType: "user-question",
      isWorking: false,
      needsInput: true,
    });
    expect(selectAnySessionWorking(state)).toBe(false);
  });

  it("treats in-turn as working and clears stale pending input", () => {
    let state = applyProcessStateChanged(
      emptyState(),
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "waiting-input",
        pendingInputType: "tool-approval",
      },
      100,
    );
    state = applyProcessStateChanged(
      state,
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "in-turn",
      },
      200,
    );

    expect(selectSessionActivity(state.get("session-1"))).toMatchObject({
      activity: "in-turn",
      pendingInputType: undefined,
      isWorking: true,
      needsInput: false,
    });
    expect(selectAnySessionWorking(state)).toBe(true);
  });

  it("does not let an older snapshot reintroduce working activity", () => {
    let state = applyProcessStateChanged(
      emptyState(),
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "in-turn",
      },
      100,
    );
    state = applyProcessStateChanged(
      state,
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "idle",
      },
      200,
    );
    state = applySessionLifecycleSnapshot(
      state,
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "in-turn",
        includesActivity: true,
      },
      150,
    );

    expect(selectSessionActivity(state.get("session-1"))).toMatchObject({
      isWorking: false,
      needsInput: false,
    });
  });

  it("lets a newer authoritative snapshot heal missed idle events", () => {
    let state = applyProcessStateChanged(
      emptyState(),
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "in-turn",
      },
      100,
    );
    state = applySessionLifecycleSnapshot(
      state,
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        ownership: SELF_OWNER,
        includesActivity: true,
      },
      200,
    );

    expect(selectSessionActivity(state.get("session-1"))).toMatchObject({
      ownership: SELF_OWNER,
      isWorking: false,
      needsInput: false,
    });
  });

  it("keeps ownership and activity clocks independent", () => {
    let state = applyProcessStateChanged(
      emptyState(),
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "in-turn",
      },
      100,
    );
    state = applySessionStatusChanged(
      state,
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        ownership: SELF_OWNER,
      },
      300,
    );
    state = applySessionLifecycleSnapshot(
      state,
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        includesActivity: true,
      },
      200,
    );

    expect(selectSessionActivity(state.get("session-1"))).toMatchObject({
      ownership: SELF_OWNER,
      isWorking: false,
      needsInput: false,
    });
  });

  it("clears activity when ownership becomes none", () => {
    let state = applyProcessStateChanged(
      emptyState(),
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "in-turn",
      },
      100,
    );
    state = applySessionStatusChanged(
      state,
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        ownership: { owner: "none" },
      },
      200,
    );

    expect(selectSessionActivity(state.get("session-1"))).toMatchObject({
      ownership: { owner: "none" },
      isWorking: false,
      needsInput: false,
    });
  });

  it("does not clear activity from metadata-only snapshots", () => {
    let state = applyProcessStateChanged(
      emptyState(),
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "in-turn",
      },
      100,
    );
    state = applySessionLifecycleSnapshot(
      state,
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        title: "Updated title",
      },
      200,
    );

    const entry = state.get("session-1");
    expect(entry?.title).toBe("Updated title");
    expect(selectSessionActivity(entry).isWorking).toBe(true);
  });

  it("seeds missing rows from session-created summaries", () => {
    const state = applySessionCreated(
      emptyState(),
      {
        session: {
          id: "session-1",
          projectId: PROJECT_ID,
          title: "New session",
          updatedAt: "2026-05-31T15:30:00.000Z",
          ownership: SELF_OWNER,
          activity: "in-turn",
          hasUnread: true,
        },
      },
      100,
    );

    const entry = state.get("session-1");
    expect(entry).toMatchObject({
      sessionId: "session-1",
      projectId: PROJECT_ID,
      title: "New session",
      updatedAt: "2026-05-31T15:30:00.000Z",
      ownership: SELF_OWNER,
      activity: "in-turn",
      hasUnread: true,
    });
    expect(selectAnySessionWorking(state)).toBe(true);
  });
});
