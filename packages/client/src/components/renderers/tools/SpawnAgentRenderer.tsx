import { useContext, useState } from "react";
import { AgentContentContext } from "../../../contexts/AgentContentContext";
import { useSessionMetadata } from "../../../contexts/SessionMetadataContext";
import type { ToolCallItem } from "../../../types/renderItems";
import type { ToolRenderer } from "./types";
import { Spinner, TaskNestedContent } from "./TaskRenderer";

interface SpawnAgentInput {
  description?: string;
  prompt?: string;
  message?: string;
  task?: string;
  objective?: string;
  role?: string;
  agent_role?: string;
  agent_type?: string;
  subagent_type?: string;
  model?: string;
}

interface SpawnAgentResult {
  agentId?: string;
  nickname?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSpawnAgentResult(result: unknown): SpawnAgentResult | null {
  const record =
    typeof result === "string"
      ? parseJsonRecord(result)
      : isRecord(result)
        ? result
        : null;

  if (!record) {
    return null;
  }

  return {
    agentId: stringField(record, "agent_id") ?? stringField(record, "agentId"),
    nickname: stringField(record, "nickname"),
  };
}

function compactText(value: string | undefined, fallback: string): string {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) {
    return fallback;
  }
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function spawnAgentTitle(
  input: SpawnAgentInput,
  result: SpawnAgentResult | null,
): string {
  return compactText(
    result?.nickname ??
      input.description ??
      input.task ??
      input.objective ??
      input.message ??
      input.prompt,
    "Codex subagent",
  );
}

function spawnAgentType(input: SpawnAgentInput): string {
  return (
    input.agent_type ??
    input.subagent_type ??
    input.agent_role ??
    input.role ??
    "agent"
  );
}

function statusBadge({
  isError,
  status,
  childStatus,
  hasResult,
}: {
  isError: boolean;
  status: ToolCallItem["status"];
  childStatus?: string;
  hasResult: boolean;
}): { className: string; text: string; isRunning: boolean } {
  if (isError) {
    return { className: "badge-error", text: "failed", isRunning: false };
  }
  if (status === "aborted") {
    return {
      className: "badge-warning",
      text: "interrupted",
      isRunning: false,
    };
  }
  if (status === "incomplete") {
    return {
      className: "badge-warning",
      text: "result unavailable",
      isRunning: false,
    };
  }
  if (childStatus === "failed") {
    return { className: "badge-error", text: "failed", isRunning: false };
  }
  if (childStatus === "running" || (!hasResult && status === "pending")) {
    return { className: "badge-running", text: "running", isRunning: true };
  }
  if (childStatus === "completed") {
    return { className: "badge-success", text: "completed", isRunning: false };
  }
  if (hasResult) {
    return { className: "badge-success", text: "spawned", isRunning: false };
  }
  return { className: "badge-pending", text: "pending", isRunning: false };
}

function SpawnAgentInline({
  input,
  result,
  isError,
  status,
  toolUseId,
}: {
  input: SpawnAgentInput;
  result: unknown;
  isError: boolean;
  status: ToolCallItem["status"];
  toolUseId?: string;
}) {
  const { projectId, sessionId } = useSessionMetadata();
  const context = useContext(AgentContentContext);
  const parsedResult = normalizeSpawnAgentResult(result);
  const agentId =
    parsedResult?.agentId ??
    (toolUseId ? context?.toolUseToAgent.get(toolUseId) : undefined);
  const liveContent = agentId ? context?.agentContent[agentId] : undefined;
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const badge = statusBadge({
    isError,
    status,
    childStatus: liveContent?.status,
    hasResult: result !== undefined,
  });

  const handleExpand = async () => {
    const hasLiveContent =
      liveContent?.messages && liveContent.messages.length > 0;
    if (!isExpanded && agentId && context && !hasLiveContent) {
      setIsExpanded(true);
      setIsLoadingContent(true);
      try {
        await context.loadAgentContent(projectId, sessionId, agentId);
      } finally {
        setIsLoadingContent(false);
      }
      return;
    }

    setIsExpanded((current) => !current);
  };

  const title = spawnAgentTitle(input, parsedResult);

  return (
    <div
      className={`task-inline ${isExpanded ? "expanded" : "collapsed"} status-${badge.text}`}
    >
      <button
        type="button"
        className="task-inline-header"
        onClick={handleExpand}
      >
        <span className="task-expand-icon">{isExpanded ? "▼" : "▶"}</span>
        <span className="badge badge-info task-agent-type">
          {spawnAgentType(input)}
        </span>
        <span className="task-inline-title">{title}</span>
        {input.model && <span className="badge task-model">{input.model}</span>}
        {badge.isRunning ? (
          <span className="task-spinner" role="status" aria-label="Running">
            <Spinner />
          </span>
        ) : (
          <span className={`badge ${badge.className}`}>{badge.text}</span>
        )}
      </button>

      {isLoadingContent && (
        <div className="task-loading">
          <Spinner /> Loading agent content...
        </div>
      )}

      {isExpanded && (
        <div className="task-inline-content">
          {liveContent?.messages.length ? (
            <TaskNestedContent
              messages={liveContent.messages}
              isStreaming={liveContent.status === "running"}
            />
          ) : agentId ? (
            <div className="task-empty">No content</div>
          ) : (
            <div className="task-empty">No agent session found</div>
          )}
        </div>
      )}
    </div>
  );
}

export const spawnAgentRenderer: ToolRenderer<SpawnAgentInput, unknown> = {
  tool: "spawn_agent",
  displayName: "Spawn agent",
  pendingDisplayName: "Spawning agent",

  renderToolUse(input) {
    return <div className="todo-summary">{spawnAgentTitle(input, null)}</div>;
  },

  renderToolResult(result, isError) {
    const parsed = normalizeSpawnAgentResult(result);
    return (
      <div className={isError ? "todo-error" : "todo-summary"}>
        {parsed?.agentId ? `Agent ${parsed.agentId}` : "Agent spawned"}
      </div>
    );
  },

  getUseSummary(input) {
    return spawnAgentTitle(input, null);
  },

  getResultSummary(result, isError) {
    if (isError) {
      return "Error";
    }
    const parsed = normalizeSpawnAgentResult(result);
    return parsed?.agentId ? `Agent ${parsed.agentId}` : "Spawned";
  },

  renderInline(input, result, isError, status, context) {
    return (
      <SpawnAgentInline
        input={input}
        result={result}
        isError={isError}
        status={status}
        toolUseId={context.toolUseId}
      />
    );
  },
};
