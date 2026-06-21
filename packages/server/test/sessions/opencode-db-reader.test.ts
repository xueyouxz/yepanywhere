import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSession } from "../../src/sessions/normalization.js";

const projectId = "test-project" as UrlProjectId;
const PROJECT_HASH = "8e8fabade65fcb7be147f1c1f44eeb5f36a09680";

// node:sqlite postdates vite's builtin list, so vitest's module runner can't
// transform an `import` of it; require it natively (the reader does the same).
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

interface MessageSpec {
  id: string;
  data: Record<string, unknown>;
  parts: { id: string; data: Record<string, unknown> }[];
}

/**
 * Build a real OpenCode 1.16+ `opencode.db` fixture with the same shape the
 * reader queries: project -> session -> message -> part, where the JSON `data`
 * blobs omit id/sessionID/messageID (those live only as columns, as in the
 * real store). Mirrors the SQLite schema in topics/opencode-backend.md.
 */
function buildDb(
  dbPath: string,
  opts: {
    worktree: string;
    sessionId: string;
    title: string;
    model: Record<string, unknown>;
    messages: MessageSpec[];
    omitTranscriptTables?: boolean;
  },
): void {
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER, time_updated INTEGER)",
  );
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)",
  );
  db.prepare(
    "INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)",
  ).run(PROJECT_HASH, opts.worktree, 1000, 5000);
  db.prepare(
    "INSERT INTO session (id, project_id, title, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(opts.sessionId, PROJECT_HASH, opts.title, JSON.stringify(opts.model), 1000, 5000);

  if (!opts.omitTranscriptTables) {
    db.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)",
    );
    db.exec(
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)",
    );
    const insM = db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    const insP = db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let t = 1000;
    for (const m of opts.messages) {
      insM.run(m.id, opts.sessionId, t, t, JSON.stringify(m.data));
      for (const p of m.parts) {
        insP.run(p.id, m.id, opts.sessionId, t, t, JSON.stringify(p.data));
        t += 1;
      }
      t += 1;
    }
  }
  db.close();
}

const richMessages: MessageSpec[] = [
  {
    id: "msg_001",
    data: { role: "user", time: { created: 1000 } },
    parts: [{ id: "prt_001a", data: { type: "text", text: "hello from db" } }],
  },
  {
    id: "msg_002",
    data: {
      role: "assistant",
      modelID: "claude-opus-4.8",
      providerID: "github-copilot",
      time: { created: 2000, completed: 3000 },
      tokens: { input: 100, output: 20, cache: { read: 50 } },
    },
    parts: [
      // empty timing-only reasoning — must be skipped by the normalizer
      { id: "prt_002a", data: { type: "reasoning", text: "" } },
      { id: "prt_002b", data: { type: "reasoning", text: "thinking aloud" } },
      {
        id: "prt_002c",
        data: {
          type: "tool",
          tool: "bash",
          callID: "call_1",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "file.txt\n",
          },
        },
      },
      { id: "prt_002d", data: { type: "text", text: "final answer" } },
    ],
  },
];

