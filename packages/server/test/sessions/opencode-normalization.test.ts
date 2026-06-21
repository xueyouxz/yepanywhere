import type { OpenCodeStoredPart } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { convertOpenCodeParts } from "../../src/sessions/normalization.js";

function part(p: Partial<OpenCodeStoredPart>): OpenCodeStoredPart {
  return {
    id: "prt",
    sessionID: "ses",
    messageID: "msg",
    type: "text",
    ...p,
  } as OpenCodeStoredPart;
}

describe("convertOpenCodeParts (durable)", () => {
  it("maps reasoning parts to thinking blocks (skipping empty text)", () => {
    const blocks = convertOpenCodeParts([
      part({ type: "reasoning", text: "pondering" }),
      part({ type: "reasoning", text: "" }),
    ]);
    expect(blocks).toEqual([{ type: "thinking", thinking: "pondering" }]);
  });

  it("normalizes tool name + fields to YA rich-renderer shape", () => {
    const blocks = convertOpenCodeParts([
      part({
        type: "tool",
        tool: "edit",
        callID: "c1",
        state: {
          status: "completed",
          input: { filePath: "/a", oldString: "o", newString: "n" },
          output: "ok",
        },
      }),
    ]);
    expect(blocks[0]).toMatchObject({
      type: "tool_use",
      id: "c1",
      name: "Edit",
      input: { file_path: "/a", old_string: "o", new_string: "n" },
    });
    expect(blocks[1]).toMatchObject({
      type: "tool_result",
      tool_use_id: "c1",
      content: "ok",
      is_error: false,
    });
  });

  it("emits a tool_result with is_error for failed tools", () => {
    const blocks = convertOpenCodeParts([
      part({
        type: "tool",
        tool: "grep",
        callID: "c2",
        state: { status: "error", input: { pattern: "x" }, error: "boom" },
      }),
    ]);
    expect(blocks[1]).toMatchObject({
      type: "tool_result",
      tool_use_id: "c2",
      content: "boom",
      is_error: true,
    });
  });

  it("skips metadata/marker parts (step-*, patch, compaction)", () => {
    const blocks = convertOpenCodeParts([
      part({ type: "step-start" }),
      part({ type: "step-finish" }),
      part({ type: "patch" }),
      part({ type: "compaction" }),
    ]);
    expect(blocks).toEqual([]);
  });
});
