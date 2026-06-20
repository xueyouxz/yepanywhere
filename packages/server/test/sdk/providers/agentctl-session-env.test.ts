import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentctlSessionEnvBridge } from "../../../src/sdk/providers/agentctl-session-env.js";

function runBash(env: NodeJS.ProcessEnv): string {
  return execFileSync(
    "bash",
    [
      "-c",
      `printf "original=%s agentctl=%s" "\${YA_ORIGINAL_BASH_ENV_MARKER-}" "\${AGENTCTL_SESSION_ID-}"`,
    ],
    { encoding: "utf-8", env },
  );
}

function isBashAvailable(): boolean {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function bridgeTestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  delete env.AGENTCTL_SESSION_ID;
  delete env.YA_ORIGINAL_BASH_ENV_MARKER;
  delete env.YEP_ORIGINAL_BASH_ENV;
  return env;
}

const bashIt = isBashAvailable() ? it : it.skip;

describe("agentctl session env bridge", () => {
  bashIt("publishes AGENTCTL_SESSION_ID to later Bash shells", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ya-agentctl-env-test-"));
    const originalBashEnvPath = join(tempDir, "original-bash-env.sh");
    writeFileSync(
      originalBashEnvPath,
      "export YA_ORIGINAL_BASH_ENV_MARKER=kept\n",
      "utf-8",
    );
    const bridge = createAgentctlSessionEnvBridge();

    try {
      const env = bridge.extendEnv({
        ...bridgeTestEnv(),
        BASH_ENV: originalBashEnvPath,
      });

      expect(runBash(env)).toBe("original=kept agentctl=");

      bridge.publishSessionId("sess-'quoted");

      expect(runBash(env)).toBe("original=kept agentctl=sess-'quoted");
    } finally {
      bridge.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  bashIt("seeds a known resume session id before provider startup", () => {
    const bridge = createAgentctlSessionEnvBridge("sess-resume");

    try {
      expect(runBash(bridge.extendEnv(bridgeTestEnv()))).toBe(
        "original= agentctl=sess-resume",
      );
    } finally {
      bridge.cleanup();
    }
  });
});
