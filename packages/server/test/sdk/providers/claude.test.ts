import { getModelContextWindow } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  claudeProvider,
  formatClaudeLoginCommand,
  mergeClaudeModels,
  probeClaudeControlLiveness,
  resolveClaudeSdkNativeExecutable,
  withClaudeGoalAlias,
} from "../../../src/sdk/providers/claude.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

describe("ClaudeProvider.contextWindowFor", () => {
  const ONE_M = getModelContextWindow("opus[1m]", "claude");

  it("returns 1M for opus (alias, resolved id, and [1m])", () => {
    expect(claudeProvider.contextWindowFor("opus")).toBe(ONE_M);
    expect(claudeProvider.contextWindowFor("claude-opus-4-8")).toBe(ONE_M);
    expect(claudeProvider.contextWindowFor("opus[1m]")).toBe(ONE_M);
  });

  it("defers (undefined) for sonnet and other models — sonnet 1M needs credits", () => {
    expect(claudeProvider.contextWindowFor("sonnet")).toBeUndefined();
    expect(
      claudeProvider.contextWindowFor("claude-sonnet-4-6"),
    ).toBeUndefined();
    expect(claudeProvider.contextWindowFor("opusplan")).toBeUndefined();
    expect(claudeProvider.contextWindowFor("haiku")).toBeUndefined();
    expect(claudeProvider.contextWindowFor(undefined)).toBeUndefined();
  });
});

describe("ClaudeProvider.yaModelIdForReported", () => {
  it("maps reported ids to the canonical family alias", () => {
    expect(claudeProvider.yaModelIdForReported("claude-opus-4-8")).toBe("opus");
    expect(claudeProvider.yaModelIdForReported("claude-sonnet-4-6")).toBe(
      "sonnet",
    );
    expect(claudeProvider.yaModelIdForReported("claude-haiku-4-5")).toBe(
      "haiku",
    );
    expect(claudeProvider.yaModelIdForReported("claude-fable-5")).toBe("fable");
  });

  it("matches the family regardless of component order (version-first ids)", () => {
    expect(claudeProvider.yaModelIdForReported("claude-3-5-sonnet")).toBe(
      "sonnet",
    );
  });

  it("is idempotent on bare aliases", () => {
    expect(claudeProvider.yaModelIdForReported("opus")).toBe("opus");
    expect(claudeProvider.yaModelIdForReported("sonnet")).toBe("sonnet");
  });

  it("returns undefined for unknown ids and empty input", () => {
    expect(
      claudeProvider.yaModelIdForReported("claude-mythos-5"),
    ).toBeUndefined();
    expect(
      claudeProvider.yaModelIdForReported("gpt-5.3-codex"),
    ).toBeUndefined();
    expect(claudeProvider.yaModelIdForReported(undefined)).toBeUndefined();
    expect(claudeProvider.yaModelIdForReported("")).toBeUndefined();
  });
});

function control(
  mcpServerStatus: () => Promise<unknown>,
): Pick<Query, "mcpServerStatus"> {
  return {
    mcpServerStatus: mcpServerStatus as unknown as Query["mcpServerStatus"],
  };
}

describe("ClaudeProvider model list", () => {
  it("keeps the default option generic when SDK returns a concrete-looking label", () => {
    const models = mergeClaudeModels([
      {
        id: "default",
        name: "Sonnet 4.6",
        description: "SDK-reported default",
      },
      {
        id: "claude-sonnet-4-6",
        name: "Sonnet 4.6",
        description: "Latest Sonnet",
      },
    ]);

    expect(models[0]).toMatchObject({
      id: "default",
      name: "Default (recommended)",
      description: "Claude Code chooses the recommended model for your account",
    });
    expect(models.map((model) => model.id)).toContain("claude-sonnet-4-6");
  });

  it("exposes Fable from fallback metadata when the SDK omits it", () => {
    const models = mergeClaudeModels([
      {
        id: "claude-sonnet-4-6",
        name: "Sonnet 4.6",
        description: "Latest Sonnet",
      },
    ]);

    expect(models.map((model) => model.id).slice(0, 4)).toEqual([
      "default",
      "best",
      "fable",
      "sonnet",
    ]);
    expect(models.find((model) => model.id === "fable")).toMatchObject({
      name: "Fable",
      contextWindow: 1_000_000,
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
      supportsEffort: true,
      supportsFastMode: false,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      defaultEffortLevel: "high",
    });
  });

  it("preserves SDK-reported model capability flags", () => {
    const models = mergeClaudeModels([
      {
        id: "claude-fable-5",
        name: "Fable 5",
        description: "SDK-reported Fable",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
        supportsAdaptiveThinking: true,
        supportsFastMode: false,
        supportsAutoMode: true,
      },
    ]);

    expect(models.find((model) => model.id === "claude-fable-5")).toMatchObject(
      {
        contextWindow: 1_000_000,
        supportsAdaptiveThinking: true,
        supportsFastMode: false,
        supportsAutoMode: true,
        supportedEffortLevels: ["low", "medium", "high"],
      },
    );
  });
});

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

    const result = await probeClaudeControlLiveness(control(mcpServerStatus), {
      checkedAt,
      isProcessAlive: () => false,
    });

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

describe("Claude login command", () => {
  it("uses the short shell command when no executable is preferred", () => {
    expect(formatClaudeLoginCommand(undefined, "win32")).toBe(
      "claude auth login --claudeai",
    );
  });

  it("formats a PowerShell command for Windows executable paths", () => {
    expect(
      formatClaudeLoginCommand(
        "C:\\Users\\me\\AppData\\Local\\Claude App\\claude.exe",
        "win32",
      ),
    ).toBe(
      '& "C:\\Users\\me\\AppData\\Local\\Claude App\\claude.exe" auth login --claudeai',
    );
  });
});
