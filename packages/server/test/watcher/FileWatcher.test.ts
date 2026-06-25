import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus, type FileChangeEvent } from "../../src/watcher/EventBus.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";

interface FileWatcherTestAccess {
  rescanInProgress: boolean;
  rescanAndEmit(reason: "fallback" | "periodic"): void;
}

function forceRescan(
  watcher: FileWatcher,
  reason: "fallback" | "periodic" = "fallback",
): void {
  (watcher as unknown as FileWatcherTestAccess).rescanAndEmit(reason);
}

describe("FileWatcher", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("records fallback rescan metrics and emitted change counts", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    const dateDir = join(watchDir, "2026", "06", "25");
    await mkdir(dateDir, { recursive: true });

    const keepPath = join(dateDir, "rollout-keep.jsonl");
    const deletePath = join(dateDir, "rollout-delete.jsonl");
    const createPath = join(dateDir, "rollout-create.jsonl");
    await writeFile(keepPath, "{}\n");
    await writeFile(deletePath, "{}\n");

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });

    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus,
      rescanSlowLogThresholdMs: 60_000,
    });

    forceRescan(watcher);
    expect(events.map((event) => event.changeType).sort()).toEqual([
      "create",
      "create",
    ]);

    events.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(keepPath, "{\"changed\":true}\n");
    await writeFile(createPath, "{}\n");
    await rm(deletePath);

    forceRescan(watcher);

    expect(events.map((event) => event.changeType).sort()).toEqual([
      "create",
      "delete",
      "modify",
    ]);
    expect(events.every((event) => event.fileType === "session")).toBe(true);

    const metrics = watcher.getLastRescanMetrics();
    expect(metrics).toMatchObject({
      provider: "codex",
      watchDir,
      reason: "fallback",
      knownFilesBefore: 2,
      currentFiles: 2,
      knownFilesAfter: 2,
      createEvents: 1,
      modifyEvents: 1,
      deleteEvents: 1,
      emittedEvents: 3,
      sessionEvents: 3,
      agentSessionEvents: 0,
      otherEvents: 0,
      directoryReadErrors: 0,
      statFailures: 0,
    });
    expect(metrics?.directoriesVisited).toBeGreaterThanOrEqual(4);
    expect(metrics?.filesScanned).toBe(2);
    expect(metrics?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records overlap skips on the next completed rescan", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    await mkdir(watchDir, { recursive: true });

    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus: new EventBus(),
      rescanSlowLogThresholdMs: 60_000,
    });
    const internals = watcher as unknown as FileWatcherTestAccess;

    internals.rescanInProgress = true;
    forceRescan(watcher, "periodic");
    internals.rescanInProgress = false;

    forceRescan(watcher, "periodic");

    expect(watcher.getLastRescanMetrics()).toMatchObject({
      reason: "periodic",
      overlapSkipsSinceLast: 1,
      overlapSkipsTotal: 1,
    });
  });
});
