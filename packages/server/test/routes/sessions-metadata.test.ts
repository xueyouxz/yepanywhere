import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId, type UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { GrokSessionReader } from "../../src/sessions/grok-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.claude-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Codex metadata title",
    fullTitle: "Codex metadata title",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 2,
    ownership: { owner: "none" },
    provider: "codex",
    model: "gpt-5-codex",
  };
}

async function createGrokRedirectFixture(): Promise<{
  tempDir: string;
  wrongProject: Project;
  rightProject: Project;
  rightProjectId: UrlProjectId;
  sessionId: string;
  grokSessionsDir: string;
  sessionDir: string;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "ya-grok-redirect-"));
  const wrongProjectPath = join(tempDir, "wrong");
  const rightProjectPath = join(tempDir, "right");
  const sessionId = "grok-native-id";
  const grokSessionsDir = join(tempDir, "grok-sessions");
  const sessionDir = join(
    grokSessionsDir,
    encodeURIComponent(rightProjectPath),
    sessionId,
  );
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "summary.json"),
    JSON.stringify({
      info: { id: sessionId, cwd: rightProjectPath },
      created_at: "2026-05-28T17:00:00.000Z",
      updated_at: "2026-05-28T17:01:00.000Z",
      generated_title: "Right Grok",
      session_summary: "Right Grok",
      num_messages: 1,
      current_model_id: "grok-build",
    }),
  );

  return {
    tempDir,
    wrongProject: {
      ...createProject(),
      id: toUrlProjectId(wrongProjectPath),
      path: wrongProjectPath,
      name: "wrong",
      sessionDir: join(wrongProjectPath, ".claude-sessions"),
    },
    rightProject: {
      ...createProject(),
      id: toUrlProjectId(rightProjectPath),
      path: rightProjectPath,
      name: "right",
      sessionDir: join(rightProjectPath, ".claude-sessions"),
    },
    rightProjectId: toUrlProjectId(rightProjectPath),
    sessionId,
    grokSessionsDir,
    sessionDir,
  };
}

