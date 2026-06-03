import { describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import { EventBus, type BusEvent } from "../../src/watcher/EventBus.js";

describe("ExternalSessionTracker", () => {
  it("does not mark owned active Claude sessions external on file changes", async () => {
    const eventBus = new EventBus();
    const events: BusEvent[] = [];
    eventBus.subscribe((event) => events.push(event));

    const projectId = encodeProjectId("/tmp/test");
    const supervisor = {
      getProcessForSession: vi.fn((sessionId: string) =>
        sessionId === "owned-active-session"
          ? { projectId, state: { type: "in-turn" } }
          : undefined,
      ),
    } as unknown as Supervisor;
    const scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
    } as unknown as ProjectScanner;

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 100,
    });

    try {
      eventBus.emit({
        type: "file-change",
        provider: "claude",
        path: "/tmp/projects/-tmp-test/owned-active-session.jsonl",
        relativePath: "-tmp-test/owned-active-session.jsonl",
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });

      await Promise.resolve();

      expect(tracker.isExternal("owned-active-session")).toBe(false);
      expect(scanner.getProjectBySessionDirSuffix).not.toHaveBeenCalled();
      expect(
        events.some(
          (event) =>
            event.type === "session-status-changed" &&
            event.sessionId === "owned-active-session" &&
            event.ownership.owner === "external",
        ),
      ).toBe(false);
    } finally {
      tracker.dispose();
    }
  });

  it("does not mark recently aborted Claude sessions external on file changes", async () => {
    const eventBus = new EventBus();
    const projectId = encodeProjectId("/tmp/test");
    const supervisor = {
      getProcessForSession: vi.fn(() => undefined),
    } as unknown as Supervisor;
    const scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
    } as unknown as ProjectScanner;

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 100,
      abortGraceMs: 1000,
    });

    try {
      eventBus.emit({
        type: "session-aborted",
        sessionId: "idle-reaped-session",
        projectId,
        timestamp: new Date().toISOString(),
      });
      eventBus.emit({
        type: "file-change",
        provider: "claude",
        path: "/tmp/projects/-tmp-test/idle-reaped-session.jsonl",
        relativePath: "-tmp-test/idle-reaped-session.jsonl",
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });

      await Promise.resolve();

      expect(tracker.isExternal("idle-reaped-session")).toBe(false);
      expect(scanner.getProjectBySessionDirSuffix).not.toHaveBeenCalled();
    } finally {
      tracker.dispose();
    }
  });
});
