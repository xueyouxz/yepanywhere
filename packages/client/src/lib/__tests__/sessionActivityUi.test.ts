import { describe, expect, it } from "vitest";
import type { SessionLivenessSnapshot } from "@yep-anywhere/shared";
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

const waitingProviderLiveness: SessionLivenessSnapshot = {
  checkedAt: "2026-06-13T00:00:00.000Z",
  derivedStatus: "verified-waiting-provider",
  activeWorkKind: "agent-turn",
  state: "idle",
  evidence: ["provider-retained"],
  lastProviderMessageAt: "2026-06-13T00:00:00.000Z",
  lastRawProviderEventAt: null,
  lastRawProviderEventSource: null,
  lastStateChangeAt: "2026-06-13T00:00:00.000Z",
  lastVerifiedProgressAt: "2026-06-13T00:00:00.000Z",
  lastVerifiedIdleAt: null,
  lastLivenessProbeAt: null,
  lastLivenessProbeStatus: null,
  lastLivenessProbeSource: null,
  silenceMs: 0,
  longSilenceThresholdMs: 300_000,
  providerRetention: {
    retained: true,
    reasons: ["stop-hook-background-tasks:1"],
    backgroundTaskCount: 1,
  },
  queueDepth: 0,
  deferredQueueDepth: 0,
};

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

  it("keeps an owned in-turn process active after an assistant item completes", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [user("u1"), text("a1")],
    });

    expect(state.latestTurnSettled).toBe(true);
    expect(state.shouldDeferMessages).toBe(true);
    expect(state.canStopOwnedProcess).toBe(true);
    expect(state.showProcessingIndicator).toBe(true);
    expect(state.shouldSuppressCurrentTurnOrphans).toBe(true);
  });

  it("does not let older pending tool rows orphan the bottom spinner after idle", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "idle",
      items: [user("u1"), tool("t1", "pending"), text("a1")],
    });

    expect(state.hasPendingToolCalls).toBe(true);
    expect(state.latestTurnSettled).toBe(true);
    expect(state.shouldDeferMessages).toBe(false);
    expect(state.canStopOwnedProcess).toBe(false);
    expect(state.showProcessingIndicator).toBe(false);
    expect(state.shouldSuppressCurrentTurnOrphans).toBe(false);
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

  it("treats provider-retained idle as background work", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "idle",
      items: [user("u1"), text("a1")],
      sessionLiveness: waitingProviderLiveness,
    });

    expect(state.latestTurnSettled).toBe(true);
    expect(state.shouldDeferMessages).toBe(true);
    expect(state.canStopOwnedProcess).toBe(true);
    expect(state.showProcessingIndicator).toBe(true);
    expect(state.shouldSuppressCurrentTurnOrphans).toBe(true);
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
