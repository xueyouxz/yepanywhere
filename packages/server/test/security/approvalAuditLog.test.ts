import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendApprovalAuditLog } from "../../src/security/approvalAuditLog.js";

describe("appendApprovalAuditLog", () => {
  let testDir: string | undefined;

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
      testDir = undefined;
    }
  });

  it("appends approval decisions to an owner-private jsonl log", async () => {
    testDir = await mkdtemp(join(tmpdir(), "yep-approval-audit-"));
    const request = {
      id: "req-1",
      sessionId: "session-1",
      type: "tool-approval" as const,
      prompt: "Allow command?",
      toolName: "Bash",
      toolInput: { command: "echo secret" },
      timestamp: "2026-05-03T00:00:00.000Z",
    };

    await appendApprovalAuditLog(testDir, {
      timestamp: "2026-05-03T00:00:01.000Z",
      sessionId: request.sessionId,
      processId: randomUUID(),
      provider: "codex",
      requestId: request.id,
      request,
      response: "approve",
      normalizedResponse: "approve",
      accepted: true,
      permissionModeBefore: "default",
      permissionModeAfter: "default",
    });

    const logDir = join(testDir, "logs");
    const logPath = join(logDir, "approval-decisions.jsonl");
    const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      sessionId: "session-1",
      requestId: "req-1",
      request,
      response: "approve",
      accepted: true,
    });

    if (process.platform !== "win32") {
      expect((await stat(logDir)).mode & 0o777).toBe(0o700);
      expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    }
  });
});
