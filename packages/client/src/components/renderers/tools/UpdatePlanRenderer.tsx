import type {
  ToolRenderer,
  UpdatePlanInput,
  UpdatePlanResult,
  UpdatePlanStep,
} from "./types";

type NormalizedPlanStatus = "pending" | "in_progress" | "completed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePlanStatus(status: unknown): NormalizedPlanStatus {
  if (typeof status !== "string") {
    return "pending";
  }

  const normalized = status.trim().toLowerCase();
  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "done"
  ) {
    return "completed";
  }
  if (
    normalized === "in_progress" ||
    normalized === "in-progress" ||
    normalized === "active" ||
    normalized === "running"
  ) {
    return "in_progress";
  }
  return "pending";
}

function getStatusIcon(status: NormalizedPlanStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    default:
      return "○";
  }
}

function statusClassName(status: NormalizedPlanStatus): string {
  return status === "in_progress"
    ? "todo-status-in-progress"
    : `todo-status-${status}`;
}

function extractPlanSteps(input: unknown): Array<{
  step: string;
  status: NormalizedPlanStatus;
}> {
  if (!isRecord(input) || !Array.isArray(input.plan)) {
    return [];
  }

  return input.plan
    .filter(
      (item): item is UpdatePlanStep =>
        isRecord(item) && typeof item.step === "string",
    )
    .map((item) => ({
      step: item.step,
      status: normalizePlanStatus(item.status),
    }));
}

function extractExplanation(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.explanation !== "string") {
    return undefined;
  }
  const explanation = input.explanation.trim();
  return explanation.length > 0 ? explanation : undefined;
}

function extractResultMessage(result: unknown): string | undefined {
  if (typeof result === "string") {
    const message = result.trim();
    return message.length > 0 ? message : undefined;
  }

  if (isRecord(result) && typeof result.message === "string") {
    const message = result.message.trim();
    return message.length > 0 ? message : undefined;
  }

  return undefined;
}

export const updatePlanRenderer: ToolRenderer<
  UpdatePlanInput,
  UpdatePlanResult
> = {
  tool: "UpdatePlan",
  displayName: "Update plan",

  renderToolUse() {
    return null;
  },

  renderToolResult() {
    return null;
  },

  renderInline(input, result, isError, status) {
    const steps = extractPlanSteps(input);
    const explanation = extractExplanation(input);
    const resultMessage = extractResultMessage(result);

    if (isError) {
      return (
        <div className="todo-error">
          {resultMessage || "Failed to update plan"}
        </div>
      );
    }

    if (steps.length === 0) {
      if (status === "pending") {
        return <div className="todo-summary">Updating plan...</div>;
      }
      return (
        <div className="todo-summary">{resultMessage || "Plan updated"}</div>
      );
    }

    const completed = steps.filter(
      (step) => step.status === "completed",
    ).length;

    return (
      <div className="todo-result">
        <div className="todo-summary">
          {completed} out of {steps.length} tasks completed
        </div>
        {explanation && <div className="todo-summary">{explanation}</div>}
        <div className="todo-list">
          {steps.map((step, index) => (
            <div
              key={`${step.step}-${index}`}
              className={`todo-item ${statusClassName(step.status)}`}
            >
              <span className="todo-checkbox">
                {getStatusIcon(step.status)}
              </span>
              <span
                className={`todo-content ${step.status === "completed" ? "todo-completed" : ""}`}
              >
                {index + 1}. {step.step}
              </span>
            </div>
          ))}
        </div>
        {status !== "pending" &&
          resultMessage &&
          resultMessage.toLowerCase() !== "plan updated" && (
            <div className="todo-summary">{resultMessage}</div>
          )}
      </div>
    );
  },

  getUseSummary(input) {
    const steps = extractPlanSteps(input);
    if (steps.length === 0) {
      return "Update plan";
    }
    const completed = steps.filter(
      (step) => step.status === "completed",
    ).length;
    return `${completed}/${steps.length} complete`;
  },

  getResultSummary(result, isError) {
    if (isError) {
      return "Error";
    }
    return extractResultMessage(result) || "Plan updated";
  },
};
