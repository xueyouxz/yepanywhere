import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENTCTL_SESSION_ID_ENV = "AGENTCTL_SESSION_ID";
const ORIGINAL_BASH_ENV_ENV = "YEP_ORIGINAL_BASH_ENV";

export interface AgentctlSessionEnvBridge {
  readonly bashEnvPath: string;
  extendEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  publishSessionId(sessionId: string): void;
  cleanup(): void;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function createAgentctlSessionEnvBridge(
  initialSessionId?: string,
): AgentctlSessionEnvBridge {
  const dir = mkdtempSync(join(tmpdir(), "ya-agentctl-session-"));
  const bashEnvPath = join(dir, "bash-env.sh");
  const sessionEnvPath = join(dir, "agentctl-session.env");

  writeFileSync(
    bashEnvPath,
    [
      "# yep-anywhere agentctl session bridge",
      `if [ -n "\${${ORIGINAL_BASH_ENV_ENV}:-}" ] && [ -r "\${${ORIGINAL_BASH_ENV_ENV}}" ]; then`,
      `  . "\${${ORIGINAL_BASH_ENV_ENV}}"`,
      "fi",
      `if [ -r ${shellSingleQuote(sessionEnvPath)} ]; then`,
      `  . ${shellSingleQuote(sessionEnvPath)}`,
      "fi",
      "",
    ].join("\n"),
    { encoding: "utf-8", mode: 0o600 },
  );

  const publishSessionId = (sessionId: string): void => {
    const tempPath = join(dir, "agentctl-session.env.tmp");
    writeFileSync(
      tempPath,
      [
        `${AGENTCTL_SESSION_ID_ENV}=${shellSingleQuote(sessionId)}`,
        `export ${AGENTCTL_SESSION_ID_ENV}`,
        "",
      ].join("\n"),
      { encoding: "utf-8", mode: 0o600 },
    );
    renameSync(tempPath, sessionEnvPath);
  };

  if (initialSessionId) {
    publishSessionId(initialSessionId);
  }

  return {
    bashEnvPath,
    extendEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
      return {
        ...env,
        ...(env.BASH_ENV
          ? { [ORIGINAL_BASH_ENV_ENV]: env.BASH_ENV }
          : undefined),
        BASH_ENV: bashEnvPath,
      };
    },
    publishSessionId,
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
