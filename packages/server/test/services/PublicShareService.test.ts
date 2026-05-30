import type { AppSession, UrlProjectId } from "@yep-anywhere/shared";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_SHARE_SECRET_BITS,
  PUBLIC_SHARE_SECRET_BYTES,
  PublicShareService,
} from "../../src/services/PublicShareService.js";

const projectId = "cHJvamVjdA" as UrlProjectId;

function makeSession(overrides: Partial<AppSession> = {}): AppSession {
  return {
    id: "session-1",
    projectId,
    title: "Test session",
    fullTitle: "Test session",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:01:00.000Z",
    messageCount: 0,
    ownership: { owner: "self", processId: "proc-1" },
    provider: "codex",
    messages: [],
    pendingInputType: "tool-approval",
    activity: "waiting-input",
    lastSeenAt: "2026-05-01T00:00:30.000Z",
    hasUnread: true,
    ...overrides,
  } as AppSession;
}

describe("PublicShareService", () => {
  let service: PublicShareService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "public-shares-test-"));
    service = new PublicShareService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("generates a 512-bit URL secret and stores only its hash", async () => {
    const { secret, secretBits } = await service.createShare({
      mode: "frozen",
      title: "Share me",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });

    expect(secretBits).toBe(PUBLIC_SHARE_SECRET_BITS);
    expect(Buffer.from(secret, "base64url")).toHaveLength(
      PUBLIC_SHARE_SECRET_BYTES,
    );

    const persisted = await fs.readFile(
      path.join(testDir, "public-shares.json"),
      "utf-8",
    );
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("secretHash");
  });

  it("rejects missing, short, and guessed secrets", async () => {
    await service.createShare({
      mode: "frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });

    expect(service.getRecordBySecret("")).toBeNull();
    expect(service.getRecordBySecret("short")).toBeNull();
    expect(
      service.getRecordBySecret(Buffer.alloc(64, 1).toString("base64url")),
    ).toBeNull();
  });

  it("stores frozen shares as sanitized read-only snapshots", async () => {
    const session = makeSession({
      messages: [
        {
          type: "user",
          uuid: "message-1",
          message: { role: "user", content: "hello" },
          timestamp: "2026-05-01T00:00:00.000Z",
        },
      ] as AppSession["messages"],
    }) as AppSession & {
      heartbeatTurnText?: string;
      heartbeatTurnsAfterMinutes?: number;
      heartbeatTurnsEnabled?: boolean;
    };
    session.heartbeatTurnsEnabled = true;
    session.heartbeatTurnsAfterMinutes = 5;
    session.heartbeatTurnText = "heartbeat";

    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: session,
    });

    const share = service.getFrozenShareBySecret(secret);
    expect(share?.share.mode).toBe("frozen");
    expect(share?.session.ownership).toEqual({ owner: "none" });
    expect(share?.session.messages).toHaveLength(1);
    expect(share?.session.pendingInputType).toBeUndefined();
    expect(share?.session.activity).toBeUndefined();
    expect(share?.session.lastSeenAt).toBeUndefined();
    expect(share?.session.hasUnread).toBeUndefined();
    expect(
      (share?.session as typeof session).heartbeatTurnsEnabled,
    ).toBeUndefined();
  });

  it("builds live responses from the current session", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const record = service.getRecordBySecret(secret);

    expect(record?.frozenSession).toBeUndefined();
    const response = service.buildLiveResponse(
      record!,
      makeSession({ updatedAt: "2026-05-01T00:02:00.000Z" }),
    );

    expect(response.share.mode).toBe("live");
    expect(response.share.updatedAt).toBe("2026-05-01T00:02:00.000Z");
    expect(response.session.ownership).toEqual({ owner: "none" });
  });

  it("summarizes and revokes all shares for a source session", async () => {
    await service.createShare({
      mode: "frozen",
      title: "Frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });
    await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    await service.createShare({
      mode: "live",
      title: "Other",
      source: {
        projectId,
        sessionId: "session-2",
        projectName: "project",
        provider: "codex",
      },
    });

    expect(service.getSessionShareStatus(projectId, "session-1")).toEqual({
      activeCount: 2,
      frozenCount: 1,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [],
    });

    await expect(
      service.revokeSessionShares(projectId, "session-1"),
    ).resolves.toEqual({
      activeCount: 0,
      frozenCount: 0,
      liveCount: 0,
      activeViewerCount: 0,
      viewers: [],
      revokedCount: 2,
    });
    expect(service.getSessionShareStatus(projectId, "session-2")).toEqual({
      activeCount: 1,
      frozenCount: 0,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [],
    });
  });

  it("freezes live shares as snapshots without changing their secrets", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });

    await expect(
      service.freezeSessionLiveShares(
        projectId,
        "session-1",
        makeSession({ updatedAt: "2026-05-01T00:03:00.000Z" }),
      ),
    ).resolves.toMatchObject({
      activeCount: 1,
      frozenCount: 1,
      liveCount: 0,
      convertedCount: 1,
    });

    const response = service.getFrozenShareBySecret(secret);
    expect(response?.share.mode).toBe("frozen");
    expect(response?.session.updatedAt).toBe("2026-05-01T00:03:00.000Z");
  });

  it("freezes and disconnects individual viewer tokens", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const record = service.getRecordBySecret(secret);
    expect(record).not.toBeNull();
    service.recordViewerHeartbeat(record!, "viewer-one");

    await service.freezeSessionViewerToken(
      projectId,
      "session-1",
      "viewer-one",
      makeSession({ updatedAt: "2026-05-01T00:04:00.000Z" }),
    );
    const frozenRecord = service.getRecordBySecret(secret);
    expect(
      service.getViewerSnapshotResponse(frozenRecord!, "viewer-one")?.session
        .updatedAt,
    ).toBe("2026-05-01T00:04:00.000Z");
    expect(service.getSessionShareStatus(projectId, "session-1").viewers).toEqual(
      [],
    );

    await service.disconnectSessionViewerToken(
      projectId,
      "session-1",
      "viewer-one",
    );
    const disconnectedRecord = service.getRecordBySecret(secret);
    expect(service.isViewerDisconnected(disconnectedRecord!, "viewer-one")).toBe(
      true,
    );
    expect(
      service.getViewerSnapshotResponse(disconnectedRecord!, "viewer-one"),
    ).toBeNull();
  });

  it("counts active viewers by share secret", async () => {
    const first = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const second = await service.createShare({
      mode: "frozen",
      title: "Frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });

    const firstRecord = service.getRecordBySecret(first.secret);
    const secondRecord = service.getRecordBySecret(second.secret);
    expect(firstRecord).not.toBeNull();
    expect(secondRecord).not.toBeNull();

    expect(service.recordViewerHeartbeat(firstRecord!, "viewer-one")).toBe(1);
    expect(service.recordViewerHeartbeat(firstRecord!, "viewer-two")).toBe(2);
    expect(service.recordViewerHeartbeat(firstRecord!, "bad id")).toBe(2);
    expect(service.recordViewerHeartbeat(secondRecord!, "viewer-three")).toBe(
      1,
    );

    expect(
      service.buildLiveResponse(firstRecord!, makeSession()).share
        .activeViewerCount,
    ).toBe(2);
    expect(service.getSessionShareStatus(projectId, "session-1")).toMatchObject({
      activeViewerCount: 3,
    });
  });

  it("keeps viewers active until they miss a session update grace period", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
      const { secret } = await service.createShare({
        mode: "live",
        title: "Live",
        source: {
          projectId,
          sessionId: "session-1",
          projectName: "project",
          provider: "codex",
        },
      });
      const record = service.getRecordBySecret(secret);
      expect(record).not.toBeNull();
      service.recordViewerHeartbeat(record!, "viewer-one");

      vi.setSystemTime(new Date("2026-05-01T00:01:00.000Z"));
      expect(
        service.getSessionShareStatus(projectId, "session-1").activeViewerCount,
      ).toBe(1);
      expect(
        service.getSessionShareStatus(projectId, "session-1", {
          sessionUpdatedAt: "2026-05-01T00:00:40.000Z",
        }).activeViewerCount,
      ).toBe(1);
      expect(
        service.getSessionShareStatus(projectId, "session-1", {
          sessionUpdatedAt: "2026-05-01T00:00:20.000Z",
        }).activeViewerCount,
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
