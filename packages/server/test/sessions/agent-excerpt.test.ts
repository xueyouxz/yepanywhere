import { describe, expect, it } from "vitest";
import { extractLastAgentExcerpt } from "../../src/sessions/agent-excerpt.js";
import type { Message } from "../../src/supervisor/types.js";

function assistant(content: Message["message"]): Message {
  return { type: "assistant", message: content };
}

describe("extractLastAgentExcerpt (provider-independent)", () => {
  it("keeps the last lines of the most recent assistant turn", () => {
    const messages: Message[] = [
      { type: "user", message: { role: "user", content: "go" } },
      assistant({
        role: "assistant",
        content: [{ type: "text", text: "first\nsecond\nthird\nfourth" }],
      }),
    ];
    expect(extractLastAgentExcerpt(messages)).toBe("second\nthird\nfourth");
  });

  it("falls back to an earlier text turn when the latest is tool-only", () => {
    const messages: Message[] = [
      assistant({
        role: "assistant",
        content: [{ type: "text", text: "earlier reply" }],
      }),
      { type: "user", message: { role: "user", content: [] } },
      assistant({
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      }),
    ];
    expect(extractLastAgentExcerpt(messages)).toBe("earlier reply");
  });

  it("labels the trailing tool when there is no agent prose", () => {
    const messages: Message[] = [
      assistant({
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }],
      }),
    ];
    expect(extractLastAgentExcerpt(messages)).toBe("⚙ Edit");
  });

  it("detects assistant turns by message.role (normalized non-Claude shape)", () => {
    const messages: Message[] = [
      // type left generic to mimic a provider whose converter sets only role.
      { type: "message", message: { role: "assistant", content: "shipped it" } },
    ];
    expect(extractLastAgentExcerpt(messages)).toBe("shipped it");
  });
});
