import type { ToolRenderer } from "./types";

const TASK_SNAPSHOT_FIELD = "_taskSnapshot";

type TaskListStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

interface TaskListSnapshotItem {
  id: string;
  subject: string;
  status: TaskListStatus | string;
  description?: string;
  activeForm?: string;
  missingCreate?: boolean;
}

interface TaskListSnapshot {
  version: 1;
  tasks: TaskListSnapshotItem[];
  currentTaskId?: string;
  sourceToolUseId?: string;
  unresolvedTaskIds?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(input: unknown, field: string): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const value = input[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractSnapshot(value: unknown): TaskListSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const snapshot = value[TASK_SNAPSHOT_FIELD];
  if (
    !isRecord(snapshot) ||
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.tasks)
  ) {
    return undefined;
  }
  return snapshot as unknown as TaskListSnapshot;
}

function taskId(input: unknown): string | undefined {
  return (
    stringField(input, "taskId") ??
    stringField(input, "task_id") ??
    stringField(input, "id")
  );
}

function normalizeStatus(status: unknown): TaskListStatus {
  if (typeof status !== "string") {
    return "unknown";
  }
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "completed" || normalized === "complete") {
    return "completed";
  }
  if (normalized === "in_progress" || normalized === "running") {
    return "in_progress";
  }
  if (normalized === "pending" || normalized === "todo") {
    return "pending";
  }
  if (normalized === "failed" || normalized === "error") {
    return "failed";
  }
  if (normalized === "cancelled" || normalized === "canceled") {
    return "cancelled";
  }
  return "unknown";
}

function statusIcon(status: TaskListStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    case "failed":
      return "!";
    case "cancelled":
      return "×";
    default:
      return "○";
  }
}

function statusClassName(status: TaskListStatus): string {
  return status === "in_progress"
    ? "todo-status-in-progress"
    : `todo-status-${status}`;
}

function taskLabel(task: TaskListSnapshotItem): string {
  if (task.subject?.trim()) {
    return task.subject.trim();
  }
  return task.id ? `Task #${task.id}` : "Task";
}

function completedCount(tasks: TaskListSnapshotItem[]): number {
  return tasks.filter((task) => normalizeStatus(task.status) === "completed")
    .length;
}

function TaskSnapshotView({ snapshot }: { snapshot: TaskListSnapshot }) {
  const tasks = snapshot.tasks;
  const done = completedCount(tasks);

  return (
    <div className="todo-result">
      <div className="todo-summary">
        {done} out of {tasks.length} tasks completed
      </div>
      <div className="todo-list">
        {tasks.map((task) => {
          const status = normalizeStatus(task.status);
          const isCompleted = status === "completed";
          const display = taskLabel(task);
          return (
            <div
              key={task.id || display}
              className={`todo-item ${statusClassName(status)}`}
            >
              <span className="todo-checkbox">{statusIcon(status)}</span>
              <span
                className={`todo-content ${isCompleted ? "todo-completed" : ""}`}
              >
                {display}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function eventMessage(toolName: "TaskCreate" | "TaskUpdate", input: unknown) {
  if (toolName === "TaskCreate") {
    return stringField(input, "subject") ?? "Task created";
  }

  const id = taskId(input);
  const status = normalizeStatus(stringField(input, "status"));
  const statusText = status === "unknown" ? "updated" : status.replace("_", " ");
  return id ? `Task #${id} ${statusText}` : `Task ${statusText}`;
}

function resultMessage(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result.trim() || undefined;
  }
  if (!isRecord(result)) {
    return undefined;
  }
  const content = result.content;
  return typeof content === "string" && content.trim()
    ? content.trim()
    : undefined;
}

function renderTaskEvent(
  toolName: "TaskCreate" | "TaskUpdate",
  input: unknown,
  result: unknown,
  isError: boolean,
) {
  const snapshot = extractSnapshot(result) ?? extractSnapshot(input);
  if (!isError && snapshot && snapshot.tasks.length > 0) {
    return <TaskSnapshotView snapshot={snapshot} />;
  }

  if (isError) {
    return (
      <div className="todo-error">
        {resultMessage(result) ?? "Task update failed"}
      </div>
    );
  }

  return <div className="todo-summary">{eventMessage(toolName, input)}</div>;
}

function taskSummary(
  toolName: "TaskCreate" | "TaskUpdate",
  input: unknown,
  result?: unknown,
): string {
  const snapshot = extractSnapshot(result) ?? extractSnapshot(input);
  if (snapshot?.tasks.length) {
    return `${completedCount(snapshot.tasks)}/${snapshot.tasks.length} complete`;
  }
  return eventMessage(toolName, input);
}

export const taskCreateRenderer: ToolRenderer<unknown, unknown> = {
  tool: "TaskCreate",
  displayName: "Create task",

  renderToolUse(input) {
    return <div className="todo-summary">{eventMessage("TaskCreate", input)}</div>;
  },

  renderToolResult(result, isError, _context, input) {
    return renderTaskEvent("TaskCreate", input, result, isError);
  },

  renderInline(input, result, isError) {
    return renderTaskEvent("TaskCreate", input, result, isError);
  },

  getUseSummary(input) {
    return taskSummary("TaskCreate", input);
  },

  getResultSummary(result, isError, input) {
    return isError ? "Error" : taskSummary("TaskCreate", input, result);
  },
};

export const taskUpdateRenderer: ToolRenderer<unknown, unknown> = {
  tool: "TaskUpdate",
  displayName: "Update task",

  renderToolUse(input) {
    return <div className="todo-summary">{eventMessage("TaskUpdate", input)}</div>;
  },

  renderToolResult(result, isError, _context, input) {
    return renderTaskEvent("TaskUpdate", input, result, isError);
  },

  renderInline(input, result, isError) {
    return renderTaskEvent("TaskUpdate", input, result, isError);
  },

  getUseSummary(input) {
    return taskSummary("TaskUpdate", input);
  },

  getResultSummary(result, isError, input) {
    return isError ? "Error" : taskSummary("TaskUpdate", input, result);
  },
};
