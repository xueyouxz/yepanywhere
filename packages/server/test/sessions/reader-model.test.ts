import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionReader } from "../../src/sessions/reader.js";
import { toUrlProjectId } from "@yep-anywhere/shared";

describe("SessionReader model extraction", () => {
  let testDir: string;
  let sessionDir: string;
  let reader: SessionReader;
  const projectId = toUrlProjectId("/test/project");

  beforeEach(async () => {
    testDir = join(tmpdir(), `reader-model-test-${Date.now()}`);
    sessionDir = join(testDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    reader = new SessionReader({ sessionDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function chain(
    entries: Array<{ type: string; message: Record<string, unknown> }>,
  ): string {
    // Thread parentUuid so the reader's active-branch walk sees one chain.
    let parentUuid: string | null = null;
    const lines: string[] = [];
    entries.forEach((e, i) => {
      const uuid = `msg-${i}`;
      lines.push(
        JSON.stringify({
          type: e.type,
          uuid,
          parentUuid,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          message: e.message,
        }),
      );
      parentUuid = uuid;
    });
    return lines.join("\n");
  }

  it("reports the most recent assistant model, not the first", async () => {
    // A forked-with-model-override transcript: old turns on one model, the
    // fork's new turns on another. The session's current model is the last.
    const jsonl = chain([
      { type: "user", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "old turn" }],
        },
      },
      { type: "user", message: { role: "user", content: "continue" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "new turn" }],
        },
      },
    ]);
    await writeFile(join(sessionDir, "s1.jsonl"), `${jsonl}\n`);

    const summary = await reader.getSessionSummary("s1", projectId);
    expect(summary?.model).toBe("claude-haiku-4-5-20251001");
  });

  it("skips trailing synthetic models", async () => {
    const jsonl = chain([
      { type: "user", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "real" }],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "error placeholder" }],
        },
      },
    ]);
    await writeFile(join(sessionDir, "s2.jsonl"), `${jsonl}\n`);

    const summary = await reader.getSessionSummary("s2", projectId);
    expect(summary?.model).toBe("claude-sonnet-4-6");
  });
});
