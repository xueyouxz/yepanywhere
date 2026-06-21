import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSession } from "../../src/sessions/normalization.js";

const projectId = "test-project" as UrlProjectId;

/**
 * Build a fake `spawn` that writes the given stdout to the file fd the reader
 * passes in `options.stdio[1]`, then emits `close`. This mirrors the real
 * file-fd capture path (opencode is a Bun binary whose large piped stdout is
 * truncated on exit, so the reader redirects child stdout to a real file).
 */
function makeSpawnMock(resolveStdout: (args: string[]) => string | null) {
  return vi.fn(
    (
      _file: string,
      args: string[],
      options: { stdio?: unknown[] } | undefined,
    ) => {
      const child = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
      };
      child.kill = vi.fn();
      const fd = options?.stdio?.[1];
      const stdout = resolveStdout(args);
      queueMicrotask(() => {
        if (stdout !== null && typeof fd === "number") {
          try {
            writeSync(fd, stdout);
          } catch {
            // fall through to non-zero exit below if the fd is gone
          }
          child.emit("close", 0);
        } else {
          child.emit("close", 1);
        }
      });
      return child as unknown as ChildProcess;
    },
  );
}

describe("OpenCodeSessionReader", () => {
  let testDir: string;
  let projectPath: string;
  let databasePath: string;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `opencode-reader-test-${randomUUID()}`);
    projectPath = join(testDir, "project");
    databasePath = join(testDir, "opencode.db");
    await mkdir(projectPath, { recursive: true });
    await writeFile(databasePath, "sqlite placeholder");

    spawnMock = makeSpawnMock((args) => {
      if (args[0] === "export") {
        // Real opencode prints "Exporting session:" to stderr; the reader only
        // captures stdout, so write JSON only here.
        return JSON.stringify(makeExport(args[1] ?? "ses_cli", projectPath));
      }
      if (args.join(" ") === "session list --format json --max-count 200") {
        return JSON.stringify([
          {
            id: "ses_cli",
            title: "Yep Anywhere Session",
            directory: projectPath,
            created: 1000,
            updated: 4000,
          },
        ]);
      }
      return null;
    });

    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: spawnMock,
      };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(testDir, { recursive: true, force: true });
  });

  it("loads OpenCode 1.15 CLI exports when file storage is absent", async () => {
    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const reader = new OpenCodeSessionReader({
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });

    const loaded = await reader.getSession("ses_cli", projectId);
    expect(loaded?.summary).toMatchObject({
      id: "ses_cli",
      provider: "opencode",
      model: "Qwen/Qwen3.6-27B",
      fullTitle: "present?",
      messageCount: 2,
    });

    const normalized = normalizeSession(loaded!);
    expect(normalized.messages).toHaveLength(2);
    expect(normalized.messages[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "present?" }] },
    });
    expect(normalized.messages[1]).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Present." }],
      },
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/fake/opencode",
      ["export", "ses_cli"],
      expect.objectContaining({ cwd: projectPath }),
    );
  });

  it("reads a large export in full (no pipe truncation / buffer cap)", async () => {
    // Guards the file-fd capture: a >256KB export must come back whole. A pipe
    // capture (old execFile path) truncated opencode's Bun stdout mid-string.
    const bigText = "x".repeat(600_000);
    spawnMock = makeSpawnMock((args) => {
      if (args[0] !== "export") return null;
      const exported = makeExport(args[1] ?? "ses_cli", projectPath);
      exported.messages[1].parts[0].text = bigText;
      return JSON.stringify(exported);
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn: spawnMock };
    });
    vi.resetModules();

    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const reader = new OpenCodeSessionReader({
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });

    const loaded = await reader.getSession("ses_cli", projectId);
    const normalized = normalizeSession(loaded!);
    expect(normalized.messages).toHaveLength(2);
    expect(normalized.messages[1]).toMatchObject({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: bigText }] },
    });
  });

  it("enumerates CLI sessions with the OpenCode database as index anchor", async () => {
    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const reader = new OpenCodeSessionReader({
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });

    await expect(reader.listSessionFiles("/unused")).resolves.toEqual([
      { sessionId: "ses_cli", filePath: databasePath },
    ]);
  });

  it("does not load an exported session from a different project", async () => {
    spawnMock = makeSpawnMock((args) =>
      JSON.stringify(makeExport(args[1] ?? "ses_cli", join(testDir, "other"))),
    );
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn: spawnMock };
    });
    vi.resetModules();

    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const reader = new OpenCodeSessionReader({
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });

    await expect(reader.getSession("ses_cli", projectId)).resolves.toBeNull();
  });
});

function makeExport(sessionId: string, directory: string) {
  return {
    info: {
      id: sessionId,
      directory,
      title: "Yep Anywhere Session",
      model: {
        id: "Qwen/Qwen3.6-27B",
        providerID: "local-glm",
        variant: "default",
      },
      time: {
        created: 1000,
        updated: 4000,
      },
    },
    messages: [
      {
        info: {
          id: "msg_user",
          sessionID: sessionId,
          role: "user",
          time: { created: 1000 },
        },
        parts: [
          {
            id: "part_user",
            sessionID: sessionId,
            messageID: "msg_user",
            type: "text",
            text: "present?",
          },
        ],
      },
      {
        info: {
          id: "msg_assistant",
          sessionID: sessionId,
          role: "assistant",
          modelID: "Qwen/Qwen3.6-27B",
          time: { created: 2000, completed: 4000 },
          tokens: {
            input: 128,
            output: 12,
            cache: { read: 32 },
          },
        },
        parts: [
          {
            id: "part_assistant",
            sessionID: sessionId,
            messageID: "msg_assistant",
            type: "text",
            text: "Present.",
          },
        ],
      },
    ],
  };
}