describe("OpenCodeSessionReader (direct SQLite db reader)", () => {
  let testDir: string;
  let projectPath: string;
  let databasePath: string;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `opencode-db-test-${randomUUID()}`);
    projectPath = join(testDir, "project");
    databasePath = join(testDir, "opencode.db");
    await mkdir(projectPath, { recursive: true });

    // A spawn that immediately exits non-zero (no export output). The DB-backed
    // tests assert this is never reached; the fallthrough tests rely on it
    // returning null fast (no hang) so getSession resolves to null.
    spawnMock = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
      };
      child.kill = vi.fn();
      queueMicrotask(() => child.emit("close", 1));
      return child as unknown as ChildProcess;
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn: spawnMock };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(testDir, { recursive: true, force: true });
  });

  async function makeReader() {
    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    return new OpenCodeSessionReader({
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });
  }

  it("renders a TUI-owned session from the DB with no subprocess", async () => {
    buildDb(databasePath, {
      worktree: projectPath,
      sessionId: "ses_db",
      title: "Yep Anywhere Session",
      model: { id: "claude-opus-4.8", providerID: "github-copilot", variant: "high" },
      messages: richMessages,
    });

    const reader = await makeReader();
    const loaded = await reader.getSession("ses_db", projectId);

    // Acceptance: no `opencode` child process is spawned for a 1.16+ session.
    expect(spawnMock).not.toHaveBeenCalled();

    expect(loaded?.summary).toMatchObject({
      id: "ses_db",
      provider: "opencode",
      // provider prefix preserved (provider rejects a bare modelID next turn)
      model: "github-copilot/claude-opus-4.8",
      // title falls back to first user text when the stored title is the default
      fullTitle: "hello from db",
      messageCount: 2,
    });
    // context fill = input + cache.read of the last assistant message
    expect(loaded?.summary.contextUsage).toMatchObject({ inputTokens: 150 });

    const normalized = normalizeSession(loaded!);
    expect(normalized.messages).toHaveLength(2);
    expect(normalized.messages[0]).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello from db" }],
      },
    });

    // empty reasoning dropped; tool emits use+result; tool name normalized.
    // toMatchObject on an array checks length + each element, so a stray block
    // (e.g. the skipped empty reasoning) would fail here.
    expect(normalized.messages[1].message?.content).toMatchObject([
      { type: "thinking", thinking: "thinking aloud" },
      { type: "tool_use", name: "Bash" },
      { type: "tool_result", content: "file.txt\n" },
      { type: "text", text: "final answer" },
    ]);
  });

  it("pages with afterMessageId but keeps a full-session summary", async () => {
    buildDb(databasePath, {
      worktree: projectPath,
      sessionId: "ses_db",
      title: "Yep Anywhere Session",
      model: { id: "claude-opus-4.8", providerID: "github-copilot", variant: "high" },
      messages: richMessages,
    });

    const reader = await makeReader();
    const loaded = await reader.getSession("ses_db", projectId, "msg_001");
    expect(spawnMock).not.toHaveBeenCalled();

    const normalized = normalizeSession(loaded!);
    expect(normalized.messages).toHaveLength(1);
    expect(normalized.messages[0].type).toBe("assistant");
    // summary still describes the whole session, not just the page
    expect(loaded?.summary.messageCount).toBe(2);
  });

  it("reads a large transcript intact (no truncation)", async () => {
    const bigText = "x".repeat(600_000);
    buildDb(databasePath, {
      worktree: projectPath,
      sessionId: "ses_big",
      title: "Big",
      model: { id: "claude-opus-4.8", providerID: "github-copilot" },
      messages: [
        {
          id: "msg_001",
          data: { role: "user", time: { created: 1000 } },
          parts: [{ id: "prt_001a", data: { type: "text", text: "go" } }],
        },
        {
          id: "msg_002",
          data: { role: "assistant", time: { created: 2000 } },
          parts: [{ id: "prt_002a", data: { type: "text", text: bigText } }],
        },
      ],
    });

    const reader = await makeReader();
    const loaded = await reader.getSession("ses_big", projectId);
    expect(spawnMock).not.toHaveBeenCalled();

    const normalized = normalizeSession(loaded!);
    expect(normalized.messages[1]).toMatchObject({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: bigText }] },
    });
  });

  it("enumerates DB sessions with the db file as the index anchor", async () => {
    buildDb(databasePath, {
      worktree: projectPath,
      sessionId: "ses_db",
      title: "Yep Anywhere Session",
      model: { id: "claude-opus-4.8", providerID: "github-copilot" },
      messages: richMessages,
    });

    const reader = await makeReader();
    await expect(reader.listSessionFiles("/unused")).resolves.toEqual([
      { sessionId: "ses_db", filePath: databasePath },
    ]);

    const summaries = await reader.listSessions(projectId);
    expect(summaries.map((s) => s.id)).toEqual(["ses_db"]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("falls through when the session is not in the DB project", async () => {
    buildDb(databasePath, {
      worktree: projectPath,
      sessionId: "ses_db",
      title: "Yep Anywhere Session",
      model: { id: "claude-opus-4.8", providerID: "github-copilot" },
      messages: richMessages,
    });

    const reader = await makeReader();
    // Unknown session id: DB returns null, file tree is absent, export yields
    // nothing (spawn exits non-zero) — overall null.
    await expect(reader.getSession("ses_absent", projectId)).resolves.toBeNull();
    expect(spawnMock).toHaveBeenCalled();
  });

  it("degrades gracefully on a pre-1.16 schema (no message/part tables)", async () => {
    buildDb(databasePath, {
      worktree: projectPath,
      sessionId: "ses_db",
      title: "Yep Anywhere Session",
      model: { id: "claude-opus-4.8", providerID: "github-copilot" },
      messages: [],
      omitTranscriptTables: true,
    });

    const reader = await makeReader();
    // getSessionRow's message-count query hits a missing table -> reader returns
    // null and the call falls through (export yields nothing here).
    await expect(reader.getSession("ses_db", projectId)).resolves.toBeNull();
  });
});
