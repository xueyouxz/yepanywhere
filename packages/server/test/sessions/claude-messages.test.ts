import { describe, expect, it } from "vitest";
import { collectVisibleClaudeEntries } from "../../src/sessions/claude-messages.js";

// Fixture rows are intentionally partial. The collector reads uuid,
// parentUuid, type/subtype, line order, and a small number of compaction flags.
// biome-ignore lint/suspicious/noExplicitAny: loose fixture rows by design
type RawSessionMessage = any;

describe("collectVisibleClaudeEntries", () => {
  it("keeps metadata-only compact boundaries on the active transcript", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "root", parentUuid: null },
      { type: "assistant", uuid: "tail", parentUuid: "root" },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact",
        parentUuid: null,
        content: "Conversation compacted",
        compactMetadata: {
          trigger: "manual",
          preTokens: 345417,
          preservedSegment: { tailUuid: "tail" },
        },
      },
      {
        type: "user",
        uuid: "summary",
        parentUuid: "compact",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { content: "Summary of previous context" },
      },
      {
        type: "user",
        uuid: "caveat",
        parentUuid: "tail",
        isMeta: true,
        message: {
          content:
            "<local-command-caveat>Caveat</local-command-caveat>",
        },
      },
      {
        type: "user",
        uuid: "command",
        parentUuid: "caveat",
        message: {
          content:
            "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>",
        },
      },
      { type: "assistant", uuid: "reply", parentUuid: "command" },
    ];

    const { entries } = collectVisibleClaudeEntries(messages);

    expect(entries.map((entry) => entry.uuid)).toEqual([
      "root",
      "tail",
      "compact",
      "summary",
      "caveat",
      "command",
      "reply",
    ]);
  });
});
