import { describe, expect, it } from "vitest";
import { filterEnvForChildProcess } from "../../../src/sdk/providers/env-filter.js";

describe("filterEnvForChildProcess", () => {
  it("sets Claude Code's one-hour prompt cache TTL by default", () => {
    const env = filterEnvForChildProcess({
      HOME: "/home/test",
      PATH: "/usr/bin",
    });

    expect(env.ENABLE_PROMPT_CACHING_1H).toBe("1");
  });

  it("preserves explicit prompt-cache TTL choices", () => {
    const env = filterEnvForChildProcess({
      ENABLE_PROMPT_CACHING_1H: "0",
      FORCE_PROMPT_CACHING_5M: "1",
    });

    expect(env.ENABLE_PROMPT_CACHING_1H).toBe("0");
    expect(env.FORCE_PROMPT_CACHING_5M).toBe("1");
  });

  it("keeps transient Claude throttles retrying by default", () => {
    const env = filterEnvForChildProcess({
      HOME: "/home/test",
      PATH: "/usr/bin",
    });

    expect(env.CLAUDE_CODE_RETRY_WATCHDOG).toBe("1");
  });

  it("preserves an explicit transient retry watchdog choice", () => {
    const env = filterEnvForChildProcess({
      CLAUDE_CODE_RETRY_WATCHDOG: "0",
    });

    expect(env.CLAUDE_CODE_RETRY_WATCHDOG).toBe("0");
  });

  it("keeps other retryable Claude failures alive by default", () => {
    const env = filterEnvForChildProcess({
      HOME: "/home/test",
      PATH: "/usr/bin",
    });

    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe("2147483647");
  });

  it("preserves an explicit Claude retry-attempt limit", () => {
    const env = filterEnvForChildProcess({
      CLAUDE_CODE_MAX_RETRIES: "10",
    });

    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe("10");
  });

  it("sets a 59-minute Bash timeout ceiling by default", () => {
    const env = filterEnvForChildProcess({
      HOME: "/home/test",
      PATH: "/usr/bin",
    });

    expect(env.BASH_MAX_TIMEOUT_MS).toBe("3540000");
  });

  it("preserves an explicit Bash timeout ceiling", () => {
    const env = filterEnvForChildProcess({
      BASH_MAX_TIMEOUT_MS: "600000",
    });

    expect(env.BASH_MAX_TIMEOUT_MS).toBe("600000");
  });

  it("keeps filtering YA-internal launch variables", () => {
    const env = filterEnvForChildProcess({
      HOME: "/home/test",
      YEP_DATA_DIR: "/tmp/ya",
      npm_execpath: "/usr/bin/pnpm",
    });

    expect(env.HOME).toBe("/home/test");
    expect(env.YEP_DATA_DIR).toBeUndefined();
    expect(env.npm_execpath).toBeUndefined();
  });
});
