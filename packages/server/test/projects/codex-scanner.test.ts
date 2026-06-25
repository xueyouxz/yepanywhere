import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import { createCodexSessionDiscoveryIndex } from "../../src/sessions/codex-discovery.js";
import { getCodexRolloutDiscoveryIdentity } from "../../src/utils/codexRolloutFiles.js";
import { isZstdJsonlSupported } from "../../src/utils/jsonl.js";

function makeSessionMeta(
  id: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      cwd,
      timestamp: new Date().toISOString(),
      ...extra,
    },
  });
}

const zstdCompressSync = (
  zlib as typeof zlib & {
    zstdCompressSync?: (buffer: Buffer) => Buffer;
  }
).zstdCompressSync;
const hasNativeZstd =
  typeof zstdCompressSync === "function" && isZstdJsonlSupported();
const itIfNativeZstd = hasNativeZstd ? it : it.skip;
const itIfNoNativeZstd = hasNativeZstd ? it.skip : it;

function zstdCompressed(content: string): Buffer {
  if (!zstdCompressSync) {
    throw new Error("zstd compression is unavailable in this Node.js");
  }
  return zstdCompressSync(Buffer.from(content, "utf-8"));
}

describe("CodexSessionScanner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("discovers sessions from date-based directory structure", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    const id = randomUUID();
    await writeFile(
      join(dateDir, `rollout-${id}.jsonl`),
      `${makeSessionMeta(id, "/home/user/project-a")}\n{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}\n`,
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/home/user/project-a");
    expect(projects[0].provider).toBe("codex");
    expect(projects[0].sessionCount).toBe(1);
  });

  it("groups sessions by cwd into projects", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    const id1 = randomUUID();
    const id2 = randomUUID();
    const id3 = randomUUID();

    // Two sessions in project-a, one in project-b
    await writeFile(
      join(dateDir, `rollout-${id1}.jsonl`),
      `${makeSessionMeta(id1, "/home/user/project-a")}\n`,
    );
    await writeFile(
      join(dateDir, `rollout-${id2}.jsonl`),
      `${makeSessionMeta(id2, "/home/user/project-a")}\n`,
    );
    await writeFile(
      join(dateDir, `rollout-${id3}.jsonl`),
      `${makeSessionMeta(id3, "/home/user/project-b")}\n`,
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(2);
    const projectA = projects.find((p) => p.path === "/home/user/project-a");
    const projectB = projects.find((p) => p.path === "/home/user/project-b");
    expect(projectA?.sessionCount).toBe(2);
    expect(projectB?.sessionCount).toBe(1);
  });

  itIfNativeZstd("discovers zstd-compressed rollout files", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    const id = randomUUID();
    await writeFile(
      join(dateDir, `rollout-${id}.jsonl.zst`),
      zstdCompressed(
        `${makeSessionMeta(id, "/home/user/project-zst")}\n{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}\n`,
      ),
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/home/user/project-zst");
    expect(projects[0].sessionCount).toBe(1);

    const metrics = scanner.getLastScanMetrics();
    expect(metrics?.compressedRolloutFiles).toBe(1);
    expect(metrics?.discovery.firstLineReadsZstd).toBe(1);
    expect(metrics?.discovery.cacheBackedCompressedReads).toBe(0);
  });

  itIfNoNativeZstd("skips zstd rollouts when native zstd is unavailable", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    const id = randomUUID();
    await writeFile(
      join(dateDir, `rollout-${id}.jsonl.zst`),
      Buffer.from(`${makeSessionMeta(id, "/home/user/project-zst")}\n`),
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(0);

    const metrics = scanner.getLastScanMetrics();
    expect(metrics?.compressedRolloutFiles).toBe(1);
    expect(metrics?.sessionsParsed).toBe(0);
    expect(metrics?.failedFiles).toBe(1);
    expect(metrics?.discovery.zstdUnsupported).toBe(1);
    expect(metrics?.discovery.firstLineReadsZstd).toBe(0);
    expect(metrics?.discovery.metadataReadFailures).toBe(0);
  });

  it("prefers plain rollouts over compressed siblings", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    const id = randomUUID();
    const rolloutPath = join(dateDir, `rollout-${id}.jsonl`);
    await writeFile(
      rolloutPath,
      `${makeSessionMeta(id, "/home/user/plain-project")}\n`,
    );
    await writeFile(
      `${rolloutPath}.zst`,
      Buffer.from("compressed sibling should not be read"),
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/home/user/plain-project");

    const metrics = scanner.getLastScanMetrics();
    expect(metrics?.rolloutFilesFound).toBe(2);
    expect(metrics?.rolloutFilesAfterPrecedence).toBe(1);
    expect(metrics?.precedenceSkippedCompressed).toBe(1);
    expect(metrics?.plainRolloutFiles).toBe(1);
    expect(metrics?.compressedRolloutFiles).toBe(1);
  });

  it("deduplicates mixed-slash Windows cwd variants into one project", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    const id1 = randomUUID();
    const id2 = randomUUID();

    await writeFile(
      join(dateDir, `rollout-${id1}.jsonl`),
      `${makeSessionMeta(id1, "C:\\Users\\kyle\\Documents\\webvam")}\n`,
    );
    await writeFile(
      join(dateDir, `rollout-${id2}.jsonl`),
      `${makeSessionMeta(id2, "c:/Users/kyle/Documents/webvam")}\n`,
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("C:/Users/kyle/Documents/webvam");
    expect(projects[0].sessionCount).toBe(2);
  });

  it("parses session_meta with very large base_instructions over 64KB", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    // Simulate Codex Desktop which embeds the full system prompt (~11KB+)
    const largeInstructions = "x".repeat(80_000);
    const id = randomUUID();
    const meta = JSON.stringify({
      type: "session_meta",
      payload: {
        id,
        cwd: "/home/user/project-large",
        timestamp: new Date().toISOString(),
        originator: "Codex Desktop",
        cli_version: "0.94.0-alpha.10",
        source: "vscode",
        model_provider: "openai",
        base_instructions: { text: largeInstructions },
      },
    });

    // Regression guard: older scanner logic only read the first 64KB.
    expect(Buffer.byteLength(meta)).toBeGreaterThan(65_536);

    await writeFile(join(dateDir, `rollout-${id}.jsonl`), `${meta}\n`);

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/home/user/project-large");
  });

  it("persists normalized metadata and reuses it after append", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    const dataDir = join(tmpdir(), `codex-data-${randomUUID()}`);
    tempDirs.push(sessionsDir, dataDir);

    const dateDir = join(sessionsDir, "2026", "06", "25");
    await mkdir(dateDir, { recursive: true });

    const largeInstructions = "x".repeat(80_000);
    const id = randomUUID();
    const meta = JSON.stringify({
      type: "session_meta",
      payload: {
        id,
        cwd: "/home/user/project-cache",
        timestamp: new Date().toISOString(),
        base_instructions: { text: largeInstructions },
      },
    });
    const sessionPath = join(dateDir, `rollout-${id}.jsonl`);
    await writeFile(sessionPath, `${meta}\n`);

    const scanner = new CodexSessionScanner({ sessionsDir, dataDir });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);

    const index = createCodexSessionDiscoveryIndex(dataDir, sessionsDir);
    expect(index).toBeDefined();
    if (!index) return;

    const identity = getCodexRolloutDiscoveryIdentity(
      sessionsDir,
      sessionPath,
    );
    const shardPath = index.getShardPath(identity.shardKey);
    const beforeRaw = await readFile(shardPath, "utf-8");
    expect(beforeRaw).not.toContain("base_instructions");

    const before = JSON.parse(beforeRaw) as {
      records: Record<string, { lastValidatedAtMs: number }>;
    };
    const beforeRecord = before.records[identity.key];
    expect(beforeRecord).toBeDefined();
    const lastValidatedAtMs = beforeRecord?.lastValidatedAtMs;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "hello" },
      })}\n`,
    );

    const restartedScanner = new CodexSessionScanner({ sessionsDir, dataDir });
    const restartedProjects = await restartedScanner.listProjects();
    expect(restartedProjects).toHaveLength(1);
    expect(restartedProjects[0].path).toBe("/home/user/project-cache");

    const after = JSON.parse(await readFile(shardPath, "utf-8")) as {
      records: Record<string, { lastValidatedAtMs: number }>;
    };
    expect(after.records[identity.key]?.lastValidatedAtMs).toBe(
      lastValidatedAtMs,
    );
  });

  it("records discovery index hit and miss metrics", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    const dataDir = join(tmpdir(), `codex-data-${randomUUID()}`);
    tempDirs.push(sessionsDir, dataDir);

    const dateDir = join(sessionsDir, "2026", "06", "25");
    await mkdir(dateDir, { recursive: true });

    const id = randomUUID();
    await writeFile(
      join(dateDir, `rollout-${id}.jsonl`),
      `${makeSessionMeta(id, "/home/user/project-metrics")}\n`,
    );

    const scanner = new CodexSessionScanner({ sessionsDir, dataDir });
    expect(await scanner.listProjects()).toHaveLength(1);
    const firstMetrics = scanner.getLastScanMetrics();
    expect(firstMetrics?.rolloutFilesFound).toBe(1);
    expect(firstMetrics?.sessionsParsed).toBe(1);
    expect(firstMetrics?.failedFiles).toBe(0);
    expect(firstMetrics?.discovery.discoveryIndexMisses).toBe(1);
    expect(firstMetrics?.discovery.discoveryIndexHits).toBe(0);
    expect(firstMetrics?.discovery.firstLineReadsPlain).toBe(1);

    const restartedScanner = new CodexSessionScanner({
      sessionsDir,
      dataDir,
    });
    expect(await restartedScanner.listProjects()).toHaveLength(1);
    const restartedMetrics = restartedScanner.getLastScanMetrics();
    expect(restartedMetrics?.discovery.discoveryIndexMisses).toBe(0);
    expect(restartedMetrics?.discovery.discoveryIndexHits).toBe(1);
    expect(restartedMetrics?.discovery.firstLineReadsPlain).toBe(0);
    expect(restartedMetrics?.discovery.firstLineReadsZstd).toBe(0);
  });

  it("updates cached metadata when a plain rollout path is replaced", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    const dataDir = join(tmpdir(), `codex-data-${randomUUID()}`);
    tempDirs.push(sessionsDir, dataDir);

    const dateDir = join(sessionsDir, "2026", "06", "25");
    await mkdir(dateDir, { recursive: true });

    const id = randomUUID();
    const sessionPath = join(dateDir, `rollout-${id}.jsonl`);
    await writeFile(
      sessionPath,
      `${makeSessionMeta(id, "/home/user/project-before-replace")}\n`,
    );

    const scanner = new CodexSessionScanner({ sessionsDir, dataDir });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/home/user/project-before-replace");

    await rm(sessionPath);
    await writeFile(
      sessionPath,
      `${makeSessionMeta(id, "/home/user/project-after-replace", {
        cli_version: "0.94.0-alpha.10",
      })}\n`,
    );

    const restartedScanner = new CodexSessionScanner({ sessionsDir, dataDir });
    const restartedProjects = await restartedScanner.listProjects();
    expect(restartedProjects).toHaveLength(1);
    expect(restartedProjects[0].path).toBe(
      "/home/user/project-after-replace",
    );
  });

  it("rereads cached metadata when a plain rollout shrinks", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    const dataDir = join(tmpdir(), `codex-data-${randomUUID()}`);
    tempDirs.push(sessionsDir, dataDir);

    const dateDir = join(sessionsDir, "2026", "06", "25");
    await mkdir(dateDir, { recursive: true });

    const id = randomUUID();
    const sessionPath = join(dateDir, `rollout-${id}.jsonl`);
    const beforeMeta = makeSessionMeta(id, "/home/user/project-before-shrink");
    const largeEvent = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "x".repeat(5000),
      },
    });
    const beforeContent = `${beforeMeta}\n${largeEvent}\n`;
    await writeFile(sessionPath, beforeContent);

    const scanner = new CodexSessionScanner({ sessionsDir, dataDir });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/home/user/project-before-shrink");

    const afterMeta = makeSessionMeta(
      id,
      "/home/user/project-after-shrink-with-longer-name",
      { cli_version: "0.94.0-alpha.10" },
    );
    const afterContent = `${afterMeta}\n`;
    expect(Buffer.byteLength(afterContent)).toBeGreaterThanOrEqual(
      Buffer.byteLength(`${beforeMeta}\n`),
    );
    expect(Buffer.byteLength(afterContent)).toBeLessThan(
      Buffer.byteLength(beforeContent),
    );
    await writeFile(sessionPath, afterContent);

    const restartedScanner = new CodexSessionScanner({ sessionsDir, dataDir });
    const restartedProjects = await restartedScanner.listProjects();
    expect(restartedProjects).toHaveLength(1);
    expect(restartedProjects[0].path).toBe(
      "/home/user/project-after-shrink-with-longer-name",
    );
  });

  itIfNativeZstd("reconciles an indexed plain rollout after zstd compression", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    const dataDir = join(tmpdir(), `codex-data-${randomUUID()}`);
    tempDirs.push(sessionsDir, dataDir);

    const dateDir = join(sessionsDir, "2026", "06", "25");
    await mkdir(dateDir, { recursive: true });

    const id = randomUUID();
    const sessionPath = join(dateDir, `rollout-${id}.jsonl`);
    const sessionContent = `${makeSessionMeta(
      id,
      "/home/user/project-compressed-cache",
    )}\n{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}\n`;
    await writeFile(sessionPath, sessionContent);

    const scanner = new CodexSessionScanner({ sessionsDir, dataDir });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/home/user/project-compressed-cache");

    const index = createCodexSessionDiscoveryIndex(dataDir, sessionsDir);
    expect(index).toBeDefined();
    if (!index) return;

    const plainIdentity = getCodexRolloutDiscoveryIdentity(
      sessionsDir,
      sessionPath,
    );
    const shardPath = index.getShardPath(plainIdentity.shardKey);

    await writeFile(`${sessionPath}.zst`, zstdCompressed(sessionContent));
    await rm(sessionPath);

    const restartedScanner = new CodexSessionScanner({ sessionsDir, dataDir });
    const restartedProjects = await restartedScanner.listProjects();
    expect(restartedProjects).toHaveLength(1);
    expect(restartedProjects[0].path).toBe(
      "/home/user/project-compressed-cache",
    );
    const metrics = restartedScanner.getLastScanMetrics();
    expect(metrics?.compressedRolloutFiles).toBe(1);
    expect(metrics?.discovery.discoveryIndexHits).toBe(1);
    expect(metrics?.discovery.cacheBackedCompressedReads).toBe(1);
    expect(metrics?.discovery.representationTransitions).toBe(1);
    expect(metrics?.discovery.firstLineReadsZstd).toBe(0);

    const compressedIdentity = getCodexRolloutDiscoveryIdentity(
      sessionsDir,
      `${sessionPath}.zst`,
    );
    const after = JSON.parse(await readFile(shardPath, "utf-8")) as {
      records: Record<
        string,
        {
          relativePath: string;
          representation?: string;
          metadata: { cwd: string };
        }
      >;
    };
    const record = after.records[compressedIdentity.key];
    expect(record?.relativePath).toBe(compressedIdentity.relativePath);
    expect(record?.representation).toBe("zstd");
    expect(record?.metadata.cwd).toBe("/home/user/project-compressed-cache");
  });

  it("does not list deleted rollouts from the discovery index", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    const dataDir = join(tmpdir(), `codex-data-${randomUUID()}`);
    tempDirs.push(sessionsDir, dataDir);

    const dateDir = join(sessionsDir, "2026", "06", "25");
    await mkdir(dateDir, { recursive: true });

    const id = randomUUID();
    const sessionPath = join(dateDir, `rollout-${id}.jsonl`);
    await writeFile(
      sessionPath,
      `${makeSessionMeta(id, "/home/user/project-deleted")}\n`,
    );

    const scanner = new CodexSessionScanner({ sessionsDir, dataDir });
    expect(await scanner.listProjects()).toHaveLength(1);

    await rm(sessionPath);

    const restartedScanner = new CodexSessionScanner({ sessionsDir, dataDir });
    expect(await restartedScanner.listProjects()).toHaveLength(0);
  });

  it("skips empty files", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "01", "01");
    await mkdir(dateDir, { recursive: true });
    await writeFile(join(dateDir, "rollout-empty.jsonl"), "");

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(0);
  });

  it("skips files where first line is not session_meta", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "01", "01");
    await mkdir(dateDir, { recursive: true });
    await writeFile(
      join(dateDir, "rollout-bad.jsonl"),
      '{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}\n',
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(0);
  });

  it("returns empty when sessions directory does not exist", async () => {
    const scanner = new CodexSessionScanner({
      sessionsDir: join(tmpdir(), `nonexistent-${randomUUID()}`),
    });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(0);
  });

  it("returns sessions for a specific project path", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    const id1 = randomUUID();
    const id2 = randomUUID();
    await writeFile(
      join(dateDir, `rollout-${id1}.jsonl`),
      `${makeSessionMeta(id1, "/home/user/project-a")}\n`,
    );
    await writeFile(
      join(dateDir, `rollout-${id2}.jsonl`),
      `${makeSessionMeta(id2, "/home/user/project-b")}\n`,
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const sessions = await scanner.getSessionsForProject(
      "/home/user/project-a",
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(id1);
  });
});
