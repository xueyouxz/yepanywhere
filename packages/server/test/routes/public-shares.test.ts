import type { AppSession, UrlProjectId } from "@yep-anywhere/shared";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicSharePublicRoutes } from "../../src/routes/public-shares.js";
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
    });

    const response = await app.request(`/${secret}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(loadSession).toHaveBeenCalledWith(projectId, "session-1");
    expect(body.share.mode).toBe("frozen");
    expect(body.session.messages).toHaveLength(2);
    expect(body.session.ownership).toEqual({ owner: "none" });
  });
});
