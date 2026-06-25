import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";

const PROJECT_PATH = "/test/project";

function line(type: string, payload: unknown, timestamp: string): string {
  return JSON.stringify({ type, timestamp, payload });
}

function sessionMeta(
  id: string,
  timestamp: string,
  extra: Record<string, unknown> = {},
): string {
  return line(
    "session_meta",
    {
      id,
      cwd: PROJECT_PATH,
      timestamp,
      model_provider: "openai",
      ...extra,
    },
    timestamp,
  );
}

async function writeRollout(
  sessionsDir: string,
  id: string,
  lines: string[],
): Promise<void> {
  const dateDir = join(sessionsDir, "2026", "06", "25");
  await mkdir(dateDir, { recursive: true });
  await writeFile(
    join(dateDir, `rollout-${id}.jsonl`),
    `${lines.join("\n")}\n`,
  );
}

describe("Codex subagent sessions", () => {
  let sessionsDir: string;

  beforeEach(async () => {
    sessionsDir = join(tmpdir(), `codex-subagents-${randomUUID()}`);
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it("maps spawn_agent calls to child rollout sessions", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "parent-thread";
    const childId = "child-thread";
    const callId = "call-spawn-1";

    await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      line(
        "response_item",
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use a subagent" }],
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: callId,
          arguments: JSON.stringify({
            role: "reviewer",
            prompt: "Inspect the implementation",
          }),
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ agent_id: childId, nickname: "Parfit" }),
        },
        now,
      ),
    ]);

    await writeRollout(sessionsDir, childId, [
      sessionMeta(childId, now, {
        parent_thread_id: parentId,
        session_id: parentId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
              agent_role: "reviewer",
            },
          },
        },
        agent_nickname: "Parfit",
        agent_role: "reviewer",
        multi_agent_version: "v2",
      }),
      line(
        "event_msg",
        {
          type: "task_started",
          turn_id: "turn-child",
          model_context_window: 200000,
          collaboration_mode_kind: "subagent",
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Child result" }],
        },
        now,
      ),
      line(
        "event_msg",
        {
          type: "task_complete",
          turn_id: "turn-child",
          last_agent_message: "Child result",
        },
        now,
      ),
    ]);

    const projectId = encodeProjectId(PROJECT_PATH) as UrlProjectId;
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });

    const summaries = await reader.listSessions(projectId);
    expect(summaries.map((summary) => summary.id)).toEqual([parentId]);

    await expect(reader.getAgentMappings()).resolves.toEqual([
      { toolUseId: callId, agentId: childId },
    ]);

    const agentSession = await reader.getAgentSession(childId);
    expect(agentSession?.status).toBe("completed");
    expect(agentSession?.messages).toHaveLength(1);
    expect(agentSession?.messages[0]).toMatchObject({
      type: "assistant",
      isSubagent: true,
    });
    expect(agentSession?.messages[0]?.message?.content).toEqual([
      { type: "text", text: "Child result" },
    ]);
  });

  it("does not expose child rollouts as standalone Codex projects", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "project-parent-thread";
    const childId = "project-child-thread";

    await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      line(
        "response_item",
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Parent session" }],
        },
        now,
      ),
    ]);
    await writeRollout(sessionsDir, childId, [
      sessionMeta(childId, now, {
        parent_thread_id: parentId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
            },
          },
        },
      }),
      line(
        "response_item",
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Child session" }],
        },
        now,
      ),
    ]);

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      path: PROJECT_PATH,
      sessionCount: 1,
    });
  });
});
