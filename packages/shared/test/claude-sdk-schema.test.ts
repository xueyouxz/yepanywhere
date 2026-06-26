import { describe, expect, it } from "vitest";
import {
  type ClaudeSessionEntry,
  ClaudeSessionEntrySchema,
  getLogicalParentUuid,
} from "../src/claude-sdk-schema/index.js";
import { AskUserQuestionResultSchema } from "../src/claude-sdk-schema/tool/ToolResultSchemas.js";

describe("Claude SDK schema", () => {
  it("parses session_state_changed system entries", () => {
    const result = ClaudeSessionEntrySchema.safeParse({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      session_id: "sess-1",
      isSidechain: false,
      userType: "external",
      cwd: "/repo",
      sessionId: "sess-1",
      version: "1.0.0",
      uuid: "11111111-1111-4111-8111-111111111111",
      timestamp: "2026-06-05T00:00:00.000Z",
      parentUuid: null,
    });

    expect(result.success).toBe(true);
  });

  it("parses AskUserQuestion results with multi-select answers", () => {
    const result = AskUserQuestionResultSchema.safeParse({
      questions: [
        {
          question: "Which checks?",
          header: "Checks",
          options: [
            { label: "Unit", description: "Run unit tests" },
            { label: "Types", description: "Run typecheck" },
          ],
          multiSelect: true,
        },
      ],
      answers: {
        "Which checks?": ["Unit", "Types"],
      },
    });

    expect(result.success).toBe(true);
  });

  it("uses compactMetadata preserved tail as the logical parent", () => {
    const result = ClaudeSessionEntrySchema.safeParse({
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      level: "info",
      compactMetadata: {
        trigger: "manual",
        preTokens: 345417,
        preservedSegment: { tailUuid: "tail" },
      },
      isSidechain: false,
      userType: "external",
      cwd: "/repo",
      sessionId: "sess-1",
      version: "1.0.0",
      uuid: "11111111-1111-4111-8111-111111111112",
      timestamp: "2026-06-05T00:00:00.000Z",
      parentUuid: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const metadata = result.data.compactMetadata as
      | Record<string, unknown>
      | undefined;
    expect(metadata?.preservedSegment).toEqual({ tailUuid: "tail" });
    expect(getLogicalParentUuid(result.data as ClaudeSessionEntry)).toBe(
      "tail",
    );
  });
});
