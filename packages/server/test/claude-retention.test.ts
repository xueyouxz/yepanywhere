import { describe, expect, it, vi } from "vitest";
import { ClaudeProviderRetentionTracker } from "../src/sdk/providers/claude-retention.js";
import type { SDKMessage } from "../src/sdk/types.js";

describe("ClaudeProviderRetentionTracker", () => {
  it("retains for Stop hook background tasks and session crons", () => {
    const onChange = vi.fn();
    const tracker = new ClaudeProviderRetentionTracker(onChange);

    tracker.observeStopHook({
      hook_event_name: "Stop",
      background_tasks: [{ id: "task-1" }],
      session_crons: [{ id: "cron-1" }],
    });

    expect(tracker.getSnapshot()).toMatchObject({
      retained: true,
      backgroundTaskCount: 1,
      sessionCronCount: 1,
      liveTaskCount: 0,
      reasons: ["stop-hook-background-tasks:1", "stop-hook-session-crons:1"],
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("settles terminal task updates and keeps unknown statuses conservative", () => {
    const tracker = new ClaudeProviderRetentionTracker();

    tracker.observeMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      session_id: "sess-1",
    } as SDKMessage);
    expect(tracker.getSnapshot()).toMatchObject({
      retained: true,
      liveTaskCount: 1,
    });

    tracker.observeMessage({
      type: "system",
      subtype: "task_updated",
      task_id: "task-1",
      patch: { status: "killed" },
      session_id: "sess-1",
    } as SDKMessage);
    expect(tracker.getSnapshot()).toMatchObject({
      retained: false,
      liveTaskCount: 0,
    });

    tracker.observeMessage({
      type: "system",
      subtype: "task_updated",
      task_id: "task-2",
      patch: { status: "mystery" },
      session_id: "sess-1",
    } as SDKMessage);
    expect(tracker.getSnapshot()).toMatchObject({
      retained: true,
      liveTaskCount: 1,
    });

    tracker.observeStopHook({
      hook_event_name: "Stop",
      background_tasks: [],
      session_crons: [],
    });
    expect(tracker.getSnapshot()).toMatchObject({
      retained: false,
      liveTaskCount: 0,
    });
  });
});
