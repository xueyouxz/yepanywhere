import type { ProviderRetentionSnapshot, SDKMessage } from "../types.js";

type StopHookLike = {
  hook_event_name?: unknown;
  background_tasks?: unknown;
  session_crons?: unknown;
};

type TaskPatchLike = {
  status?: unknown;
  is_backgrounded?: unknown;
};

interface RetainedTask {
  status: string;
  isBackgrounded?: boolean;
}

const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "killed",
  "stopped",
]);

function readTaskId(message: SDKMessage): string | null {
  return typeof message.task_id === "string" && message.task_id
    ? message.task_id
    : null;
}

function readTaskPatch(message: SDKMessage): TaskPatchLike | null {
  const patch = message.patch;
  return patch && typeof patch === "object" ? patch : null;
}

function isStopHookInput(input: unknown): input is StopHookLike {
  return (
    !!input &&
    typeof input === "object" &&
    (input as StopHookLike).hook_event_name === "Stop"
  );
}

export class ClaudeProviderRetentionTracker {
  private stopBackgroundTaskCount = 0;
  private stopSessionCronCount = 0;
  private retainedTasks = new Map<string, RetainedTask>();
  private lastUpdatedAt: Date | null = null;

  constructor(private readonly onChange?: () => void) {}

  getSnapshot(): ProviderRetentionSnapshot {
    const reasons: string[] = [];
    if (this.stopBackgroundTaskCount > 0) {
      reasons.push(
        `stop-hook-background-tasks:${this.stopBackgroundTaskCount}`,
      );
    }
    if (this.stopSessionCronCount > 0) {
      reasons.push(`stop-hook-session-crons:${this.stopSessionCronCount}`);
    }
    if (this.retainedTasks.size > 0) {
      reasons.push(`sdk-live-tasks:${this.retainedTasks.size}`);
    }

    return {
      retained: reasons.length > 0,
      reasons,
      backgroundTaskCount: this.stopBackgroundTaskCount,
      sessionCronCount: this.stopSessionCronCount,
      liveTaskCount: this.retainedTasks.size,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  observeStopHook(input: unknown): void {
    if (!isStopHookInput(input)) {
      return;
    }

    const previous = this.snapshotKey();
    const backgroundTasks = Array.isArray(input.background_tasks)
      ? input.background_tasks
      : null;
    const sessionCrons = Array.isArray(input.session_crons)
      ? input.session_crons
      : null;

    if (backgroundTasks === null && sessionCrons === null) {
      return;
    }

    if (backgroundTasks !== null) {
      this.stopBackgroundTaskCount = backgroundTasks.length;
    }
    if (sessionCrons !== null) {
      this.stopSessionCronCount = sessionCrons.length;
    }
    if (
      backgroundTasks !== null &&
      sessionCrons !== null &&
      backgroundTasks.length === 0 &&
      sessionCrons.length === 0
    ) {
      this.retainedTasks.clear();
    }
    this.markUpdated(previous);
  }

  observeMessage(message: SDKMessage): void {
    if (message.type !== "system") {
      return;
    }

    switch (message.subtype) {
      case "task_started":
        this.retainTaskFromMessage(message, "running");
        break;
      case "task_progress":
        this.retainTaskFromMessage(message, "running");
        break;
      case "task_updated":
        this.observeTaskUpdated(message);
        break;
      case "task_notification":
        this.clearTaskFromMessage(message);
        break;
    }
  }

  private retainTaskFromMessage(message: SDKMessage, status: string): void {
    const taskId = readTaskId(message);
    if (!taskId) {
      return;
    }

    const previous = this.snapshotKey();
    this.retainedTasks.set(taskId, {
      status,
      isBackgrounded: this.retainedTasks.get(taskId)?.isBackgrounded,
    });
    this.markUpdated(previous);
  }

  private observeTaskUpdated(message: SDKMessage): void {
    const taskId = readTaskId(message);
    const patch = readTaskPatch(message);
    if (!taskId || !patch) {
      return;
    }

    const status = typeof patch.status === "string" ? patch.status : undefined;
    if (status && TERMINAL_TASK_STATUSES.has(status)) {
      this.clearTask(taskId);
      return;
    }

    const existing = this.retainedTasks.get(taskId);
    const shouldRetain =
      !!status ||
      patch.is_backgrounded === true ||
      (patch.is_backgrounded === false && !!existing);
    if (!shouldRetain) {
      return;
    }

    const previous = this.snapshotKey();
    this.retainedTasks.set(taskId, {
      status: status ?? existing?.status ?? "unknown",
      isBackgrounded:
        typeof patch.is_backgrounded === "boolean"
          ? patch.is_backgrounded
          : existing?.isBackgrounded,
    });
    this.markUpdated(previous);
  }

  private clearTaskFromMessage(message: SDKMessage): void {
    const taskId = readTaskId(message);
    if (!taskId) {
      return;
    }
    this.clearTask(taskId);
  }

  private clearTask(taskId: string): void {
    if (!this.retainedTasks.has(taskId)) {
      return;
    }

    const previous = this.snapshotKey();
    this.retainedTasks.delete(taskId);
    this.markUpdated(previous);
  }

  private markUpdated(previousKey: string): void {
    this.lastUpdatedAt = new Date();
    if (this.snapshotKey() !== previousKey) {
      this.onChange?.();
    }
  }

  private snapshotKey(): string {
    const tasks = Array.from(this.retainedTasks.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([id, task]) =>
          `${id}:${task.status}:${task.isBackgrounded === true ? "bg" : "fg"}`,
      )
      .join(",");
    return [
      this.stopBackgroundTaskCount,
      this.stopSessionCronCount,
      tasks,
    ].join("|");
  }
}
