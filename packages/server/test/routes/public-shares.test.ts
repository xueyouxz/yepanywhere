import type { AppSession, UrlProjectId } from "@yep-anywhere/shared";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPublicSharePublicRoutes,
  createPublicShareRoutes,
} from "../../src/routes/public-shares.js";
import { PublicShareService } from "../../src/services/PublicShareService.js";

const projectId = "cHJvamVjdA" as UrlProjectId;

function makeSession(overrides: Partial<AppSession> = {}): AppSession {
  return {
    id: "session-1",
    projectId,
    title: "Test session",
    fullTitle: "Test session",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:01:00.000Z",
    messageCount: 1,
    ownership: { owner: "self", processId: "proc-1" },
    provider: "codex",
    messages: [
      {
        type: "user",
        uuid: "message-1",
        message: { role: "user", content: "hello" },
        timestamp: "2026-05-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  } as AppSession;
}

describe("public share public routes", () => {
  let service: PublicShareService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "public-share-routes-test-"),
    );
    service = new PublicShareService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("repairs frozen shares captured without embedded messages", async () => {
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Broken old snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: {
        ...makeSession({ messageCount: 2 }),
        messages: undefined,
      } as unknown as AppSession,
    });
    const sourceSession = makeSession({
      messageCount: 2,
      messages: [
        ...makeSession().messages,
        {
          type: "assistant",
          uuid: "message-2",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "repaired" }],
          },
          timestamp: "2026-05-01T00:00:01.000Z",
        },
      ],
    });
    const loadSession = vi.fn(async () => sourceSession);
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession,
      getPublicSharesEnabled: () => true,
    });

    const response = await app.request(`/${secret}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(loadSession).toHaveBeenCalledWith(projectId, "session-1");
    expect(body.share.mode).toBe("frozen");
    expect(body.session.messages).toHaveLength(2);
    expect(body.session.ownership).toEqual({ owner: "none" });
  });

  it("does not expose a public viewer heartbeat mutation route", async () => {
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getPublicSharesEnabled: () => true,
    });

    const response = await app.request(`/${secret}/viewers/viewer-one`, {
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect(
      service.getActiveViewerCount(service.getRecordBySecret(secret)!),
    ).toBe(0);
  });

  it("does not resolve secret links when the feature is disabled", async () => {
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getPublicSharesEnabled: () => false,
    });

    const response = await app.request(`/${secret}`);

    expect(response.status).toBe(404);
  });
});

describe("public share owner routes", () => {
  let service: PublicShareService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "public-share-owner-routes-test-"),
    );
    service = new PublicShareService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("blocks new share creation when the feature is disabled", async () => {
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getRelayConfig: () => ({
        url: "wss://relay.example/ws",
        username: "host-one",
      }),
      getPublicSharesEnabled: () => false,
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        sessionId: "session-1",
        mode: "frozen",
      }),
    });

    expect(response.status).toBe(403);
    expect(
      service.getSessionShareStatus(projectId, "session-1").activeCount,
    ).toBe(0);
  });

  it("creates new shares when the feature is enabled", async () => {
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getRelayConfig: () => ({
        url: "wss://relay.example/ws",
        username: "host-one",
      }),
      getPublicSharesEnabled: () => true,
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        sessionId: "session-1",
        mode: "frozen",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain("https://ya.graehl.org/share/");
    expect(
      service.getSessionShareStatus(projectId, "session-1").activeCount,
    ).toBe(1);
  });

  it("revokes all shares when requested by the settings kill switch", async () => {
    await service.createShare({
      mode: "frozen",
      title: "Snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });
    expect(
      service.getSessionShareStatus(projectId, "session-1").activeCount,
    ).toBe(1);

    const revokedCount = await service.revokeAllShares();

    expect(revokedCount).toBe(1);
    expect(
      service.getSessionShareStatus(projectId, "session-1").activeCount,
    ).toBe(0);
  });
});
