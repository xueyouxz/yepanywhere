import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import {
  preprocessMessages,
  stripAwaySummaryHintSuffix,
} from "../preprocessMessages";

describe("preprocessMessages", () => {
  it("pairs tool_use with tool_result", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "test.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "file contents",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "tool-1",
      toolName: "Read",
      status: "complete",
      toolResult: { content: "file contents", isError: false },
    });
  });

  it("preserves Agent tool summaries for rendering completed tasks", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Agent",
            input: {
              description: "Explore codebase for refactoring",
              prompt: "Find cleanup opportunities",
              subagent_type: "Explore",
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [
              {
                type: "text",
                text: "## Comprehensive Cleanup and Refactoring Opportunities Report",
              },
              {
                type: "text",
                text: "agentId: summary123\n<usage>total_tokens: 200\ntool_uses: 3\nduration_ms: 1000</usage>",
              },
            ],
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "tool-1",
      toolName: "Agent",
      status: "complete",
      toolResult: {
        isError: false,
        structured: {
          agentId: "summary123",
          status: "completed",
          content: [
            {
              type: "text",
              text: "## Comprehensive Cleanup and Refactoring Opportunities Report",
            },
          ],
          totalTokens: 200,
          totalToolUseCount: 3,
          totalDurationMs: 1000,
        },
      },
    });
  });

  it("marks tool_use as pending when result not yet received", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      status: "pending",
      toolResult: undefined,
    });
  });

  it("deduplicates repeated tool_use blocks with the same id", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);
    const toolCalls = items.filter((item) => item.type === "tool_call");

    expect(toolCalls).toHaveLength(1);
    const call = toolCalls[0];
    if (call?.type === "tool_call") {
      expect(call.id).toBe("call_1");
      expect(call.status).toBe("pending");
    }
  });

  it("updates a deduplicated pending tool_use snapshot", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Bash",
            input: {
              command: "npm test",
              _previewResult: {
                stdout: "partial\n",
                stderr: "",
                interrupted: false,
                isImage: false,
              },
            },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);
    const call = items.find((item) => item.type === "tool_call");

    expect(call).toMatchObject({
      type: "tool_call",
      id: "call_1",
      status: "pending",
      toolInput: {
        command: "npm test",
        _previewResult: {
          stdout: "partial\n",
          stderr: "",
          interrupted: false,
          isImage: false,
        },
      },
    });
  });

  it("attaches tool_result to deduplicated tool_use", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-3",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "success",
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);
    const toolCalls = items.filter((item) => item.type === "tool_call");

    expect(toolCalls).toHaveLength(1);
    const call = toolCalls[0];
    if (call?.type === "tool_call") {
      expect(call.status).toBe("complete");
      expect(call.toolResult?.content).toBe("success");
    }
  });

  it("handles multiple tool calls in sequence", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "a.ts" },
          },
          {
            type: "tool_use",
            id: "tool-2",
            name: "Read",
            input: { file_path: "b.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "contents a" },
          { type: "tool_result", tool_use_id: "tool-2", content: "contents b" },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    const item0 = items[0];
    const item1 = items[1];
    expect(item0?.type).toBe("tool_call");
    expect(item1?.type).toBe("tool_call");
    if (item0?.type === "tool_call" && item1?.type === "tool_call") {
      expect(item0.status).toBe("complete");
      expect(item1.status).toBe("complete");
    }
  });

  it("links write_stdin calls to prior bash command using session id", () => {
    const messages: Message[] = [
      {
        id: "msg-bash-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bash-1",
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-bash-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-1",
            content: "Process running with session ID 29243",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-stdin-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "stdin-1",
            name: "WriteStdin",
            input: { session_id: 29243, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);
    const writeStdinCall = items.find(
      (item) => item.type === "tool_call" && item.id === "stdin-1",
    );

    expect(writeStdinCall?.type).toBe("tool_call");
    if (writeStdinCall?.type === "tool_call") {
      expect(writeStdinCall.toolInput).toMatchObject({
        session_id: 29243,
        linked_command: "pnpm test",
      });
    }
  });

  it("links write_stdin calls to prior exec_command using session id", () => {
    const messages: Message[] = [
      {
        id: "msg-exec-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "exec-1",
            name: "exec_command",
            input: {
              cmd: "sed -n '1,140p' packages/client/src/layouts/NavigationLayout.tsx",
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-exec-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "exec-1",
            content: "Process running with session ID 70073",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-stdin-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "stdin-1",
            name: "WriteStdin",
            input: { session_id: 70073, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);
    const writeStdinCall = items.find(
      (item) => item.type === "tool_call" && item.id === "stdin-1",
    );

    expect(writeStdinCall?.type).toBe("tool_call");
    if (writeStdinCall?.type === "tool_call") {
      expect(writeStdinCall.toolInput).toMatchObject({
        session_id: 70073,
        linked_command:
          "sed -n '1,140p' packages/client/src/layouts/NavigationLayout.tsx",
      });
    }
  });

  it("links write_stdin calls to prior Read tool using structured session id", () => {
    const messages: Message[] = [
      {
        id: "msg-read-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: {
              file_path: "packages/client/src/hooks/useGlobalSessions.ts",
              offset: 1,
              limit: 260,
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-read-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: "",
          },
        ],
        toolUseResult: {
          type: "text",
          file: {
            filePath: "packages/client/src/hooks/useGlobalSessions.ts",
            content:
              'import { useCallback, useEffect, useRef, useState } from "react";\n',
            numLines: 1,
            startLine: 1,
            totalLines: 1,
          },
          session_id: 37863,
        },
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-stdin-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "stdin-1",
            name: "WriteStdin",
            input: { session_id: 37863, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);
    const writeStdinCall = items.find(
      (item) => item.type === "tool_call" && item.id === "stdin-1",
    );

    expect(writeStdinCall?.type).toBe("tool_call");
    if (writeStdinCall?.type === "tool_call") {
      expect(writeStdinCall.toolInput).toMatchObject({
        session_id: 37863,
        linked_file_path: "packages/client/src/hooks/useGlobalSessions.ts",
        linked_tool_name: "Read",
      });
    }
  });

  it("preserves thinking blocks", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me analyze this..." },
          { type: "text", text: "Here is my response." },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    expect(items[0]?.type).toBe("thinking");
    expect(items[1]?.type).toBe("text");
  });

  it("thinking blocks are 'streaming' when message is streaming, 'complete' otherwise", () => {
    const thinkingContent = [
      { type: "thinking" as const, thinking: "Let me think..." },
      { type: "text" as const, text: "My response." },
    ];

    const streamingItems = preprocessMessages([
      {
        id: "msg-1",
        role: "assistant",
        content: thinkingContent,
        timestamp: "2024-01-01T00:00:00Z",
        _isStreaming: true,
      } as Message,
    ]);
    const completeItems = preprocessMessages([
      {
        id: "msg-1",
        role: "assistant",
        content: thinkingContent,
        timestamp: "2024-01-01T00:00:00Z",
      },
    ]);

    const streamingThinking = streamingItems[0];
    const completeThinking = completeItems[0];
    expect(
      streamingThinking?.type === "thinking" && streamingThinking.status,
    ).toBe("streaming");
    expect(
      completeThinking?.type === "thinking" && completeThinking.status,
    ).toBe("complete");
  });

  it("hides internal reasoning placeholders but keeps real text", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Reasoning [internal]" },
          { type: "text", text: "Here is my response." },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("text");
  });

  it("handles user prompts with string content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        content: "Hello, please help me",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      id: "msg-1",
      content: "Hello, please help me",
    });
  });

  it("renders Claude local slash commands as system markers", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        content:
          "<local-command-caveat>Caveat: local command.</local-command-caveat>\n" +
          "<command-name>/clear</command-name>\n" +
          "<command-message>clear</command-message>\n" +
          "<command-args></command-args>\n" +
          "<local-command-caveat>Caveat: local command.</local-command-caveat>",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "local_command",
      content: "/clear",
    });
  });

  it("collapses leading session setup prompts into one item", () => {
    const messages: Message[] = [
      {
        id: "msg-setup-1",
        role: "user",
        content: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nfoo",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-setup-2",
        role: "user",
        content:
          "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-user-1",
        role: "user",
        content: "Implement the requested change",
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "session_setup",
      title: "Session setup",
      prompts: [
        "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nfoo",
        "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
      ],
    });
    expect(items[1]).toMatchObject({
      type: "user_prompt",
      content: "Implement the requested change",
    });
  });

  it("does not collapse a single setup-like prompt in the middle of a session", () => {
    const messages: Message[] = [
      {
        id: "msg-user-1",
        role: "user",
        content: "normal first prompt",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-setup-1",
        role: "user",
        content: "# AGENTS.md instructions for /repo",
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      content: "normal first prompt",
    });
    expect(items[1]).toMatchObject({
      type: "user_prompt",
      content: "# AGENTS.md instructions for /repo",
    });
  });

  it("collapses repeated setup prompts inserted after resume", () => {
    const messages: Message[] = [
      {
        id: "msg-user-1",
        role: "user",
        content: "normal first prompt",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-setup-1",
        role: "user",
        content: "# AGENTS.md instructions for /repo",
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-setup-2",
        role: "user",
        content:
          "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
        timestamp: "2024-01-01T00:00:02Z",
      },
      {
        id: "msg-user-2",
        role: "user",
        content: "follow-up after resume",
        timestamp: "2024-01-01T00:00:03Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      content: "normal first prompt",
    });
    expect(items[1]).toMatchObject({
      type: "session_setup",
      title: "Session setup",
      prompts: [
        "# AGENTS.md instructions for /repo",
        "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
      ],
    });
    expect(items[2]).toMatchObject({
      type: "user_prompt",
      content: "follow-up after resume",
    });
  });

  it("attaches markdown augment to assistant string content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: "Hello **world**",
        _html: "<p>Hello <strong>world</strong></p>",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "text",
      id: "msg-1",
      text: "Hello **world**",
      augmentHtml: "<p>Hello <strong>world</strong></p>",
    });
  });

  it("falls back to markdown augment map for assistant string content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: "Hello **world**",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages, {
      markdown: {
        "msg-1": { html: "<p>Hello <strong>world</strong></p>" },
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "text",
      id: "msg-1",
      text: "Hello **world**",
      augmentHtml: "<p>Hello <strong>world</strong></p>",
    });
  });

  it("marks tool result as error when is_error is true", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "invalid" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "Command failed",
            is_error: true,
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      status: "error",
      toolResult: { content: "Command failed", isError: true },
    });
  });

  it("skips empty text blocks", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   " },
          { type: "text", text: "Actual content" },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "text",
      text: "Actual content",
    });
  });

  it("attaches structured tool result data", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "test.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "file contents",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
        toolUseResult: { lineCount: 42, filePath: "/test.ts" },
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    const item = items[0];
    if (item?.type === "tool_call") {
      expect(item.toolResult?.structured).toEqual({
        lineCount: 42,
        filePath: "/test.ts",
      });
    }
  });

  it("renders turn_aborted system messages", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "system",
        subtype: "turn_aborted",
        content: "approval denied",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "turn_aborted",
      content: "approval denied",
    });
  });

  it("renders subagent activity system messages", () => {
    const messages: Message[] = [
      {
        id: "subagent-1",
        type: "system",
        subtype: "subagent_activity",
        content: "Subagent started: Explore",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "subagent_activity",
      content: "Subagent started: Explore",
    });
  });

  it("renders away summaries without the Claude config hint suffix", () => {
    expect(
      stripAwaySummaryHintSuffix(
        "Finished the route and started tests (disable recaps in /config)  \n",
      ),
    ).toBe("Finished the route and started tests");

    const messages: Message[] = [
      {
        id: "msg-recap-1",
        type: "system",
        subtype: "away_summary",
        content: "Ran typecheck (disable recaps in /config)\n",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "away_summary",
      content: "Ran typecheck",
    });
  });

  it("only highlights config_ack messages for new mismatches", () => {
    const messages: Message[] = [
      {
        id: "cfg-1",
        type: "system",
        subtype: "config_ack",
        content: "Codex acknowledged config: gpt-5.4 · effort high",
        configModel: "gpt-5.4",
        configThinking: "effort high",
        configMismatch: true,
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "cfg-2",
        type: "system",
        subtype: "config_ack",
        content: "Codex acknowledged config: gpt-5.4 · effort high",
        configModel: "gpt-5.4",
        configThinking: "effort high",
        configMismatch: true,
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "cfg-3",
        type: "system",
        subtype: "config_ack",
        content: "Codex acknowledged config: gpt-5.4 · effort xhigh",
        configModel: "gpt-5.4",
        configThinking: "effort xhigh",
        configMismatch: false,
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "config_ack",
      configChanged: true,
    });
    expect(items[1]).toMatchObject({
      type: "system",
      subtype: "config_ack",
      configChanged: false,
    });
    expect(items[2]).toMatchObject({
      type: "system",
      subtype: "config_ack",
      configChanged: false,
    });
  });

  it("renders provider error messages", () => {
    const messages: Message[] = [
      {
        id: "msg-err-1",
        type: "error",
        error: "Your refresh token was already used. Please sign in again.",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "error",
      content: "Your refresh token was already used. Please sign in again.",
    });
  });

  describe("orphaned tool handling", () => {
    it("marks orphaned tool_use as result unavailable", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "incomplete",
        toolResult: undefined,
      });
    });

    it("handles mix of orphaned and completed tools", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "a.ts" },
            },
            {
              type: "tool_use",
              id: "tool-2",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-2"], // only tool-2 is orphaned
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "file contents",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(2);
      const tool1 = items.find(
        (i) => i.type === "tool_call" && i.id === "tool-1",
      );
      const tool2 = items.find(
        (i) => i.type === "tool_call" && i.id === "tool-2",
      );

      expect(tool1?.type === "tool_call" && tool1.status).toBe("complete");
      expect(tool2?.type === "tool_call" && tool2.status).toBe("incomplete");
    });

    it("non-orphaned pending tools remain pending", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          // No orphanedToolUseIds - tool is still pending (live conversation)
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending",
      });
    });

    it("keeps Codex background process handles pending", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "sleep 20" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content:
                "Chunk ID: abc\nWall time: 1.0 seconds\nProcess running with session ID 123\nOutput:\n",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending",
      });
    });

    it("keeps Codex background process handles incomplete when orphaned", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "sleep 20" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content:
                "Chunk ID: abc\nWall time: 1.0 seconds\nProcess running with session ID 123\nOutput:\n",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "incomplete",
      });
    });

    it("lets a later observed result win over an orphan marker", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Edit",
              input: { file_path: "a.ts" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Patch applied",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "complete",
        toolResult: expect.objectContaining({ content: "Patch applied" }),
      });
    });

    it("keeps interrupted Bash results attachable for final output", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "sleep 20" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "aborted by user after 2.3s",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
        {
          id: "msg-3",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "(no output)",
            },
          ],
          timestamp: "2024-01-01T00:00:20Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(warn).not.toHaveBeenCalled();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "aborted",
        toolResult: expect.objectContaining({ content: "(no output)" }),
      });
      warn.mockRestore();
    });
  });

  describe("activeToolApproval handling", () => {
    it("treats all orphaned tools as pending when activeToolApproval is true", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
      ];

      const items = preprocessMessages(messages, {
        activeToolApproval: true,
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending", // Should be pending, not aborted
      });
    });

    it("still marks orphaned tools incomplete when activeToolApproval is false", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
      ];

      const items = preprocessMessages(messages, {
        activeToolApproval: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "incomplete",
      });
    });

    it("treats multiple orphaned tools as pending when activeToolApproval is true", () => {
      // Scenario: batch of tool calls all queued for approval
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Edit",
              input: { file_path: "a.ts" },
            },
            {
              type: "tool_use",
              id: "tool-2",
              name: "Edit",
              input: { file_path: "b.ts" },
            },
            {
              type: "tool_use",
              id: "tool-3",
              name: "Edit",
              input: { file_path: "c.ts" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1", "tool-2", "tool-3"],
        },
      ];

      const items = preprocessMessages(messages, {
        activeToolApproval: true,
      });

      expect(items).toHaveLength(3);
      // All should be pending, not aborted
      for (const item of items) {
        expect(item).toMatchObject({
          type: "tool_call",
          status: "pending",
        });
      }
    });

    it("keeps older orphaned tools incomplete during later active tool work", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "old-tool",
              name: "Bash",
              input: { command: "sleep 15" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["old-tool"],
        },
        {
          id: "msg-2",
          role: "user",
          content: "next prompt",
          timestamp: "2024-01-01T00:00:01Z",
        },
        {
          id: "msg-3",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "current-tool",
              name: "Edit",
              input: { file_path: "a.ts" },
            },
          ],
          timestamp: "2024-01-01T00:00:02Z",
          orphanedToolUseIds: ["current-tool"],
        },
      ];

      const items = preprocessMessages(messages, {
        activeToolApproval: true,
      });
      const oldTool = items.find(
        (item) => item.type === "tool_call" && item.id === "old-tool",
      );
      const currentTool = items.find(
        (item) => item.type === "tool_call" && item.id === "current-tool",
      );

      expect(oldTool?.type === "tool_call" && oldTool.status).toBe(
        "incomplete",
      );
      expect(currentTool?.type === "tool_call" && currentTool.status).toBe(
        "pending",
      );
    });

    it("handles activeToolApproval with no orphaned tools (no-op)", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          // No orphanedToolUseIds
        },
      ];

      const items = preprocessMessages(messages, {
        activeToolApproval: true,
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending", // Already pending, stays pending
      });
    });
  });

  describe("task notifications", () => {
    const TASK_NOTIFICATION_XML = [
      "<task-notification>",
      "<task-id>brltxam79</task-id>",
      "<tool-use-id>toolu_01T15Fx9KFBxXmgAzNYZnEBY</tool-use-id>",
      "<output-file>/tmp/tasks/brltxam79.output</output-file>",
      "<status>completed</status>",
      '<summary>Background command "Deploy fix" completed (exit code 0)</summary>',
      "</task-notification>",
    ].join("\n");

    it("renders an origin.kind task-notification as a parsed chip item", () => {
      const messages: Message[] = [
        {
          uuid: "11111111-1111-1111-1111-111111111111",
          type: "user",
          origin: { kind: "task-notification" },
          message: { role: "user", content: TASK_NOTIFICATION_XML },
          timestamp: "2024-01-01T00:00:00Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "task_notification",
        taskId: "brltxam79",
        toolUseId: "toolu_01T15Fx9KFBxXmgAzNYZnEBY",
        outputFile: "/tmp/tasks/brltxam79.output",
        status: "completed",
        summary: 'Background command "Deploy fix" completed (exit code 0)',
      });
    });

    it("classifies a queue-sourced notification with no origin via the structural marker", () => {
      // Monitor events arrive as queue-operation enqueues that the server
      // normalizes into deferred user messages WITHOUT origin.kind. Detection
      // must fall back to the content being a <task-notification> element.
      const progressXml = [
        "<task-notification>",
        "<task-id>bsmbc763d</task-id>",
        '<summary>Monitor event: "Wait for staging deploy to finish"</summary>',
        "<event>verify / attempt 1: 502\nverify / attempt 2: 200\nactive</event>",
        "</task-notification>",
      ].join("\n");
      const messages: Message[] = [
        {
          id: "queue-operation-0-2024",
          type: "user",
          role: "user",
          content: progressXml,
          message: { role: "user", content: progressXml },
          timestamp: "2024-01-01T00:00:00Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "task_notification",
        taskId: "bsmbc763d",
        status: undefined,
        event: "verify / attempt 1: 502\nverify / attempt 2: 200\nactive",
      });
    });

    it("does not classify a user prompt that merely quotes the tag", () => {
      const messages: Message[] = [
        {
          uuid: "22222222-2222-2222-2222-222222222222",
          type: "user",
          // No origin.kind, and the tag is embedded in prose — not a whole
          // <task-notification> element — so it stays a normal user prompt.
          message: {
            role: "user",
            content: `how should we render ${TASK_NOTIFICATION_XML}?`,
          },
          timestamp: "2024-01-01T00:00:00Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("user_prompt");
    });
  });
});