describe("Sessions metadata route", () => {
  it("returns queue summaries after accepting a deferred message", async () => {
    const deferMessage = vi.fn(() => ({ success: true, deferred: true }));
    const primeSupportedCommandsForMessage = vi.fn(async () => {});
    const setPermissionMode = vi.fn();
    const getDeferredQueueSummary = vi.fn(() => [
      {
        tempId: "temp-queued",
        content: "queued text",
        timestamp: "2026-04-25T00:00:00.000Z",
      },
    ]);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          isTerminated: false,
          setPermissionMode,
          primeSupportedCommandsForMessage,
          deferMessage,
          getDeferredQueueSummary,
        })),
      } as unknown as SessionsDeps["supervisor"],
    });

    const response = await routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "queued text",
        tempId: "temp-queued",
        mode: "default",
        deferred: true,
        clientTimestamp: 1770000000123,
        messageMetadata: {
          deliveryIntent: "patient",
          composition: {
            typingStartedAt: "2026-04-25T00:00:10.000Z",
            typingEndedAt: "2026-04-25T00:00:20.000Z",
            lastEditedAt: "2026-04-25T00:00:19.000Z",
            submittedAt: "2026-04-25T00:00:20.000Z",
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(primeSupportedCommandsForMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "queued text",
        tempId: "temp-queued",
      }),
    );
    expect(deferMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "queued text",
        tempId: "temp-queued",
        mode: "default",
        metadata: expect.objectContaining({
          deliveryIntent: "patient",
          clientTimestamp: 1770000000123,
          serverReceivedAt: expect.any(String),
          composition: {
            typingStartedAt: "2026-04-25T00:00:10.000Z",
            typingEndedAt: "2026-04-25T00:00:20.000Z",
            lastEditedAt: "2026-04-25T00:00:19.000Z",
            submittedAt: "2026-04-25T00:00:20.000Z",
          },
        }),
      }),
      { promoteIfReady: true, placement: undefined },
    );
    expect(setPermissionMode).toHaveBeenCalledWith("default");
    await expect(response.json()).resolves.toMatchObject({
      queued: true,
      deferred: true,
      deferredMessages: [
        {
          tempId: "temp-queued",
          content: "queued text",
        },
      ],
    });
  });

  it("reports immediate promotion when returned by the process", async () => {
    const primeSupportedCommandsForMessage = vi.fn(async () => {});
    const deferMessage = vi.fn(() => ({
      success: true,
      deferred: false,
      promoted: true,
      position: 0,
    }));
    const getDeferredQueueSummary = vi.fn(() => []);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          isTerminated: false,
          primeSupportedCommandsForMessage,
          deferMessage,
          getDeferredQueueSummary,
        })),
      } as unknown as SessionsDeps["supervisor"],
    });

    const response = await routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "steer this",
        tempId: "temp-steered",
        deferred: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(primeSupportedCommandsForMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "steer this",
        tempId: "temp-steered",
      }),
    );
    expect(deferMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "steer this",
        tempId: "temp-steered",
      }),
      { promoteIfReady: true, placement: undefined },
    );
    await expect(response.json()).resolves.toMatchObject({
      queued: true,
      deferred: false,
      promoted: true,
      position: 0,
      deferredMessages: [],
    });
  });

  it("takes a deferred message for queued-message editing", async () => {
    const takeDeferredMessage = vi.fn(() => ({
      message: {
        text: "queued text",
        tempId: "temp-edit",
        mode: "acceptEdits",
        attachments: [
          {
            id: "file-1",
            originalName: "notes.txt",
            size: 12,
            mimeType: "text/plain",
            path: "/uploads/notes.txt",
          },
        ],
      },
      placement: {
        afterTempId: "temp-before",
        beforeTempId: "temp-after",
      },
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          takeDeferredMessage,
        })),
      } as unknown as SessionsDeps["supervisor"],
    });

    const response = await routes.request(
      "/sessions/sess-1/deferred/temp-edit/edit",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(takeDeferredMessage).toHaveBeenCalledWith("temp-edit");
    await expect(response.json()).resolves.toMatchObject({
      message: "queued text",
      tempId: "temp-edit",
      mode: "acceptEdits",
      placement: {
        afterTempId: "temp-before",
        beforeTempId: "temp-after",
      },
      attachments: [
        {
          id: "file-1",
          originalName: "notes.txt",
        },
      ],
    });
  });

  it("releases a queued-message edit barrier", async () => {
    const releaseDeferredEditBarrier = vi.fn(() => true);
    const getDeferredQueueSummary = vi.fn(() => [
      {
        tempId: "temp-3",
        content: "third",
        timestamp: "2026-04-25T00:00:02.000Z",
      },
    ]);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          releaseDeferredEditBarrier,
          getDeferredQueueSummary,
        })),
      } as unknown as SessionsDeps["supervisor"],
    });

    const response = await routes.request(
      "/sessions/sess-1/deferred/temp-edit/edit/release",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(releaseDeferredEditBarrier).toHaveBeenCalledWith("temp-edit");
    await expect(response.json()).resolves.toMatchObject({
      released: true,
      deferredMessages: [{ tempId: "temp-3", content: "third" }],
    });
  });

  it("passes deferred queue reinsertion anchors when queuing an edited message", async () => {
    const primeSupportedCommandsForMessage = vi.fn(async () => {});
    const deferMessage = vi.fn(() => ({ success: true, deferred: true }));
    const getDeferredQueueSummary = vi.fn(() => [
      {
        tempId: "temp-1",
        content: "first",
        timestamp: "2026-04-25T00:00:00.000Z",
      },
      {
        tempId: "temp-edited",
        content: "second edited",
        timestamp: "2026-04-25T00:00:01.000Z",
      },
      {
        tempId: "temp-3",
        content: "third",
        timestamp: "2026-04-25T00:00:02.000Z",
      },
    ]);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          isTerminated: false,
          primeSupportedCommandsForMessage,
          deferMessage,
          getDeferredQueueSummary,
        })),
      } as unknown as SessionsDeps["supervisor"],
    });

    const response = await routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "second edited",
        tempId: "temp-edited",
        deferred: true,
        insertAfterTempId: "temp-1",
        insertBeforeTempId: "temp-3",
        replaceDeferredTempId: "temp-2",
      }),
    });

    expect(response.status).toBe(200);
    expect(primeSupportedCommandsForMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "second edited",
        tempId: "temp-edited",
      }),
    );
    expect(deferMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "second edited",
        tempId: "temp-edited",
      }),
      {
        promoteIfReady: true,
        placement: {
          afterTempId: "temp-1",
          beforeTempId: "temp-3",
          replaceTempId: "temp-2",
        },
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      queued: true,
      deferredMessages: [
        { tempId: "temp-1" },
        { tempId: "temp-edited" },
        { tempId: "temp-3" },
      ],
    });
  });

  it("resolves metadata across providers for mixed-provider projects", async () => {
    const project = createProject();
    const summary = createSummary();
    const claudeReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as ISessionReader;

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => claudeReader),
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/metadata`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.session).toMatchObject({
      id: "sess-1",
      title: "Codex metadata title",
      provider: "codex",
      model: "gpt-5-codex",
    });
    expect(vi.mocked(claudeReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      project.id,
    );
    expect(vi.mocked(codexReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      project.id,
    );
  });

  it("loads Grok detail by native id after process loss", async () => {
    const project = createProject();
    const grokSummary: SessionSummary = {
      ...createSummary(),
      id: "grok-native-id",
      provider: "grok",
      model: "grok-build",
      title: "Grok title",
      fullTitle: "Grok title",
    };
    const primaryReader = {
      getSession: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const grokReader = {
      getSession: vi.fn(async () => ({
        summary: grokSummary,
        data: {
          provider: "grok",
          session: { messages: [] },
        },
      })),
    } as unknown as GrokSessionReader;

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        wasEverOwned: vi.fn(() => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => primaryReader),
      grokSessionsDir: "/tmp/grok-sessions",
      grokReaderFactory: vi.fn(() => grokReader),
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/grok-native-id`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.session).toMatchObject({
      id: "grok-native-id",
      title: "Grok title",
      provider: "grok",
      model: "grok-build",
    });
    expect(vi.mocked(primaryReader.getSession)).toHaveBeenCalledWith(
      "grok-native-id",
      project.id,
      undefined,
      { includeOrphans: true },
    );
    expect(vi.mocked(grokReader.getSession)).toHaveBeenCalledWith(
      "grok-native-id",
      project.id,
      undefined,
      { includeOrphans: true },
    );
  });

  it("replays Grok updates.jsonl into renderable messages", async () => {
    const fixture = await createGrokRedirectFixture();
    try {
      const bytes = (value: string) => Array.from(Buffer.from(value, "utf-8"));
      const readPath = join(fixture.rightProject.path, "README.md");
      const updates = [
        {
          timestamp: 1779988150,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "inspect this" },
            },
          },
        },
        {
          timestamp: 1779988151,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "checking files" },
            },
          },
        },
        {
          timestamp: 1779988152,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call-grep",
              title: "grep",
              rawInput: {
                pattern: "needle",
                path: "src",
                output_mode: "files_with_matches",
                head_limit: 2,
              },
            },
          },
        },
        {
          timestamp: 1779988153,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-grep",
              status: "completed",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: "found 1 match" },
                },
              ],
              rawOutput: {
                type: "GrepSearch",
                stdout: bytes(
                  `<workspace_result workspace_path="${fixture.rightProject.path}">\nFound 1 files\n${fixture.rightProject.path}/src/file.ts\n</workspace_result>`,
                ),
                stderr: [],
                exit_code: 0,
                match_count: 1,
                file_matches: [],
              },
            },
          },
        },
        {
          timestamp: 1779988154,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call-read",
              title: "read_file",
              rawInput: { target_file: "README.md" },
            },
          },
        },
        {
          timestamp: 1779988155,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-read",
              status: "completed",
              locations: [{ path: "README.md", line: 1 }],
              rawOutput: {
                type: "ReadFile",
                FileContent: {
                  content: "hello\n",
                  absolute_path: readPath,
                  total_lines: 1,
                },
              },
            },
          },
        },
        {
          timestamp: 1779988156,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "done" },
            },
          },
        },
      ];
      await writeFile(
        join(fixture.sessionDir, "updates.jsonl"),
        `${updates.map((update) => JSON.stringify(update)).join("\n")}\n`,
      );

      const primaryReader = {
        getSession: vi.fn(async () => null),
      } as unknown as ISessionReader;
      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => null),
          wasEverOwned: vi.fn(() => true),
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          getOrCreateProject: vi.fn(async () => fixture.rightProject),
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(() => primaryReader),
        grokSessionsDir: fixture.grokSessionsDir,
      });

      const response = await routes.request(
        `/projects/${fixture.rightProjectId}/sessions/${fixture.sessionId}`,
      );
      expect(response.status).toBe(200);

      const json = (await response.json()) as {
        session: { messageCount: number; provider?: string };
        messages: Array<{
          message?: { content?: unknown };
          toolUseResult?: unknown;
          type?: string;
        }>;
      };
      expect(json.session.provider).toBe("grok");
      expect(json.session.messageCount).toBe(7);

      const blocks = json.messages.flatMap((message) => {
        const content = message.message?.content;
        return Array.isArray(content)
          ? (content as Record<string, unknown>[])
          : [];
      });
      const toolUses = blocks.filter((block) => block.type === "tool_use");
      expect(toolUses).toHaveLength(2);
      expect(toolUses[0]).toMatchObject({
        id: "call-grep",
        name: "Grep",
        input: {
          pattern: "needle",
          path: "src",
          output_mode: "files_with_matches",
          rawInput: { pattern: "needle" },
        },
      });
      expect(toolUses[1]).toMatchObject({
        id: "call-read",
        name: "Read",
        input: {
          file_path: "README.md",
          locations: [{ path: "README.md", line: 1 }],
          rawInput: { target_file: "README.md" },
        },
      });

      const resultFor = (toolUseId: string) =>
        json.messages.find((message) => {
          const content = message.message?.content;
          const first = Array.isArray(content)
            ? (content[0] as Record<string, unknown> | undefined)
            : undefined;
          return (
            first?.type === "tool_result" && first.tool_use_id === toolUseId
          );
        })?.toolUseResult;
      expect(resultFor("call-grep")).toMatchObject({
        mode: "files_with_matches",
        filenames: [`${fixture.rightProject.path}/src/file.ts`],
        numFiles: 1,
      });
      expect(resultFor("call-read")).toMatchObject({
        type: "text",
        file: {
          filePath: readPath,
          content: "hello\n",
          totalLines: 1,
        },
      });
    } finally {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("redirects stale Grok detail links to the native cwd project", async () => {
    const fixture = await createGrokRedirectFixture();
    try {
      const primaryReader = {
        getSession: vi.fn(async () => null),
      } as unknown as ISessionReader;
      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => null),
          wasEverOwned: vi.fn(() => false),
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          getOrCreateProject: vi.fn(async () => fixture.wrongProject),
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(() => primaryReader),
        grokSessionsDir: fixture.grokSessionsDir,
      });

      const response = await routes.request(
        `/projects/${fixture.wrongProject.id}/sessions/${fixture.sessionId}?tailCompactions=2`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `/api/projects/${fixture.rightProjectId}/sessions/${fixture.sessionId}?tailCompactions=2`,
      );
    } finally {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("redirects stale Grok metadata links to the native cwd project", async () => {
    const fixture = await createGrokRedirectFixture();
    try {
      const primaryReader = {
        getSessionSummary: vi.fn(async () => null),
      } as unknown as ISessionReader;
      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => null),
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          getOrCreateProject: vi.fn(async () => fixture.wrongProject),
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(() => primaryReader),
        grokSessionsDir: fixture.grokSessionsDir,
      });

      const response = await routes.request(
        `/projects/${fixture.wrongProject.id}/sessions/${fixture.sessionId}/metadata`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `/api/projects/${fixture.rightProjectId}/sessions/${fixture.sessionId}/metadata`,
      );
    } finally {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("keeps persisted provider when metadata refresh misses the session summary", async () => {
    const project = createProject();

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-1",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date("2026-03-10T09:47:00.000Z") },
          provider: "claude",
          supportsDynamicCommands: false,
        })),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        getProvider: vi.fn(() => "codex"),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/metadata`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.session.provider).toBe("codex");
  });

  it("prefers persisted provider over conflicting client resume provider", async () => {
    const project = createProject();
    const resumeSession = vi.fn(async () => ({
      id: "proc-1",
      sessionId: "sess-1",
      permissionMode: "default",
      modeVersion: 0,
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "continue",
          provider: "claude",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({ providerName: "codex" }),
    );
  });

  it("preserves persisted provider and model when queueing a restartable message", async () => {
    const project = createProject();
    const queueMessageToSession = vi.fn(async () => ({
      success: true as const,
      restarted: true,
      process: { id: "proc-2" },
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          projectPath: project.path,
          isTerminated: false,
          provider: "claude",
          model: "gpt-5.4",
          resolvedModel: "gpt-5.4",
          executor: undefined,
        })),
        queueMessageToSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "continue",
        thinking: "max",
      }),
    });

    expect(response.status).toBe(200);
    expect(queueMessageToSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({
        model: "gpt-5.4",
        providerName: "codex",
      }),
    );
  });

  it("starts a fresh handoff session before aborting the old process", async () => {
    const project = createProject();
    let replacementListener:
      | ((event: { type: string; message?: unknown }) => void)
      | undefined;
    const startSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-new",
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.4",
      resolvedModel: "gpt-5.4",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn((listener) => {
        replacementListener = listener;
        return vi.fn();
      }),
    }));
    const abortProcess = vi.fn(async () => true);
    const interruptProcess = vi.fn(async () => ({
      success: true,
      supported: true,
    }));
    const updateMetadata = vi.fn(async () => undefined);
    const emit = vi.fn();

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "u1",
              timestamp: "2026-04-24T20:00:00.000Z",
              message: { role: "user", content: "please continue the bugfix" },
            },
          ]),
        })),
        startSession,
        interruptProcess,
        abortProcess,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({ customTitle: "Broken Codex session" })),
        setProvider: vi.fn(async () => undefined),
        updateMetadata,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      eventBus: { emit } as unknown as SessionsDeps["eventBus"],
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          model: "gpt-5.4",
          reason: "test restart",
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      sessionId: "sess-new",
      processId: "proc-new",
      title: "Handoff: Broken Codex session",
      restartedFrom: "sess-1",
      oldProcessId: "proc-old",
      oldProcessInterrupted: true,
      oldProcessAbortDeferred: true,
      oldProcessAborted: false,
    });
    expect(interruptProcess).toHaveBeenCalledWith("proc-old");
    expect(startSession).toHaveBeenCalledWith(
      project.path,
      expect.objectContaining({
        text: expect.stringContaining("# Handoff: Broken Codex session"),
      }),
      undefined,
      expect.objectContaining({
        model: "gpt-5.4",
        providerName: "codex",
      }),
    );
    const handoffText = startSession.mock.calls[0]?.[1].text;
    expect(handoffText).toContain("please continue the bugfix");
    expect(updateMetadata).toHaveBeenCalledWith("sess-new", {
      title: "Handoff: Broken Codex session",
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session-metadata-changed",
        sessionId: "sess-new",
        title: "Handoff: Broken Codex session",
      }),
    );
    expect(interruptProcess.mock.invocationCallOrder[0]).toBeLessThan(
      startSession.mock.invocationCallOrder[0] ?? 0,
    );
    expect(abortProcess).not.toHaveBeenCalled();

    replacementListener?.({
      type: "message",
      message: { type: "assistant", message: { content: "working" } },
    });
    await Promise.resolve();
    expect(abortProcess).toHaveBeenCalledWith("proc-old");
  });

  it("uses the requested provider only as the handoff target", async () => {
    const project = createProject();
    const summary: SessionSummary = {
      ...createSummary(),
      title: "Claude source session",
      fullTitle: "Claude source session",
      provider: "claude",
      model: "sonnet",
    };
    const reader = {
      getSessionSummary: vi.fn(async () => summary),
      getSession: vi.fn(async () => ({
        summary,
        data: {
          provider: "claude",
          session: {
            messages: [
              {
                type: "user",
                timestamp: "2026-04-24T20:00:00.000Z",
                message: {
                  role: "user",
                  content: "please hand this Claude session to Codex",
                },
              },
            ],
          },
        },
      })),
    } as unknown as ISessionReader;
    const startSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-new",
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.5",
      resolvedModel: "gpt-5.5",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn(() => vi.fn()),
    }));
    const setProvider = vi.fn(async () => undefined);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        startSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
      sessionMetadataService: {
        getProvider: vi.fn(() => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => undefined),
        setProvider,
        updateMetadata: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.5" }),
      },
    );

    expect(response.status).toBe(200);
    expect(startSession).toHaveBeenCalledWith(
      project.path,
      expect.objectContaining({
        text: expect.stringContaining("- Provider: claude"),
      }),
      undefined,
      expect.objectContaining({
        model: "gpt-5.5",
        providerName: "codex",
      }),
    );
    expect(startSession.mock.calls[0]?.[1].text).toContain("- Model: sonnet");
    expect(setProvider).toHaveBeenCalledWith("sess-new", "codex");
  });

  it("does not reuse generated handoff boilerplate as the next handoff title", async () => {
    const project = createProject();
    const startSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-new",
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.4",
      resolvedModel: "gpt-5.4",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn(() => vi.fn()),
    }));
    const updateMetadata = vi.fn(async () => undefined);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "u1",
              message: {
                role: "user",
                content:
                  "# Restart Handoff\n\nYep Anywhere is starting this as a fresh agent session.",
              },
            },
            {
              type: "user",
              uuid: "u2",
              message: {
                role: "user",
                content: "fix handoff session titles",
              },
            },
          ]),
        })),
        startSession,
        interruptProcess: vi.fn(async () => ({
          success: true,
          supported: true,
        })),
        abortProcess: vi.fn(async () => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => undefined),
        setProvider: vi.fn(async () => undefined),
        updateMetadata,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.4" }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.title).toBe("Handoff: fix handoff session titles");
    expect(startSession.mock.calls[0]?.[1].text).toContain(
      "# Handoff: fix handoff session titles",
    );
    expect(updateMetadata).toHaveBeenCalledWith("sess-new", {
      title: "Handoff: fix handoff session titles",
    });
  });

  it("tries provider-native compact before starting the handoff", async () => {
    const project = createProject();
    const history: unknown[] = [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-04-24T20:00:00.000Z",
        message: { role: "user", content: "handoff after compact please" },
      },
    ];
    let compactListener:
      | ((event: { type: string; message?: unknown }) => void)
      | undefined;
    const queueMessage = vi.fn((message) => {
      history.push({
        type: "user",
        uuid: "compact-command",
        timestamp: "2026-04-24T20:00:01.000Z",
        message: { role: "user", content: message.text },
      });
      queueMicrotask(() => {
        const compactMessage = {
          type: "system",
          subtype: "compact_boundary",
          uuid: "compact-1",
          timestamp: "2026-04-24T20:00:02.000Z",
          message: {
            role: "system",
            content: "Native compact summary text",
          },
        };
        history.push(compactMessage);
        compactListener?.({ type: "message", message: compactMessage });
      });
      return { success: true, position: 1 };
    });
    const interruptProcess = vi.fn(async () => ({
      success: true,
      supported: true,
    }));
    const startSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-new",
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.4",
      resolvedModel: "gpt-5.4",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn(() => vi.fn()),
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          supportsDynamicCommands: true,
          supportedCommands: vi.fn(async () => [
            { name: "compact", description: "Compact conversation" },
          ]),
          queueMessage,
          subscribe: vi.fn((listener) => {
            compactListener = listener;
            return vi.fn();
          }),
          getMessageHistory: vi.fn(() => history),
          getDeferredQueueSummary: vi.fn(() => []),
        })),
        startSession,
        interruptProcess,
        abortProcess: vi.fn(async () => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => undefined),
        setProvider: vi.fn(async () => undefined),
        updateMetadata: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.4" }),
      },
    );

    expect(response.status).toBe(200);
    expect(queueMessage).toHaveBeenCalledWith({ text: "/compact" });
    expect(queueMessage.mock.invocationCallOrder[0]).toBeLessThan(
      interruptProcess.mock.invocationCallOrder[0] ?? 0,
    );
    const handoffText = startSession.mock.calls[0]?.[1].text;
    expect(handoffText).toContain(
      "- Provider-native compact: completed with /compact",
    );
    expect(handoffText).toContain("## Provider-Native Compact Summary");
    expect(handoffText).toContain("Native compact summary text");
    expect(handoffText).not.toContain(
      "### user 2026-04-24T20:00:01.000Z\n\n/compact",
    );
  });

  it("summarizes fallback activity and appends queued turns last", async () => {
    const project = createProject();
    const verboseReadOutput = "VERBOSE_READ_OUTPUT".repeat(200);
    const startSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-new",
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.4",
      resolvedModel: "gpt-5.4",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn(() => vi.fn()),
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "in-turn" },
          getMessageHistory: vi.fn(() => [
            {
              type: "system",
              subtype: "compact_boundary",
              uuid: "compact-1",
              timestamp: "2026-04-24T20:00:00.000Z",
              message: {
                role: "system",
                content: "Existing compact summary",
              },
            },
            {
              type: "user",
              uuid: "u1",
              timestamp: "2026-04-24T20:01:00.000Z",
              message: { role: "user", content: "older user turn" },
            },
            {
              type: "assistant",
              uuid: "a1",
              timestamp: "2026-04-24T20:02:00.000Z",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "read-1",
                    name: "Read",
                    input: {
                      file_path: "packages/server/src/routes/sessions.ts",
                    },
                  },
                ],
              },
            },
            {
              type: "user",
              uuid: "tool-result-1",
              timestamp: "2026-04-24T20:03:00.000Z",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "read-1",
                    content: verboseReadOutput,
                  },
                ],
              },
            },
            {
              type: "user",
              uuid: "u2",
              timestamp: "2026-04-24T20:04:00.000Z",
              message: { role: "user", content: "latest user direction" },
            },
          ]),
          getDeferredQueueSummary: vi.fn(() => [
            {
              tempId: "queued-1",
              content: "queued follow-up",
              timestamp: "2026-04-24T20:05:00.000Z",
              attachmentCount: 1,
            },
          ]),
        })),
        startSession,
        interruptProcess: vi.fn(async () => ({
          success: true,
          supported: true,
        })),
        abortProcess: vi.fn(async () => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => undefined),
        setProvider: vi.fn(async () => undefined),
        updateMetadata: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.4" }),
      },
    );

    expect(response.status).toBe(200);
    const handoffText = startSession.mock.calls[0]?.[1].text;
    expect(handoffText).toContain(
      "- Provider-native compact: skipped: source process was in-turn",
    );
    expect(handoffText).toContain("## Provider-Native Compact Summary");
    expect(handoffText).toContain("Existing compact summary");
    expect(handoffText).toContain("## Recent User Turns");
    expect(handoffText).toContain("older user turn");
    expect(handoffText).toContain("latest user direction");
    expect(handoffText).toContain("[tool_use Read]");
    expect(handoffText).toContain("read/search details omitted");
    expect(handoffText).toContain("[tool_result] output omitted");
    expect(handoffText).not.toContain(verboseReadOutput);
    expect(handoffText).toContain("## Queued User Turns (Not Yet Processed)");
    expect(handoffText).toContain(
      "No agent response in the source session has processed them yet.",
    );
    expect(handoffText).toContain("queued follow-up");
    expect(handoffText).toContain("Attachments queued: 1");
    expect(handoffText?.trim().endsWith("Temp ID: queued-1")).toBe(true);
    expect(handoffText?.indexOf("## Queued User Turns")).toBeGreaterThan(
      handoffText?.indexOf("## Recent Agent and Tool Activity") ?? -1,
    );
  });

  it("does not abort the old process when handoff startup is queued", async () => {
    const project = createProject();
    const abortProcess = vi.fn(async () => true);
    const interruptProcess = vi.fn(async () => ({
      success: true,
      supported: true,
    }));
    const cancelQueuedRequest = vi.fn(() => true);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => []),
        })),
        interruptProcess,
        startSession: vi.fn(async () => ({
          queued: true,
          queueId: "queue-1",
          position: 1,
        })),
        cancelQueuedRequest,
        abortProcess,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.4" }),
      },
    );

    expect(response.status).toBe(503);
    expect(interruptProcess).toHaveBeenCalledWith("proc-old");
    expect(cancelQueuedRequest).toHaveBeenCalledWith("queue-1");
    expect(abortProcess).not.toHaveBeenCalled();
  });
});
