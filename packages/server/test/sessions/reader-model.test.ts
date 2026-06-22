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

  it("uses the first entry's content timestamp as createdAt", async () => {
    // birthtime is unreliable on Linux (epoch); the creation age must come from
    // the transcript's first entry, not the file stat.
    const created = "2026-06-20T08:30:00.000Z";
    const later = "2026-06-20T09:15:00.000Z";
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u0",
        parentUuid: null,
        timestamp: created,
        message: { role: "user", content: "first" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a0",
        parentUuid: "u0",
        timestamp: later,
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "hi" }],
        },
      }),
    ].join("\n");
    await writeFile(join(sessionDir, "s3.jsonl"), `${lines}\n`);

    const summary = await reader.getSessionSummary("s3", projectId);
    expect(summary?.createdAt).toBe(created);
  });

  describe("lastAgentText (recent agent turn excerpt)", () => {
    it("keeps only the last lines of the most recent agent turn", async () => {
      const jsonl = chain([
        { type: "user", message: { role: "user", content: "go" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            content: [{ type: "text", text: "first\nsecond\nthird\nfourth" }],
          },
        },
      ]);
      await writeFile(join(sessionDir, "la1.jsonl"), `${jsonl}\n`);

      const summary = await reader.getSessionSummary("la1", projectId);
      expect(summary?.lastAgentText).toBe("second\nthird\nfourth");
    });

    it("lightly strips markdown and collapses blank lines", async () => {
      const jsonl = chain([
        { type: "user", message: { role: "user", content: "go" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            content: [
              { type: "text", text: "**Done.**\n\nWant me to `push`?" },
            ],
          },
        },
      ]);
      await writeFile(join(sessionDir, "la2.jsonl"), `${jsonl}\n`);

      const summary = await reader.getSessionSummary("la2", projectId);
      expect(summary?.lastAgentText).toBe("Done.\nWant me to push?");
    });

    it("falls back to an earlier text turn when the latest is tool-only", async () => {
      const jsonl = chain([
        { type: "user", message: { role: "user", content: "go" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            content: [{ type: "text", text: "earlier reply" }],
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          },
        },
      ]);
      await writeFile(join(sessionDir, "la3.jsonl"), `${jsonl}\n`);

      const summary = await reader.getSessionSummary("la3", projectId);
      expect(summary?.lastAgentText).toBe("earlier reply");
    });

    it("labels the trailing tool when there is no agent prose at all", async () => {
      const jsonl = chain([
        { type: "user", message: { role: "user", content: "go" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          },
        },
      ]);
      await writeFile(join(sessionDir, "la4.jsonl"), `${jsonl}\n`);

      const summary = await reader.getSessionSummary("la4", projectId);
      expect(summary?.lastAgentText).toBe("⚙ Bash");
    });

    it("getLastAgentExcerpt reverse-scans to the same last-lines result", async () => {
      const jsonl = chain([
        { type: "user", message: { role: "user", content: "go" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            content: [{ type: "text", text: "first\nsecond\nthird\nfourth" }],
          },
        },
      ]);
      await writeFile(join(sessionDir, "la5.jsonl"), `${jsonl}\n`);

      expect(await reader.getLastAgentExcerpt("la5")).toBe(
        "second\nthird\nfourth",
      );
    });

    it("getLastAgentExcerpt falls back to a tool label", async () => {
      const jsonl = chain([
        { type: "user", message: { role: "user", content: "go" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          },
        },
      ]);
      await writeFile(join(sessionDir, "la6.jsonl"), `${jsonl}\n`);

      expect(await reader.getLastAgentExcerpt("la6")).toBe("⚙ Bash");
    });
  });
});
