import type { SessionOwnership, UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { GlobalSessionItem, InboxResponse } from "../../api/client";
import type { ProcessInfo } from "../../hooks/useProcesses";
import {
  createGlobalSessionLifecycleSnapshots,
  createInboxLifecycleSnapshots,
  createProcessLifecycleSnapshots,
} from "../sessionLifecycleApiSnapshots";

const PROJECT_ID = "project-1" as UrlProjectId;
const SELF_OWNER: SessionOwnership = {
  owner: "self",
  processId: "process-1",
};

function globalSession(
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id: "session-1",
    title: "Derived title",
    fullTitle: "Derived title",
    createdAt: "2026-05-31T16:00:00.000Z",
    updatedAt: "2026-05-31T16:01:00.000Z",
    messageCount: 2,
    provider: "claude",
    projectId: PROJECT_ID,
    projectName: "yepanywhere",
    ownership: SELF_OWNER,
    ...overrides,
  };
}

function processInfo(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    id: "process-1",
    sessionId: "session-1",
    projectId: PROJECT_ID,
    projectPath: "/repo",
    projectName: "yepanywhere",
    state: "in-turn",
    startedAt: "2026-05-31T16:00:00.000Z",
    queueDepth: 0,
    sessionTitle: "Running session",
    provider: "claude",
    ...overrides,
  };
}

describe("sessionLifecycleApiSnapshots", () => {
  it("maps global session rows as authoritative lifecycle snapshots", () => {
    const [snapshot] = createGlobalSessionLifecycleSnapshots([
      globalSession({
        activity: "waiting-input",
        pendingInputType: "tool-approval",
        hasUnread: true,
      }),
    ]);

    expect(snapshot).toMatchObject({
      sessionId: "session-1",
      projectId: PROJECT_ID,
      ownership: SELF_OWNER,
      activity: "waiting-input",
      pendingInputType: "tool-approval",
      hasUnread: true,
      title: "Derived title",
      customTitle: null,
      updatedAt: "2026-05-31T16:01:00.000Z",
      includesActivity: true,
    });
  });

  it("maps inbox attention and active tiers without clearing passive tiers", () => {
    const inbox: InboxResponse = {
      needsAttention: [
        {
          sessionId: "needs-input",
          projectId: PROJECT_ID,
          projectName: "yepanywhere",
          sessionTitle: "Needs input",
          updatedAt: "2026-05-31T16:01:00.000Z",
          pendingInputType: "user-question",
          hasUnread: true,
        },
      ],
      active: [
        {
          sessionId: "active",
          projectId: PROJECT_ID,
          projectName: "yepanywhere",
          sessionTitle: "Active",
          updatedAt: "2026-05-31T16:02:00.000Z",
          activity: "in-turn",
        },
      ],
      recentActivity: [
        {
          sessionId: "recent",
          projectId: PROJECT_ID,
          projectName: "yepanywhere",
          sessionTitle: "Recent",
          updatedAt: "2026-05-31T16:03:00.000Z",
        },
      ],
      unread8h: [],
      unread24h: [],
    };

    const snapshots = createInboxLifecycleSnapshots(inbox);

    expect(snapshots).toHaveLength(3);
    expect(snapshots.find((s) => s.sessionId === "needs-input")).toMatchObject({
      activity: "waiting-input",
      pendingInputType: "user-question",
      includesActivity: true,
      hasUnread: true,
    });
    expect(snapshots.find((s) => s.sessionId === "active")).toMatchObject({
      activity: "in-turn",
      includesActivity: true,
    });
    expect(snapshots.find((s) => s.sessionId === "recent")).toMatchObject({
      title: "Recent",
      updatedAt: "2026-05-31T16:03:00.000Z",
      includesActivity: undefined,
    });
  });

  it("maps active process inventory as owned activity snapshots", () => {
    const [snapshot] = createProcessLifecycleSnapshots([
      processInfo({ state: "idle" }),
    ]);

    expect(snapshot).toMatchObject({
      sessionId: "session-1",
      projectId: PROJECT_ID,
      ownership: {
        owner: "self",
        processId: "process-1",
      },
      activity: "idle",
      title: "Running session",
      includesActivity: true,
    });
  });
});
