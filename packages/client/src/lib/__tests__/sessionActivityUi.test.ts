import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import type { RenderItem } from "../../types/renderItems";
import { getSessionActivityUiState } from "../sessionActivityUi";

const sourceMessages: Message[] = [];

function user(id: string): RenderItem {
  return {
    type: "user_prompt",
    id,
    content: "go",
    sourceMessages,
  };
}

function text(id: string, isStreaming = false): RenderItem {
  return {
    type: "text",
    id,
    text: "done",
    sourceMessages,
    ...(isStreaming ? { isStreaming } : {}),
  };
}

function tool(id: string, status: "pending" | "complete"): RenderItem {
  return {
    type: "tool_call",
    id,
    toolName: "Bash",
    toolInput: { command: "npm test" },
    sourceMessages,
    status,
  };
}

describe("getSessionActivityUiState", () => {
  it("treats a self-owned in-turn prompt as active", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [user("u1")],
    });

    expect(state.shouldDeferMessages).toBe(true);
    expect(state.canStopOwnedProcess).toBe(true);
    expect(state.showProcessingIndicator).toBe(true);
  });

  it("does not keep the turn active after a completed assistant answer", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [user("u1"), text("a1")],
    });

    expect(state.latestTurnSettled).toBe(true);
    expect(state.shouldDeferMessages).toBe(false);
    expect(state.canStopOwnedProcess).toBe(false);
    expect(state.showProcessingIndicator).toBe(false);
  });

  it("does not let older pending tool rows orphan the bottom spinner", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [user("u1"), tool("t1", "pending"), text("a1")],
    });

    expect(state.hasPendingToolCalls).toBe(true);
    expect(state.latestTurnSettled).toBe(true);
    expect(state.shouldDeferMessages).toBe(false);
    expect(state.showProcessingIndicator).toBe(false);
  });

  it("keeps the fallback active for a latest pending tool with stale idle state", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "idle",
      items: [user("u1"), tool("t1", "pending")],
    });

    expect(state.shouldDeferMessages).toBe(true);
    expect(state.canStopOwnedProcess).toBe(true);
    expect(state.showProcessingIndicator).toBe(true);
  });

  it("ignores stale ownership from other sessions", () => {
    const state = getSessionActivityUiState({
      owner: "none",
      processState: "in-turn",
      items: [user("u1"), tool("t1", "pending")],
    });

    expect(state.shouldDeferMessages).toBe(false);
    expect(state.canStopOwnedProcess).toBe(false);
    expect(state.showProcessingIndicator).toBe(false);
  });
});
