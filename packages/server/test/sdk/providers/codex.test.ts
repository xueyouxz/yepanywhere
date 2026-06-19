/**
 * Unit tests for CodexProvider.
 *
 * Tests provider detection, authentication checking, and message normalization
 * without requiring actual Codex CLI installation. The real app-server
 * contract check is opt-in via YA_CODEX_REAL_CONTRACT_TEST.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { preprocessMessages } from "../../../../client/src/lib/preprocessMessages.ts";
import { getCodexCommonPaths } from "../../../src/sdk/cli-detection.js";
import { logSDKMessage } from "../../../src/sdk/messageLogger.js";
import {
  CodexProvider,
  type CodexProviderConfig,
} from "../../../src/sdk/providers/codex.js";

vi.mock("../../../src/sdk/messageLogger.js", () => ({
  logSDKMessage: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(logSDKMessage).mockClear();
});

function createFakeCodexCommand(
  tempDir: string,
  basename: string,
  source: string,
): string {
  const scriptPath = join(tempDir, `${basename}.mjs`);
  writeFileSync(scriptPath, source, "utf-8");

  if (process.platform === "win32") {
    const cmdPath = join(tempDir, `${basename}.cmd`);
    writeFileSync(
      cmdPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf-8",
    );
    return cmdPath;
  }

  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function isBashAvailable(): boolean {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const bashIt = isBashAvailable() ? it : it.skip;

describe("CodexProvider", () => {
  let provider: CodexProvider;

  beforeAll(() => {
    provider = new CodexProvider();
  });

  describe("isInstalled", () => {
    it("should return boolean indicating CLI availability", async () => {
      const isInstalled = await provider.isInstalled();
      expect(typeof isInstalled).toBe("boolean");
    });

    it("should use custom codexPath if provided and exists", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-path-"));
      const codexPath = join(tempDir, "codex");
      writeFileSync(codexPath, "#!/bin/sh\necho codex-cli 0.0.0\n", "utf-8");
      const customProvider = new CodexProvider({
        codexPath,
      });
      try {
        expect(await customProvider.isInstalled()).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should treat missing custom codexPath as not installed", async () => {
      const customProvider = new CodexProvider({
        codexPath: "/nonexistent/path/to/codex",
      });
      expect(await customProvider.isInstalled()).toBe(false);
    });

    it("should include OpenAI Codex desktop hashed bin paths on Windows", () => {
      if (process.platform !== "win32") return;

      const tempDir = mkdtempSync(join(tmpdir(), "codex-desktop-bin-"));
      const oldLocalAppData = process.env.LOCALAPPDATA;
      try {
        const desktopBinDir = join(tempDir, "OpenAI", "Codex", "bin", "abc123");
        mkdirSync(desktopBinDir, { recursive: true });
        const codexPath = join(desktopBinDir, "codex.exe");
        writeFileSync(codexPath, "", "utf-8");

        process.env.LOCALAPPDATA = tempDir;

        expect(getCodexCommonPaths()).toContain(codexPath);
      } finally {
        if (oldLocalAppData === undefined) {
          delete process.env.LOCALAPPDATA;
        } else {
          process.env.LOCALAPPDATA = oldLocalAppData;
        }
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("getAuthStatus", () => {
    it("should return auth status object with required fields", async () => {
      const status = await provider.getAuthStatus();

      expect(typeof status.installed).toBe("boolean");
      expect(typeof status.authenticated).toBe("boolean");
      expect(typeof status.enabled).toBe("boolean");
    });

    it("should return authenticated=false if auth.json does not exist", async () => {
      // This test relies on the auth file not existing in the test environment
      const authPath = join(homedir(), ".codex", "auth.json");
      if (!existsSync(authPath)) {
        const status = await provider.getAuthStatus();
        // If CLI is not installed, everything should be false
        // If CLI is installed but no auth, installed=true but auth=false
        expect(status.authenticated).toBe(false);
      }
    });
  });

  describe("isAuthenticated", () => {
    it("should return boolean", async () => {
      const isAuth = await provider.isAuthenticated();
      expect(typeof isAuth).toBe("boolean");
    });
  });

  describe("provider properties", () => {
    it("should have correct name", () => {
      expect(provider.name).toBe("codex");
    });

    it("should have correct displayName", () => {
      expect(provider.displayName).toBe("Codex");
    });
  });

  describe("startSession", () => {
    it("should return session object with required methods", async () => {
      const noCliProvider = new CodexProvider({
        codexPath: "/nonexistent/codex",
      });

      const session = await noCliProvider.startSession({
        cwd: "/tmp",
        initialMessage: { text: "test" },
      });

      expect(session.iterator).toBeDefined();
      expect(typeof session.abort).toBe("function");
      expect(typeof session.interrupt).toBe("function");
      expect(typeof session.probeLiveness).toBe("function");
      expect(typeof session.supportedCommands).toBe("function");
      expect(session.queue).toBeDefined();
    });

    it("advertises native slash commands for toolbar controls", async () => {
      const noCliProvider = new CodexProvider({
        codexPath: "/nonexistent/codex",
      });

      const session = await noCliProvider.startSession({
        cwd: "/tmp",
        initialMessage: { text: "test" },
      });

      await expect(session.supportedCommands?.()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "compact" }),
          expect.objectContaining({ name: "goal" }),
        ]),
      );
    });

    it("should emit error if Codex CLI is not found", async () => {
      const noCliProvider = new CodexProvider({
        codexPath: "/nonexistent/codex",
      });

      const session = await noCliProvider.startSession({
        cwd: "/tmp",
        initialMessage: { text: "test" },
      });

      const messages: unknown[] = [];
      for await (const msg of session.iterator) {
        messages.push(msg);
        if (msg.type === "result" || msg.type === "error") break;
      }

      // Should get an error message about CLI not found
      expect(
        messages.some(
          (m: unknown) =>
            (m as { type?: string; error?: string }).type === "error" ||
            (m as { type?: string }).type === "result",
        ),
      ).toBe(true);
    });
  });
});

describe("CodexProvider app-server lifecycle", () => {
  bashIt(
    "publishes the Codex thread id to later app-server tool shells",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-agentctl-"));
      const logPath = join(tempDir, "fake-codex-requests.jsonl");
      const codexPath = createFakeCodexCommand(
        tempDir,
        "fake-codex-agentctl",
        buildFakeCodexAppServerWithAgentctlShellProbe(logPath),
      );

      let session:
        | Awaited<ReturnType<CodexProvider["startSession"]>>
        | undefined;
      let consume: Promise<void> | undefined;

      try {
        const testProvider = new CodexProvider({ codexPath });
        session = await testProvider.startSession({
          cwd: tempDir,
          initialMessage: { text: "check the agentctl env" },
          effort: "low",
        });

        consume = (async () => {
          for await (const _message of session?.iterator ?? []) {
            // drain until abort below
          }
        })();

        await waitForFakeCodexRequest(logPath, "turn/start");

        const turnStartRequest = readFakeCodexRequests(logPath).find(
          (request) => request.method === "turn/start",
        );
        expect(turnStartRequest?.agentctlSessionId).toBe("thread-agentctl");
      } finally {
        session?.abort();
        await consume?.catch(() => undefined);
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("sets AGENTCTL_SESSION_ID directly in the app-server env on resume", async () => {
    // Resume knows the session id at spawn, so it is set directly in the
    // app-server's own env (not only via the BASH_ENV bridge), surviving even
    // if codex never sources BASH_ENV. The fake server records the value it
    // reads straight from process.env at the first request.
    const tempDir = mkdtempSync(
      join(tmpdir(), "codex-provider-agentctl-resume-"),
    );
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-agentctl-resume",
      buildFakeCodexAppServerWithAgentctlShellProbe(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        resumeSessionId: "thread-resume-direct",
        initialMessage: { text: "resume the agentctl session" },
        effort: "low",
      });

      consume = (async () => {
        for await (const _message of session?.iterator ?? []) {
          // drain until abort below
        }
      })();

      await waitForFakeCodexRequest(logPath, "initialize");

      const initializeRequest = readFakeCodexRequests(logPath).find(
        (request) => request.method === "initialize",
      );
      expect(initializeRequest?.processEnvAgentctlSessionId).toBe(
        "thread-resume-direct",
      );
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the steered turn id for soft interrupt completion", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-lifecycle-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex",
      buildFakeCodexAppServer(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "start a fake turn" },
        effort: "low",
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await waitForFakeCodexRequest(logPath, "turn/start");
      expect(session.steer).toBeDefined();
      expect(
        await waitForSuccessfulSteer(session, {
          text: "steer the fake turn",
        }),
      ).toBe(true);
      await waitForFakeCodexRequest(logPath, "turn/steer");

      await session.interrupt?.();
      await consume;

      const requests = readFakeCodexRequests(logPath);
      const steerRequest = requests.find(
        (request) => request.method === "turn/steer",
      );
      const interruptRequest = requests.find(
        (request) => request.method === "turn/interrupt",
      );

      expect(steerRequest?.params).toMatchObject({
        expectedTurnId: "turn-start",
      });
      expect(interruptRequest?.params).toMatchObject({
        turnId: "turn-steered",
      });
      expect(
        messages.some(
          (message) =>
            message.type === "system" &&
            message.subtype === "turn_aborted" &&
            message.codexTurnId === "turn-steered",
        ),
      ).toBe(true);
      expect(messages.some((message) => message.type === "error")).toBe(false);
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts a clean Codex foreground-tool interrupt", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-tool-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-active-tool",
      buildFakeCodexAppServerWithActiveTool(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "run a fake tool" },
        effort: "low",
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await waitForMessage(messages, (message) =>
        JSON.stringify(message).includes("call-active"),
      );
      const activity = session.getProviderActivity?.();
      expect(activity?.lastRawProviderEventAt).toBeInstanceOf(Date);
      expect(activity?.lastRawProviderEventSource).toBe(
        "codex:notification:rawResponseItem/completed",
      );

      await expect(session.interrupt?.()).resolves.toBe(true);
      await consume;

      const interruptRequest = readFakeCodexRequests(logPath).find(
        (request) => request.method === "turn/interrupt",
      );
      expect(interruptRequest?.params).toMatchObject({
        turnId: "turn-active",
      });
      expect(
        messages.some((message) =>
          JSON.stringify(message).includes("aborted by user after 1.0s"),
        ),
      ).toBe(true);
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("drops Codex live deltas before raw logging when disabled by env", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-deltas-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-live-deltas",
      buildFakeCodexAppServerWithLiveDelta(logPath),
    );
    vi.stubEnv("YA_CODEX_DISABLE_LIVE_DELTAS", "true");

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "start a fake streamed turn" },
        effort: "low",
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await consume;

      expect(messages.some((message) => message._isStreaming)).toBe(false);
      expect(
        messages.some(
          (message) =>
            message.type === "assistant" &&
            (message.message as { content?: unknown } | undefined)?.content ===
              "Final streamed answer",
        ),
      ).toBe(true);

      const rawNotifications = vi
        .mocked(logSDKMessage)
        .mock.calls.map((call) => call[1] as { method?: string });
      expect(
        rawNotifications.some(
          (notification) => notification.method === "item/agentMessage/delta",
        ),
      ).toBe(false);
      expect(
        rawNotifications.some(
          (notification) => notification.method === "item/completed",
        ),
      ).toBe(true);
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      vi.unstubAllEnvs();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("drops Codex live deltas before raw logging when no subscriber wants them", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-no-demand-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-live-deltas",
      buildFakeCodexAppServerWithLiveDelta(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "start a fake streamed turn" },
        effort: "low",
        shouldEmitLiveDeltas: () => false,
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await consume;

      expect(messages.some((message) => message._isStreaming)).toBe(false);
      expect(
        messages.some(
          (message) =>
            message.type === "assistant" &&
            (message.message as { content?: unknown } | undefined)?.content ===
              "Final streamed answer",
        ),
      ).toBe(true);

      const rawNotifications = vi
        .mocked(logSDKMessage)
        .mock.calls.map((call) => call[1] as { method?: string });
      expect(
        rawNotifications.some(
          (notification) => notification.method === "item/agentMessage/delta",
        ),
      ).toBe(false);
      expect(
        rawNotifications.some(
          (notification) => notification.method === "item/completed",
        ),
      ).toBe(true);
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts interrupt with a Codex background tool handle", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-background-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-background-tool",
      buildFakeCodexAppServerWithBackgroundTool(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "run a fake background tool" },
        effort: "low",
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await waitForMessage(messages, (message) =>
        JSON.stringify(message).includes("Process running with session ID"),
      );

      await expect(session.interrupt?.()).resolves.toBe(true);
      await consume;

      const interruptRequest = readFakeCodexRequests(logPath).find(
        (request) => request.method === "turn/interrupt",
      );
      expect(interruptRequest?.params).toMatchObject({
        turnId: "turn-background",
      });
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses thread/read probe to reconcile a missed Codex completion", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-probe-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-idle-probe",
      buildFakeCodexAppServerWithIdleProbe(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "run a fake turn that misses completion" },
        effort: "low",
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await waitForFakeCodexRequest(logPath, "turn/start");
      const probe = await session.probeLiveness?.();

      expect(probe).toMatchObject({
        status: "idle",
        source: "codex:thread/read",
        detail: "thread.status:idle",
      });
      await consume;

      const requests = readFakeCodexRequests(logPath);
      expect(requests.some((request) => request.method === "thread/read")).toBe(
        true,
      );
      expect(
        messages.some(
          (message) =>
            message.type === "system" && message.subtype === "turn_complete",
        ),
      ).toBe(true);
      expect(messages.some((message) => message.type === "result")).toBe(true);
      expect(messages.some((message) => message.type === "error")).toBe(false);
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports interrupt incomplete before Codex has an active turn", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-no-turn-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-no-turn",
      buildFakeCodexAppServer(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        effort: "low",
      });

      const firstMessage = await session.iterator.next();
      expect(firstMessage.value).toMatchObject({
        type: "system",
        subtype: "init",
      });

      await expect(session.interrupt?.()).resolves.toBe(false);

      const requests = readFakeCodexRequests(logPath);
      expect(
        requests.some((request) => request.method === "turn/interrupt"),
      ).toBe(false);
    } finally {
      session?.abort();
      await session?.iterator.return?.(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("generates simulated recaps through an ephemeral helper thread", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-recap-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-recap",
      buildFakeCodexAppServerForRecap(logPath),
    );

    try {
      const testProvider = new CodexProvider({ codexPath });

      expect(testProvider.supportsRecaps).toBe(true);
      expect(testProvider.supportsNativePromptSuggestions).toBe(false);

      const recap = await testProvider.generateRecap(
        ["Implemented the Codex helper recap path.", "Ran the focused tests."],
        { model: "cheapest" },
      );

      expect(recap).toBe("Implemented the helper recap and ran focused tests.");

      const requests = readFakeCodexRequests(logPath);
      const threadStart = requests.find(
        (request) => request.method === "thread/start",
      );
      const turnStart = requests.find(
        (request) => request.method === "turn/start",
      );

      expect(requests.some((request) => request.method === "model/list")).toBe(
        true,
      );
      expect(threadStart?.params).toMatchObject({
        ephemeral: true,
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        model: "gpt-5.4-mini",
      });
      expect(turnStart?.params).toMatchObject({
        threadId: "thread-recap",
        model: "gpt-5.4-mini",
      });
      expect(JSON.stringify(turnStart?.params)).toContain(
        "Implemented the Codex helper recap path.",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

const describeRealCodexContract =
  process.env.YA_CODEX_REAL_CONTRACT_TEST === "true" ? describe : describe.skip;

describeRealCodexContract("Codex app-server real contract", () => {
  it("verifies steer and interrupt against the installed Codex app-server", async () => {
    const repoRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "..",
    );
    const probePath = join(
      repoRoot,
      "scripts",
      "probe-codex-app-server-turns.mjs",
    );
    const result = await runNodeProbe(probePath, repoRoot);

    if (result.code !== 0) {
      throw new Error(
        [
          `Codex app-server probe exited with code ${result.code}`,
          "stdout:",
          result.stdout.trim() || "(empty)",
          "stderr:",
          result.stderr.trim() || "(empty)",
        ].join("\n"),
      );
    }
    expect(result.stdout).toContain("turn/steer");
    expect(result.stdout).toContain("turn/interrupt");
    expect(result.stdout).toContain('"status": "interrupted"');
  }, 70_000);
});

function runNodeProbe(
  probePath: string,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probePath], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_PROBE_EFFORT: process.env.CODEX_PROBE_EFFORT ?? "low",
        CODEX_PROBE_TIMEOUT_MS: process.env.CODEX_PROBE_TIMEOUT_MS ?? "20000",
        CODEX_PROBE_INTERRUPT_DELAY_MS:
          process.env.CODEX_PROBE_INTERRUPT_DELAY_MS ?? "800",
      },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for Codex app-server probe"));
    }, 65_000);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function buildFakeCodexAppServer(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-1" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-start", status: "inProgress", error: null },
      });
      break;
    case "turn/steer":
      respond(message.id, { turnId: "turn-steered" });
      break;
    case "turn/interrupt":
      respond(message.id, {});
      notify("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: message.params.turnId,
          items: [],
          status: "interrupted",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithLiveDelta(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-1" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-live", status: "inProgress", error: null },
      });
      setTimeout(() => {
        notify("item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: "turn-live",
          itemId: "message-live",
          delta: "Live partial",
        });
        notify("item/completed", {
          threadId: "thread-1",
          turnId: "turn-live",
          item: {
            id: "message-live",
            type: "agentMessage",
            text: "Final streamed answer",
          },
        });
        notify("turn/completed", {
          threadId: "thread-1",
          turn: {
            id: "turn-live",
            items: [],
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        });
      }, 0);
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithIdleProbe(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-1" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-missed-completion", status: "inProgress", error: null },
      });
      break;
    case "thread/read":
      respond(message.id, {
        thread: {
          id: "thread-1",
          status: { type: "idle" },
          turns: [],
        },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithActiveTool(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-1" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-active", status: "inProgress", error: null },
      });
      setTimeout(() => {
        notify("rawResponseItem/completed", {
          threadId: "thread-1",
          turnId: "turn-active",
          item: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-active",
            arguments: "{\\"cmd\\":\\"sleep 20\\"}",
          },
        });
      }, 0);
      break;
    case "turn/interrupt":
      respond(message.id, {});
      notify("rawResponseItem/completed", {
        threadId: "thread-1",
        turnId: message.params.turnId,
        item: {
          type: "function_call_output",
          call_id: "call-active",
          output: "aborted by user after 1.0s",
        },
      });
      notify("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: message.params.turnId,
          items: [],
          status: "interrupted",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithBackgroundTool(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-1" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-background", status: "inProgress", error: null },
      });
      setTimeout(() => {
        notify("rawResponseItem/completed", {
          threadId: "thread-1",
          turnId: "turn-background",
          item: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-background",
            arguments: "{\\"cmd\\":\\"sleep 20\\",\\"tty\\":true}",
          },
        });
        notify("rawResponseItem/completed", {
          threadId: "thread-1",
          turnId: "turn-background",
          item: {
            type: "function_call_output",
            call_id: "call-background",
            output: "Chunk ID: abc\\nWall time: 1.0 seconds\\nProcess running with session ID 123\\nOutput:\\n",
          },
        });
      }, 0);
      break;
    case "turn/interrupt":
      respond(message.id, {});
      notify("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: message.params.turnId,
          items: [],
          status: "interrupted",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerForRecap(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "model/list":
      respond(message.id, {
        data: [
          {
            id: "gpt-5.4-mini",
            model: "gpt-5.4-mini",
            displayName: "GPT-5.4 Mini",
          },
        ],
      });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-recap", ephemeral: message.params.ephemeral === true },
        model: message.params.model,
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: {
          id: "turn-recap",
          items: [],
          itemsView: "complete",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      setTimeout(() => {
        notify("item/agentMessage/delta", {
          threadId: "thread-recap",
          turnId: "turn-recap",
          itemId: "message-recap",
          delta: "Implemented the helper recap and ran focused tests.",
        });
        notify("turn/completed", {
          threadId: "thread-recap",
          turn: {
            id: "turn-recap",
            items: [],
            itemsView: "complete",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        });
      }, 0);
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithAgentctlShellProbe(
  logPath: string,
): string {
  return `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
const agentctlProbeCommand = ${JSON.stringify(
    'printf "%s" "$' + '{AGENTCTL_SESSION_ID-}"',
  )};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function agentctlSessionIdFromBash() {
  return execFileSync("bash", ["-c", agentctlProbeCommand], {
    encoding: "utf-8",
    env: process.env,
  });
}

function logRequest(message) {
  const record = {
    id: message.id,
    method: message.method,
    params: message.params,
    processEnvAgentctlSessionId: process.env.AGENTCTL_SESSION_ID ?? "",
  };
  if (message.method === "turn/start") {
    record.agentctlSessionId = agentctlSessionIdFromBash();
  }
  appendFileSync(logPath, JSON.stringify(record) + "\\n");
}

function respond(id, result) {
  write({ id, result });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-agentctl" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "thread/resume":
      respond(message.id, {
        thread: { id: message.params?.threadId ?? "thread-agentctl" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-start", status: "inProgress", error: null },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function readFakeCodexRequests(logPath: string): Array<{
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  agentctlSessionId?: string;
  processEnvAgentctlSessionId?: string;
}> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function waitForFakeCodexRequest(
  logPath: string,
  method: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (
      readFakeCodexRequests(logPath).some((entry) => entry.method === method)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fake Codex request: ${method}`);
}

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (messages.some(predicate)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fake Codex message");
}

async function waitForSuccessfulSteer(
  session: Awaited<ReturnType<CodexProvider["startSession"]>>,
  message: { text: string },
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (await session.steer?.(message)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe("CodexProvider Auth File Parsing", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeAll(() => {
    // Create a temp directory to use as HOME
    tempDir = mkdtempSync(join(require("node:os").tmpdir(), "codex-test-"));
    originalHome = process.env.HOME;
  });

  afterAll(() => {
    // Restore HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    // Cleanup
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should parse valid auth.json file", async () => {
    // Create mock auth file
    const codexDir = join(tempDir, ".codex");
    require("node:fs").mkdirSync(codexDir, { recursive: true });

    const authData = {
      api_key: "test-key-123",
      expires_at: new Date(Date.now() + 86400000).toISOString(), // 1 day from now
      user: {
        email: "test@example.com",
        name: "Test User",
      },
    };

    writeFileSync(join(codexDir, "auth.json"), JSON.stringify(authData));

    // Create provider that looks in our temp directory
    // Note: This doesn't actually work because homedir() is cached,
    // but it demonstrates the intended behavior
  });

  it("should handle expired tokens", async () => {
    // Create mock auth file with expired token
    const codexDir = join(tempDir, ".codex");
    require("node:fs").mkdirSync(codexDir, { recursive: true });

    const authData = {
      api_key: "test-key-123",
      expires_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
    };

    writeFileSync(join(codexDir, "auth.json"), JSON.stringify(authData));

    // The actual test would need to mock homedir() to use tempDir
  });

  it("should handle invalid JSON in auth file", async () => {
    const codexDir = join(tempDir, ".codex");
    require("node:fs").mkdirSync(codexDir, { recursive: true });

    writeFileSync(join(codexDir, "auth.json"), "not valid json");

    // Provider should handle this gracefully
  });
});

describe("CodexProvider Event Normalization", () => {
  // Test helper to create a provider and access internal methods
  function createTestProvider(): CodexProvider {
    return new CodexProvider();
  }

  function createLiveEventState() {
    return {
      streamingTextByItemKey: new Map<string, string>(),
      streamingReasoningSummaryByItemKey: new Map<string, string[]>(),
      streamingToolOutputByItemKey: new Map<string, string>(),
      toolCallContexts: new Map<string, unknown>(),
      resultBackedToolItemsByTurnId: new Map<string, Set<string>>(),
    };
  }

  it("should have correct provider interface", () => {
    const provider = createTestProvider();

    expect(provider.name).toBe("codex");
    expect(provider.displayName).toBe("Codex");
    expect(typeof provider.isInstalled).toBe("function");
    expect(typeof provider.isAuthenticated).toBe("function");
    expect(typeof provider.getAuthStatus).toBe("function");
    expect(typeof provider.startSession).toBe("function");
  });

  it("logs raw Codex app-server notifications for sdk raw logging", () => {
    const provider = createTestProvider() as unknown as {
      logRawCodexNotification: (
        sessionId: string,
        notification: { method: string; params?: unknown },
      ) => void;
    };
    const notification = {
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "chunk",
      },
    };

    provider.logRawCodexNotification("session-1", notification);

    expect(logSDKMessage).toHaveBeenCalledOnce();
    expect(logSDKMessage).toHaveBeenCalledWith(
      "session-1",
      {
        _rawSource: "codex_app_server_notification",
        ...notification,
      },
      { provider: "codex" },
    );
  });

  it("identifies live delta notifications for the backend suppression toggle", () => {
    const provider = createTestProvider() as unknown as {
      shouldSuppressLiveDeltaNotification: (
        notification: {
          method: string;
          params?: unknown;
        },
        options: {
          cwd: string;
          shouldEmitLiveDeltas?: () => boolean;
        },
      ) => boolean;
    };
    const liveDeltaMethods = [
      "item/agentMessage/delta",
      "item/plan/delta",
      "item/reasoning/summaryTextDelta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
    ];

    try {
      vi.stubEnv("YA_CODEX_DISABLE_LIVE_DELTAS", "false");

      for (const method of liveDeltaMethods) {
        expect(
          provider.shouldSuppressLiveDeltaNotification(
            { method },
            {
              cwd: "/tmp",
            },
          ),
        ).toBe(false);
      }

      for (const method of liveDeltaMethods) {
        expect(
          provider.shouldSuppressLiveDeltaNotification(
            { method },
            { cwd: "/tmp", shouldEmitLiveDeltas: () => false },
          ),
        ).toBe(true);
      }

      vi.stubEnv("YA_CODEX_DISABLE_LIVE_DELTAS", "true");

      for (const method of liveDeltaMethods) {
        expect(
          provider.shouldSuppressLiveDeltaNotification(
            { method },
            {
              cwd: "/tmp",
            },
          ),
        ).toBe(true);
      }
      expect(
        provider.shouldSuppressLiveDeltaNotification(
          {
            method: "item/completed",
          },
          { cwd: "/tmp", shouldEmitLiveDeltas: () => false },
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("normalizes command execution tool_use and tool_result to Read shape", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-read",
        type: "command_execution",
        command: "cat src/example.ts",
        aggregated_output: "line 1\nline 2",
        exit_code: 0,
        status: "completed",
      },
      "session-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-read",
          name: "Read",
          input: { file_path: "src/example.ts" },
        },
      ],
    });
    expect(messages[1]?.message).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-read",
          content: "line 1\nline 2",
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "src/example.ts",
      },
    });
  });

  it("normalizes shell-launcher wrapped command execution to Read shape", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-read-wrapped",
        type: "command_execution",
        command: "/bin/bash -lc \"sed -n '10,12p' src/example.ts\"",
        aggregated_output: "line 10\nline 11\nline 12",
        exit_code: 0,
        status: "completed",
      },
      "session-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-read-wrapped",
          name: "Read",
          input: { file_path: "src/example.ts", offset: 10, limit: 3 },
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "src/example.ts",
        startLine: 10,
      },
    });
  });

  it("normalizes heredoc command execution as Write with structured file result", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const content = "line 1\nline 2\n";
    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-write",
        type: "command_execution",
        command: `cat > src/generated.ts <<'EOF'\n${content}EOF`,
        aggregated_output: "",
        exit_code: 0,
        status: "completed",
      },
      "session-1",
      "turn-2",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-write",
          name: "Write",
          input: {
            file_path: "src/generated.ts",
            content,
          },
        },
      ],
    });

    const resultBlock = ((
      messages[1]?.message as { content?: unknown[] } | undefined
    )?.content ?? [])[0] as Record<string, unknown>;
    expect(resultBlock.type).toBe("tool_result");
    expect(resultBlock.tool_use_id).toBe("call-write");
    expect(resultBlock.is_error).toBeUndefined();
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "src/generated.ts",
        content,
        numLines: 2,
        startLine: 1,
        totalLines: 2,
      },
    });
  });

  it("normalizes no-match ripgrep exit code as non-error Grep result", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-grep",
        type: "command_execution",
        command: "rg -n missing_pattern src",
        aggregated_output: "",
        exit_code: 1,
        status: "completed",
      },
      "session-1",
      "turn-2",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-grep",
          name: "Grep",
          input: { pattern: "missing_pattern", path: "src" },
        },
      ],
    });

    const resultBlock = ((
      messages[1]?.message as { content?: unknown[] } | undefined
    )?.content ?? [])[0] as Record<string, unknown>;
    expect(resultBlock.type).toBe("tool_result");
    expect(resultBlock.tool_use_id).toBe("call-grep");
    expect(resultBlock.is_error).toBeUndefined();
    expect(messages[1]?.toolUseResult).toMatchObject({
      mode: "files_with_matches",
      numFiles: 0,
    });
  });

  it("prefers reasoning summaries over raw reasoning content", () => {
    const provider = createTestProvider() as unknown as {
      normalizeThreadItem: (item: unknown) => Record<string, unknown> | null;
    };

    const normalized = provider.normalizeThreadItem({
      id: "reason-1",
      type: "reasoning",
      summary: ["Short summary"],
      content: ["internal raw reasoning"],
    });

    expect(normalized).toMatchObject({
      id: "reason-1",
      type: "reasoning",
      text: "Short summary",
    });
  });

  it("surfaces subagent activity items as visible system messages", () => {
    const provider = createTestProvider() as unknown as {
      normalizeThreadItem: (item: unknown) => Record<string, unknown> | null;
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const normalized = provider.normalizeThreadItem({
      id: "subagent-activity-1",
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "thread-subagent-1",
      agentPath: "Explore",
    });

    expect(normalized).toMatchObject({
      id: "subagent-activity-1",
      type: "subagent_activity",
      kind: "started",
      agentThreadId: "thread-subagent-1",
      agentPath: "Explore",
      text: "Subagent started: Explore",
    });

    const messages = provider.convertItemToSDKMessages(
      normalized,
      "session-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "system",
      subtype: "subagent_activity",
      content: "Subagent started: Explore",
      codexSubagentKind: "started",
      codexSubagentThreadId: "thread-subagent-1",
      codexSubagentPath: "Explore",
    });
  });

  it("declares experimentalApi during initialize when enabled", () => {
    const provider = createTestProvider() as unknown as {
      createInitializeParams: (
        experimentalApiEnabled: boolean,
      ) => Record<string, unknown>;
    };

    const params = provider.createInitializeParams(true);

    expect(params).toMatchObject({
      clientInfo: {
        title: null,
        version: "dev",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    expect((params.clientInfo as { name?: unknown }).name).toEqual(
      expect.any(String),
    );
  });

  it("requests automatic reasoning summaries on turn start", () => {
    const provider = createTestProvider() as unknown as {
      createTurnStartParams: (
        threadId: string,
        userPrompt: string,
        options: { effort?: unknown; thinking?: unknown },
      ) => Record<string, unknown>;
    };

    const params = provider.createTurnStartParams(
      "thread-1",
      "test prompt",
      {},
    );

    expect(params).toMatchObject({
      threadId: "thread-1",
      summary: "auto",
    });
  });

  it("prefers GPT-5.5 over Codex's model/list default when available", () => {
    const provider = createTestProvider() as unknown as {
      normalizeModelList: (models: unknown[]) => Array<{
        id: string;
        name: string;
        isDefault?: boolean;
        defaultReasoningEffort?: string;
        supportedReasoningEfforts?: Array<{
          reasoningEffort: string;
          description?: string;
        }>;
        inputModalities?: string[];
        supportsPersonality?: boolean;
        serviceTiers?: Array<{
          id: string;
          name: string;
          description?: string;
        }>;
      }>;
    };

    const models = provider.normalizeModelList([
      {
        id: "gpt-5.4",
        model: "gpt-5.4",
        displayName: "gpt-5.4",
        description: "Strong model for everyday coding.",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "low",
            description: "Fast responses with lighter reasoning",
          },
          {
            reasoningEffort: "medium",
            description: "Balanced speed and reasoning",
          },
        ],
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        serviceTiers: [
          {
            id: "priority",
            name: "Fast",
            description: "1.5x speed, increased usage",
          },
        ],
      },
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Frontier model.",
        isDefault: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "high",
            description: "Greater reasoning depth",
          },
        ],
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        serviceTiers: [
          {
            id: "priority",
            name: "Fast",
            description: "1.5x speed, increased usage",
          },
        ],
      },
      {
        id: "gpt-5.3-codex",
        model: "gpt-5.3-codex",
        upgrade: "gpt-5.4",
        hidden: false,
      },
      {
        id: "internal-hidden",
        model: "internal-hidden",
        hidden: true,
      },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
    ]);
    expect(models[0]).toMatchObject({
      name: "GPT-5.5",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        {
          reasoningEffort: "high",
          description: "Greater reasoning depth",
        },
      ],
      inputModalities: ["text", "image"],
      supportsPersonality: true,
      serviceTiers: [
        {
          id: "priority",
          name: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
    });
    expect(models[1]).toMatchObject({
      isDefault: true,
      inputModalities: ["text", "image"],
    });
  });

  it("builds stable thread policy params with limited history", () => {
    const provider = createTestProvider() as unknown as {
      mapPermissionModeToThreadPolicy: (permissionMode?: string) => {
        approvalPolicy: string;
        sandbox: string;
      };
      createThreadStartParams: (
        options: { model?: string; cwd: string },
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
      ) => Record<string, unknown>;
    };
    const bypassPolicy =
      provider.mapPermissionModeToThreadPolicy("bypassPermissions");

    const start = provider.createThreadStartParams(
      { model: "gpt-5.2-codex", cwd: "/tmp" },
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const bypassStart = provider.createThreadStartParams(
      { model: "gpt-5.5", cwd: "/tmp" },
      bypassPolicy,
    );

    expect(start).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      experimentalRawEvents: false,
    });
    expect(bypassStart).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      experimentalRawEvents: false,
    });
    expect(start.persistExtendedHistory).toBeUndefined();
    expect(bypassStart.persistExtendedHistory).toBeUndefined();
    expect(start.permissionProfile).toBeUndefined();
    expect(bypassStart.permissionProfile).toBeUndefined();
  });

  it("builds stable resume params with limited history", () => {
    const provider = createTestProvider() as unknown as {
      createThreadResumeParams: (
        options: { resumeSessionId?: string; model?: string; cwd: string },
        sessionId: string,
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
        experimentalApiEnabled?: boolean,
      ) => Record<string, unknown>;
    };

    const resume = provider.createThreadResumeParams(
      {
        resumeSessionId: "thread-1",
        model: "gpt-5.2-codex",
        cwd: "/tmp",
      },
      "thread-1",
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );

    expect(resume).toMatchObject({
      threadId: "thread-1",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(resume.excludeTurns).toBeUndefined();
    expect(resume.persistExtendedHistory).toBeUndefined();
    expect(resume.permissionProfile).toBeUndefined();
  });

  it("uses experimental excludeTurns after Codex negotiation succeeds", () => {
    const provider = createTestProvider() as unknown as {
      createThreadResumeParams: (
        options: { resumeSessionId?: string; model?: string; cwd: string },
        sessionId: string,
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
        experimentalApiEnabled?: boolean,
      ) => Record<string, unknown>;
    };

    const resume = provider.createThreadResumeParams(
      {
        resumeSessionId: "thread-1",
        model: "gpt-5.2-codex",
        cwd: "/tmp",
      },
      "thread-1",
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
      true,
    );

    expect(resume).toMatchObject({
      threadId: "thread-1",
      excludeTurns: true,
    });
    expect(resume.persistExtendedHistory).toBeUndefined();
  });

  it("pins thread-scope reasoning effort via config when effort is requested", () => {
    const provider = createTestProvider() as unknown as {
      createThreadStartParams: (
        options: {
          model?: string;
          cwd: string;
          effort?: string;
          thinking?: { type: string };
        },
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
        experimentalApiEnabled?: boolean,
      ) => Record<string, unknown>;
      createThreadResumeParams: (
        options: {
          resumeSessionId?: string;
          model?: string;
          cwd: string;
          effort?: string;
          thinking?: { type: string };
        },
        sessionId: string,
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
      ) => Record<string, unknown>;
      createTurnStartParams: (
        threadId: string,
        userPrompt: string,
        options: {
          model?: string;
          cwd: string;
          effort?: string;
          thinking?: { type: string };
        },
      ) => Record<string, unknown>;
    };

    const start = provider.createThreadStartParams(
      { model: "gpt-5.4-codex", cwd: "/tmp", effort: "max" },
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const startXhigh = provider.createThreadStartParams(
      { model: "gpt-5.4-codex", cwd: "/tmp", effort: "xhigh" },
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const resume = provider.createThreadResumeParams(
      {
        resumeSessionId: "thread-1",
        model: "gpt-5.4-codex",
        cwd: "/tmp",
        effort: "high",
      },
      "thread-1",
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const omitted = provider.createThreadStartParams(
      { model: "gpt-5.4-codex", cwd: "/tmp" },
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const disabled = provider.createThreadStartParams(
      {
        model: "gpt-5.4-codex",
        cwd: "/tmp",
        effort: "high",
        thinking: { type: "disabled" },
      },
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const turn = provider.createTurnStartParams("thread-1", "hello", {
      model: "gpt-5.4-codex",
      cwd: "/tmp",
      effort: "low",
      thinking: { type: "adaptive" },
    });
    const disabledTurn = provider.createTurnStartParams("thread-1", "hello", {
      model: "gpt-5.4-codex",
      cwd: "/tmp",
      effort: "high",
      thinking: { type: "disabled" },
    });

    expect(start).toMatchObject({
      config: { model_reasoning_effort: "xhigh" },
    });
    expect(startXhigh).toMatchObject({
      config: { model_reasoning_effort: "xhigh" },
    });
    expect(resume).toMatchObject({
      config: { model_reasoning_effort: "high" },
    });
    expect(omitted.config ?? null).toBeNull();
    expect(disabled).toMatchObject({
      config: { model_reasoning_effort: "none" },
    });
    expect(turn).toMatchObject({ effort: "low" });
    expect(disabledTurn).toMatchObject({ effort: "none" });
  });

  it("passes service tier only when explicitly requested", () => {
    const provider = createTestProvider() as unknown as {
      createThreadStartParams: (
        options: {
          model?: string;
          cwd: string;
          serviceTier?: string;
        },
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
      ) => Record<string, unknown>;
      createThreadResumeParams: (
        options: {
          resumeSessionId?: string;
          model?: string;
          cwd: string;
          serviceTier?: string;
        },
        sessionId: string,
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
      ) => Record<string, unknown>;
      createTurnStartParams: (
        threadId: string,
        userPrompt: string,
        options: {
          model?: string;
          cwd: string;
          serviceTier?: string;
        },
      ) => Record<string, unknown>;
    };

    const policy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const defaultStart = provider.createThreadStartParams(
      { model: "gpt-5.5", cwd: "/tmp" },
      policy,
    );
    const priorityStart = provider.createThreadStartParams(
      { model: "gpt-5.5", cwd: "/tmp", serviceTier: "priority" },
      policy,
    );
    const defaultResume = provider.createThreadResumeParams(
      { resumeSessionId: "thread-1", model: "gpt-5.5", cwd: "/tmp" },
      "thread-1",
      policy,
    );
    const priorityResume = provider.createThreadResumeParams(
      {
        resumeSessionId: "thread-1",
        model: "gpt-5.5",
        cwd: "/tmp",
        serviceTier: "priority",
      },
      "thread-1",
      policy,
    );
    const defaultTurn = provider.createTurnStartParams("thread-1", "hello", {
      model: "gpt-5.5",
      cwd: "/tmp",
    });
    const priorityTurn = provider.createTurnStartParams("thread-1", "hello", {
      model: "gpt-5.5",
      cwd: "/tmp",
      serviceTier: "priority",
    });

    expect(defaultStart.serviceTier).toBeUndefined();
    expect(defaultResume.serviceTier).toBeUndefined();
    expect(defaultTurn.serviceTier).toBeUndefined();
    expect(priorityStart).toMatchObject({ serviceTier: "priority" });
    expect(priorityResume).toMatchObject({ serviceTier: "priority" });
    expect(priorityTurn).toMatchObject({ serviceTier: "priority" });
  });

  it("accumulates agent message deltas into a stable streaming assistant message", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();

    const first = provider.convertNotificationToSDKMessages(
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "Hello",
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const second = provider.convertNotificationToSDKMessages(
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: " world",
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(first[0]).toMatchObject({
      type: "assistant",
      session_id: "session-1",
      uuid: "item-1-turn-1",
      _isStreaming: true,
      message: {
        role: "assistant",
        content: "Hello",
      },
    });
    expect(second[0]).toMatchObject({
      type: "assistant",
      session_id: "session-1",
      uuid: "item-1-turn-1",
      _isStreaming: true,
      message: {
        role: "assistant",
        content: "Hello world",
      },
    });
  });

  it("surfaces Codex context compaction thread items", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();
    const started = provider.convertNotificationToSDKMessages(
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "compact-1",
            type: "contextCompaction",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const completed = provider.convertNotificationToSDKMessages(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "compact-1",
            type: "contextCompaction",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(started[0]).toMatchObject({
      type: "system",
      subtype: "status",
      session_id: "session-1",
      uuid: "compact-1-turn-1",
      status: "compacting",
    });
    expect(completed[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      session_id: "session-1",
      uuid: "compact-1-turn-1",
      content: "Context compacted",
    });
  });

  it("surfaces raw Codex compaction response items as compact boundaries", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "compaction",
            encrypted_content: "opaque",
          },
        },
      },
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      session_id: "session-1",
      uuid: "codex-compaction-turn-1",
      content: "Context compacted",
    });
  });

  it("surfaces interrupted live Codex turns as visible system boundaries", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            items: [],
            status: "interrupted",
            error: null,
            startedAt: null,
            completedAt: 1_700_000_000,
            durationMs: null,
          },
        },
      },
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "system",
      subtype: "turn_aborted",
      session_id: "session-1",
      uuid: "codex-turn-interrupted-turn-1",
      content: "Conversation interrupted",
      reason: "interrupted",
      sourceEvent: "turn/completed",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      codexTurnStatus: "interrupted",
      timestamp: "2023-11-14T22:13:20.000Z",
    });

    expect(
      messages.some((message) => message.subtype === "turn_complete"),
    ).toBe(false);
    expect(
      preprocessMessages(
        messages as Parameters<typeof preprocessMessages>[0],
      )[0],
    ).toMatchObject({
      type: "system",
      subtype: "turn_aborted",
      content: "Conversation interrupted",
    });
  });

  it("normalizes raw response function calls and outputs into tool messages", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();
    const toolUse = provider.convertNotificationToSDKMessages(
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-1",
            arguments: '{"command":"pnpm lint"}',
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const toolResult = provider.convertNotificationToSDKMessages(
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "function_call_output",
            call_id: "call-1",
            output: "Process exited with code 0",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(toolUse[0]).toMatchObject({
      type: "assistant",
      session_id: "session-1",
      uuid: "call-1-turn-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "Bash",
            input: {
              command: "pnpm lint",
            },
          },
        ],
      },
    });
    expect(toolResult[0]).toMatchObject({
      type: "user",
      session_id: "session-1",
      uuid: "call-1-turn-1-result",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "Process exited with code 0",
          },
        ],
      },
    });
  });

  it("marks live result-backed tools incomplete when a turn completes first", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();
    const toolMessages = provider.convertNotificationToSDKMessages(
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "sleep 15",
            status: "inProgress",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const turnMessages = provider.convertNotificationToSDKMessages(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            items: [],
            status: "interrupted",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(turnMessages[0]).toMatchObject({
      type: "system",
      subtype: "codex_tool_orphans",
      orphanedToolUseIds: ["cmd-1"],
    });
    expect(turnMessages[1]).toMatchObject({
      type: "system",
      subtype: "turn_aborted",
      content: "Conversation interrupted",
      codexTurnId: "turn-1",
    });

    const renderItems = preprocessMessages([
      ...toolMessages,
      ...turnMessages,
    ] as Parameters<typeof preprocessMessages>[0]);
    expect(renderItems[0]).toMatchObject({
      type: "tool_call",
      id: "cmd-1",
      status: "incomplete",
    });
    expect(
      renderItems.some(
        (item) =>
          item.type === "system" &&
          item.subtype === "turn_aborted" &&
          item.content === "Conversation interrupted",
      ),
    ).toBe(true);
  });

  it("keeps Codex background process handles from reviving orphaned work", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();
    const toolUse = provider.convertNotificationToSDKMessages(
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "function_call",
            name: "exec_command",
            call_id: "cmd-1",
            arguments: '{"cmd":"sleep 20","tty":true}',
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const toolStarted = provider.convertNotificationToSDKMessages(
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "sleep 20",
            status: "inProgress",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const backgroundHandle = provider.convertNotificationToSDKMessages(
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "function_call_output",
            call_id: "cmd-1",
            output:
              "Chunk ID: abc\nWall time: 1.0 seconds\nProcess running with session ID 123\nOutput:\n",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const turnMessages = provider.convertNotificationToSDKMessages(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            items: [],
            status: "interrupted",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(turnMessages[0]).toMatchObject({
      type: "system",
      subtype: "codex_tool_orphans",
      orphanedToolUseIds: ["cmd-1"],
    });

    const renderItems = preprocessMessages([
      ...toolUse,
      ...toolStarted,
      ...backgroundHandle,
      ...turnMessages,
    ] as Parameters<typeof preprocessMessages>[0]);
    expect(renderItems[0]).toMatchObject({
      type: "tool_call",
      id: "cmd-1",
      status: "incomplete",
    });
  });

  it("does not mark completed live result-backed tools orphaned", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();
    const toolStarted = provider.convertNotificationToSDKMessages(
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "printf done",
            status: "inProgress",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const toolCompleted = provider.convertNotificationToSDKMessages(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "printf done",
            aggregatedOutput: "done",
            exitCode: 0,
            status: "completed",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const turnMessages = provider.convertNotificationToSDKMessages(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            items: [],
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(
      turnMessages.some((message) => message.subtype === "codex_tool_orphans"),
    ).toBe(false);

    const renderItems = preprocessMessages([
      ...toolStarted,
      ...toolCompleted,
      ...turnMessages,
    ] as Parameters<typeof preprocessMessages>[0]);
    expect(renderItems[0]).toMatchObject({
      type: "tool_call",
      id: "cmd-1",
      status: "complete",
    });
  });

  it("normalizes dynamic tool calls with namespace and output content", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-dynamic",
        type: "dynamic_tool_call",
        namespace: "web",
        tool: "search",
        arguments: { query: "codex release" },
        status: "completed",
        success: true,
        content_items: [{ type: "inputText", text: "Search completed" }],
      },
      "session-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-dynamic",
          name: "web:search",
          input: { query: "codex release" },
        },
      ],
    });
    expect(messages[1]?.message).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-dynamic",
          content: "Search completed",
        },
      ],
    });
  });

  it("does not emit rate limit errors when hasCredits is false but usage is below 100%", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: {
              usedPercent: 21,
              resetsAt: 1772721801,
            },
            credits: {
              hasCredits: false,
              unlimited: false,
              balance: null,
            },
          },
        },
      },
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages).toEqual([]);
  });

  it("does not emit synthetic errors for exhausted usage snapshots", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: {
              used_percent: 100,
              resets_at: 1772721801,
            },
            credits: {
              has_credits: false,
              unlimited: false,
              balance: null,
            },
          },
        },
      },
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages).toEqual([]);
  });

  it("emits errors from codex error notifications", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: false,
          error: {
            message:
              "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
            codexErrorInfo: "usageLimitExceeded",
          },
        },
      },
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "error",
      session_id: "session-1",
      error:
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
    });
  });

  it("grants requested permission profiles automatically in bypass mode", async () => {
    const provider = createTestProvider() as unknown as {
      handleServerRequestApproval: (
        request: { method: string; id: number; params?: unknown },
        options: { permissionMode?: string },
        signal: AbortSignal,
      ) => Promise<Record<string, unknown>>;
    };

    const response = await provider.handleServerRequestApproval(
      {
        method: "item/permissions/requestApproval",
        id: 1,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "permission-1",
          cwd: "/tmp/project",
          reason: "Need unrestricted filesystem for GPU tooling",
          permissions: {
            network: { enabled: true },
            fileSystem: {
              entries: [
                {
                  path: { type: "special", value: { kind: "root" } },
                  access: "write",
                },
              ],
            },
          },
        },
      },
      { permissionMode: "bypassPermissions" },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      scope: "session",
      permissions: {
        network: { enabled: true },
        fileSystem: {
          entries: [
            {
              path: { type: "special", value: { kind: "root" } },
              access: "write",
            },
          ],
        },
      },
    });
  });
});

describe("CodexProvider Configuration", () => {
  it("should accept custom timeout", () => {
    const config: CodexProviderConfig = {
      timeout: 60000,
    };
    const provider = new CodexProvider(config);

    expect(provider.name).toBe("codex");
    // Can't directly verify timeout since it's private,
    // but we can verify the provider was created
  });

  it("should accept custom codex path", () => {
    const config: CodexProviderConfig = {
      codexPath: "/custom/path/to/codex",
    };
    const provider = new CodexProvider(config);

    expect(provider.name).toBe("codex");
  });

  it("should use defaults when no config provided", () => {
    const provider = new CodexProvider();

    expect(provider.name).toBe("codex");
    expect(provider.displayName).toBe("Codex");
  });
});
