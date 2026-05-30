import { describe, expect, it, vi } from "vitest";
import {
  probeClaudeControlLiveness,
  resolveClaudeSdkNativeExecutable,
  withClaudeGoalAlias,
} from "../../../src/sdk/providers/claude.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

function control(
  mcpServerStatus: () => Promise<unknown>,
): Pick<Query, "mcpServerStatus"> {
  return {
    mcpServerStatus:
      mcpServerStatus as unknown as Query["mcpServerStatus"],
  };
}

describe("Claude provider liveness probe", () => {
  it("reports active when the SDK control channel responds", async () => {
    const checkedAt = new Date("2026-04-25T00:00:20.000Z");

    const result = await probeClaudeControlLiveness(
      control(async () => []),
      { checkedAt },
    );

    expect(result).toEqual({
      status: "active",
      source: "claude:control/mcp_status",
      checkedAt,
      detail:
        "Claude SDK control channel responded; direct turn status is not exposed",
    });
  });

  it("does not upgrade a dead CLI process through the control channel", async () => {
    const mcpServerStatus = vi.fn(async () => []);
    const checkedAt = new Date("2026-04-25T00:00:20.000Z");

    const result = await probeClaudeControlLiveness(
      control(mcpServerStatus),
      { checkedAt, isProcessAlive: () => false },
    );

    expect(result).toEqual({
      status: "unavailable",
      source: "claude:control/mcp_status",
      checkedAt,
      detail: "Claude CLI process is not alive",
    });
    expect(mcpServerStatus).not.toHaveBeenCalled();
  });

  it("reports an error when the control request fails", async () => {
    const checkedAt = new Date("2026-04-25T00:00:20.000Z");

    const result = await probeClaudeControlLiveness(
      control(async () => {
        throw new Error("control request failed");
      }),
      { checkedAt },
    );

    expect(result).toEqual({
      status: "error",
      source: "claude:control/mcp_status",
      checkedAt,
      detail: "control request failed",
    });
  });

  it("times out control requests that do not answer", async () => {
    vi.useFakeTimers();
    const checkedAt = new Date("2026-04-25T00:00:20.000Z");
    const resultPromise = probeClaudeControlLiveness(
      control(() => new Promise(() => {})),
      { checkedAt, timeoutMs: 5 },
    );

    await vi.advanceTimersByTimeAsync(5);
    const result = await resultPromise;

    expect(result).toEqual({
      status: "error",
      source: "claude:control/mcp_status",
      checkedAt,
      detail: "Claude SDK control liveness probe timed out after 5ms",
    });
    vi.useRealTimers();
  });
});

describe("Claude provider slash commands", () => {
  it("adds /goal as a /loop alias when /loop is advertised and /goal is not", () => {
    const commands = withClaudeGoalAlias([
      { name: "compact", description: "Compact conversation" },
      { name: "loop", description: "Run a prompt on a recurring interval" },
    ]);

    expect(commands).toEqual([
      { name: "compact", description: "Compact conversation" },
      { name: "loop", description: "Run a prompt on a recurring interval" },
      {
        name: "goal",
        description:
          "Keep working toward a verifiable end state until it is met",
        argumentHint: "<verifiable end state>",
        emulation: { providerText: "/loop wish {{argument}}" },
      },
    ]);
  });

  it("does not add /goal when /loop is unavailable", () => {
    const commands = withClaudeGoalAlias([
      { name: "compact", description: "Compact conversation" },
    ]);

    expect(commands).toEqual([
      { name: "compact", description: "Compact conversation" },
    ]);
  });

  it("does not duplicate /goal when the SDK already reports it", () => {
    const commands = withClaudeGoalAlias([
      { name: "/GOAL", description: "Native goal alias" },
      { name: "loop", description: "Run a prompt on a recurring interval" },
    ]);

    expect(commands).toEqual([
      { name: "/GOAL", description: "Native goal alias" },
      { name: "loop", description: "Run a prompt on a recurring interval" },
    ]);
  });
});

describe("Claude SDK executable resolution", () => {
  it("prefers the glibc native package on glibc Linux hosts", () => {
    const executable = resolveClaudeSdkNativeExecutable();

    expect(executable).toBeTruthy();
    if (
      process.platform === "linux" &&
      process.arch === "x64" &&
      (
        process.report.getReport() as {
          header?: { glibcVersionRuntime?: string };
        }
      ).header?.glibcVersionRuntime
    ) {
      expect(executable).toContain("claude-agent-sdk-linux-x64");
      expect(executable).not.toContain("claude-agent-sdk-linux-x64-musl");
    }
  });
});
