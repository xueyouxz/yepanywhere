import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MockClaudeSDK } from "../src/sdk/mock.js";
import { encodeProjectId } from "../src/supervisor/types.js";

/**
 * Tests for incremental session loading via afterMessageId parameter.
 *
 * This allows clients to fetch only new messages instead of the entire session,
 * which is more efficient for live-updating external sessions.
 */
describe("Incremental Session Loading", () => {
  let mockSdk: MockClaudeSDK;
  let testDir: string;
  let projectDir: string;
  let projectId: string;
  const projectPath = "/home/user/testproject";

  beforeEach(async () => {
    mockSdk = new MockClaudeSDK();
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    const encodedPath = projectPath.replaceAll("/", "-");
    projectDir = join(testDir, "localhost", encodedPath);
    projectId = encodeProjectId(projectPath);
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("afterMessageId parameter", () => {
    it("returns all messages when afterMessageId is not provided", async () => {
      const msg1Id = randomUUID();
      const msg2Id = randomUUID();
      const msg3Id = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: msg1Id,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "First" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: msg2Id,
            parentUuid: msg1Id,
            message: { content: "Second" },
          }),
          JSON.stringify({
            type: "user",
            uuid: msg3Id,
            parentUuid: msg2Id,
            message: { content: "Third" },
          }),
        ].join("\n")}\n`,
      );

      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.messages).toHaveLength(3);
    });

    it("returns only messages after the specified ID", async () => {
      const msg1Id = randomUUID();
      const msg2Id = randomUUID();
      const msg3Id = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: msg1Id,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "First" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: msg2Id,
            parentUuid: msg1Id,
            message: { content: "Second" },
          }),
          JSON.stringify({
            type: "user",
            uuid: msg3Id,
            parentUuid: msg2Id,
            message: { content: "Third" },
          }),
        ].join("\n")}\n`,
      );

      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?afterMessageId=${msg1Id}`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.messages).toHaveLength(2);
      expect(json.messages[0].uuid).toBe(msg2Id);
      expect(json.messages[1].uuid).toBe(msg3Id);
    });

    it("returns empty array when afterMessageId is the last message", async () => {
      const msg1Id = randomUUID();
      const msg2Id = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: msg1Id,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "First" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: msg2Id,
            parentUuid: msg1Id,
            message: { content: "Second" },
          }),
        ].join("\n")}\n`,
      );

      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?afterMessageId=${msg2Id}`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.messages).toHaveLength(0);
    });

    it("returns all messages when afterMessageId is not found", async () => {
      const msg1Id = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${JSON.stringify({
          type: "user",
          uuid: msg1Id,
          parentUuid: null,
          cwd: projectPath,
          message: { content: "First" },
        })}\n`,
      );

      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?afterMessageId=nonexistent`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      // Falls back to all messages when ID not found
      expect(json.messages).toHaveLength(1);
    });

    it("works correctly with internal message types interspersed", async () => {
      const msg1Id = randomUUID();
      const msg2Id = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
          JSON.stringify({
            type: "user",
            uuid: msg1Id,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "First" },
          }),
          JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
          JSON.stringify({
            type: "assistant",
            uuid: msg2Id,
            parentUuid: msg1Id,
            message: { content: "Second" },
          }),
        ].join("\n")}\n`,
      );

      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?afterMessageId=${msg1Id}`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      // Internal types (queue-operation, file-history-snapshot) are filtered out
      // Only returns the assistant message after msg1Id
      expect(json.messages).toHaveLength(1);
      expect(json.messages[0].uuid).toBe(msg2Id);
      expect(json.messages[0].type).toBe("assistant");
    });
  });

  describe("Edit input augmentation", () => {
    it("augments Codex-style apply_patch string input with structured patch data", async () => {
      const userId = randomUUID();
      const assistantId = randomUUID();
      const resultId = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: userId,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "Apply patch" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: assistantId,
            parentUuid: userId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-apply-patch",
                  name: "Edit",
                  input: [
                    "*** Begin Patch",
                    "*** Update File: src/example.ts",
                    "@@",
                    "-const x = 1;",
                    "+const x = 2;",
                    "*** End Patch",
                    "",
                  ].join("\n"),
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            uuid: resultId,
            parentUuid: assistantId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-apply-patch",
                  content: "ok",
                },
              ],
            },
            toolUseResult: { ok: true },
          }),
        ].join("\n")}\n`,
      );

      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      const assistantMessage = json.messages.find(
        (message: Record<string, unknown>) => message.type === "assistant",
      ) as Record<string, unknown> | undefined;
      const content = assistantMessage?.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      const toolUse = content?.content?.find(
        (block) => block.type === "tool_use" && block.name === "Edit",
      );
      const input = toolUse?.input as
        | {
            _rawPatch?: string;
            _structuredPatch?: unknown[];
            _diffHtml?: string;
          }
        | undefined;

      expect(input?._rawPatch).toContain("*** Begin Patch");
      expect(input?._structuredPatch?.length).toBeGreaterThan(0);
      expect(input?._diffHtml).toContain('class="line line-inserted"');
    });

    it("keeps Edit previews available on public share session reads", async () => {
      const userId = randomUUID();
      const assistantId = randomUUID();
      const resultId = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: userId,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "Apply patch" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: assistantId,
            parentUuid: userId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-apply-patch-public",
                  name: "Edit",
                  input: [
                    "*** Begin Patch",
                    "*** Update File: src/example.ts",
                    "@@",
                    "-const x = 1;",
                    "+const x = 2;",
                    "*** End Patch",
                    "",
                  ].join("\n"),
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            uuid: resultId,
            parentUuid: assistantId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-apply-patch-public",
                  content: "ok",
                },
              ],
            },
            toolUseResult: { ok: true },
          }),
        ].join("\n")}\n`,
      );

      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?publicShare=1`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      const assistantMessage = json.messages.find(
        (message: Record<string, unknown>) => message.type === "assistant",
      ) as Record<string, unknown> | undefined;
      const content = assistantMessage?.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      const toolUse = content?.content?.find(
        (block) => block.type === "tool_use" && block.name === "Edit",
      );
      const input = toolUse?.input as
        | {
            _rawPatch?: string;
            _structuredPatch?: unknown[];
            _diffHtml?: string;
          }
        | undefined;

      expect(input?._rawPatch).toContain("*** Begin Patch");
      expect(input?._structuredPatch?.length).toBeGreaterThan(0);
      expect(input?._diffHtml).toContain('class="line line-inserted"');
    });

    it("keeps raw patch fallback when parsing malformed patch text", async () => {
      const userId = randomUUID();
      const assistantId = randomUUID();
      const resultId = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: userId,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "Apply malformed patch" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: assistantId,
            parentUuid: userId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-malformed-patch",
                  name: "Edit",
                  input: "*** Begin Patch\nnot-a-valid-hunk\n*** End Patch\n",
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            uuid: resultId,
            parentUuid: assistantId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-malformed-patch",
                  content: "ok",
                },
              ],
            },
            toolUseResult: { ok: true },
          }),
        ].join("\n")}\n`,
      );

      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      const assistantMessage = json.messages.find(
        (message: Record<string, unknown>) => message.type === "assistant",
      ) as Record<string, unknown> | undefined;
      const content = assistantMessage?.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      const toolUse = content?.content?.find(
        (block) => block.type === "tool_use" && block.name === "Edit",
      );
      const input = toolUse?.input as
        | {
            _rawPatch?: string;
            _structuredPatch?: unknown[];
            _diffHtml?: string;
          }
        | undefined;

      expect(input?._rawPatch).toContain("*** Begin Patch");
      expect(input?._structuredPatch).toBeUndefined();
      expect(input?._diffHtml).toBeUndefined();
    });
  });
});
