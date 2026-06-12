import { memo, useRef, useState } from "react";
import { useOptionalSessionMetadata } from "../../contexts/SessionMetadataContext";
import { getPathBasename, makeDisplayPath } from "../../lib/text";
import {
  getLatestMessageTimestampMs,
  MESSAGE_STALE_THRESHOLD_MS,
} from "../../lib/messageAge";
import type { RenderItem, ToolCallItem } from "../../types/renderItems";
import { MessageAge } from "../MessageAge";
import { toolRegistry } from "../renderers/tools";
import type { RenderContext } from "../renderers/types";
import { getToolSummary } from "../tools/summaries";

const EXPLORATION_GROUP_MAX_GAP_MS = 5 * 60 * 1000;

type ExplorationKind = "read" | "search" | "list";

export type AssistantRenderSegment =
  | { kind: "item"; item: RenderItem }
  | { kind: "explored"; id: string; items: ToolCallItem[] };

interface Props {
  id: string;
  items: ToolCallItem[];
  sessionProvider?: string;
  staleNowMs?: number;
  latestVisibleTimestampMs?: number | null;
}

function getExplorationKind(toolName: string): ExplorationKind | null {
  const normalized = toolName.toLowerCase();
  const canonical = toolRegistry.get(toolName).tool;

  if (canonical === "Read" || normalized === "read") {
    return "read";
  }
  if (
    canonical === "Grep" ||
    normalized === "grep" ||
    normalized === "search" ||
    normalized === "grepsearch" ||
    normalized === "grep_search"
  ) {
    return "search";
  }
  if (
    canonical === "Glob" ||
    normalized === "glob" ||
    normalized === "ls" ||
    normalized === "list" ||
    normalized === "listdir" ||
    normalized === "list_dir" ||
    normalized === "list-dir"
  ) {
    return "list";
  }
  return null;
}

export function isExplorationToolCall(item: RenderItem): item is ToolCallItem {
  return (
    item.type === "tool_call" && getExplorationKind(item.toolName) !== null
  );
}

function timestampsAreTooFarApart(
  previous: ToolCallItem,
  next: ToolCallItem,
): boolean {
  const previousTimestampMs = getLatestMessageTimestampMs(
    previous.sourceMessages,
  );
  const nextTimestampMs = getLatestMessageTimestampMs(next.sourceMessages);
  if (previousTimestampMs === null || nextTimestampMs === null) {
    return false;
  }
  return (
    Math.abs(nextTimestampMs - previousTimestampMs) >
    EXPLORATION_GROUP_MAX_GAP_MS
  );
}

function makeExploredSegment(items: ToolCallItem[]): AssistantRenderSegment {
  const first = items[0];
  const last = items[items.length - 1];
  return {
    kind: "explored",
    id: `explored-${first?.id ?? "start"}-${last?.id ?? "end"}`,
    items,
  };
}

export function buildAssistantRenderSegments(
  items: RenderItem[],
): AssistantRenderSegment[] {
  const segments: AssistantRenderSegment[] = [];
  let run: ToolCallItem[] = [];

  const flushRun = () => {
    if (run.length >= 2) {
      segments.push(makeExploredSegment(run));
    } else if (run[0]) {
      segments.push({ kind: "item", item: run[0] });
    }
    run = [];
  };

  for (const item of items) {
    if (!isExplorationToolCall(item)) {
      flushRun();
      segments.push({ kind: "item", item });
      continue;
    }

    const previous = run[run.length - 1];
    if (previous && timestampsAreTooFarApart(previous, item)) {
      flushRun();
    }
    run.push(item);
  }

  flushRun();
  return segments;
}

function getGroupTimestampMs(items: ToolCallItem[]): number | null {
  let latest: number | null = null;
  for (const item of items) {
    const timestampMs = getLatestMessageTimestampMs(item.sourceMessages);
    if (timestampMs === null) {
      continue;
    }
    latest = latest === null ? timestampMs : Math.max(latest, timestampMs);
  }
  return latest;
}

function getDisplayLabel(toolName: string): string {
  const kind = getExplorationKind(toolName);
  if (kind === "search") {
    if (toolRegistry.get(toolName).tool === "Grep") {
      return "Grep";
    }
    return "Search";
  }
  if (kind === "list") {
    return "List";
  }
  return "Read";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(input: unknown, field: string): string {
  if (!isRecord(input)) {
    return "";
  }
  const value = input[field];
  return typeof value === "string" ? value.trim() : "";
}

function compactPath(
  path: string,
  projectPath: string | null | undefined,
): string {
  return makeDisplayPath(path, projectPath);
}

function getSearchSummary(
  input: unknown,
  projectPath: string | null | undefined,
): string {
  const pattern = stringField(input, "pattern") || stringField(input, "query");
  const path =
    stringField(input, "path") ||
    stringField(input, "target_directory") ||
    stringField(input, "directory");
  const glob = stringField(input, "glob");
  const scope = path || glob;
  if (pattern && scope) {
    return `${pattern} in ${path ? compactPath(path, projectPath) : glob}`;
  }
  return pattern || scope || "search";
}

function getListSummary(
  input: unknown,
  projectPath: string | null | undefined,
): string {
  const pattern = stringField(input, "pattern");
  const path =
    stringField(input, "path") ||
    stringField(input, "target_directory") ||
    stringField(input, "directory");
  if (pattern && path) {
    return `${pattern} in ${compactPath(path, projectPath)}`;
  }
  return path ? compactPath(path, projectPath) : pattern || "files";
}

function getFallbackSummary(
  item: ToolCallItem,
  projectPath: string | null | undefined,
): string {
  const kind = getExplorationKind(item.toolName);
  if (kind === "search") {
    return getSearchSummary(item.toolInput, projectPath);
  }
  if (kind === "list") {
    return getListSummary(item.toolInput, projectPath);
  }
  const filePath =
    stringField(item.toolInput, "file_path") ||
    stringField(item.toolInput, "target_file");
  return filePath
    ? getPathBasename(makeDisplayPath(filePath, projectPath))
    : "file";
}

export function getExploredEntrySearchPreview(
  item: ToolCallItem,
  projectPath?: string | null,
): string {
  const summary = getFallbackSummary(item, projectPath);
  return summary
    ? `${getDisplayLabel(item.toolName)}: ${summary}`
    : getDisplayLabel(item.toolName);
}

export function getExploredEntrySearchText(
  item: ToolCallItem,
  projectPath?: string | null,
): string {
  const parts = [
    getDisplayLabel(item.toolName),
    getFallbackSummary(item, projectPath),
    getToolSummary(
      item.toolName,
      item.toolInput,
      item.toolResult,
      item.status,
      {
        projectPath,
      },
    ),
  ];
  return Array.from(
    new Set(parts.map((part) => part.trim()).filter(Boolean)),
  ).join("\n");
}

function statusGlyph(status: ToolCallItem["status"]): string {
  switch (status) {
    case "pending":
      return ".";
    case "error":
      return "!";
    case "aborted":
      return "x";
    case "incomplete":
      return "?";
    case "complete":
      return "";
  }
}

function renderEntrySummary(
  item: ToolCallItem,
  sessionProvider: string | undefined,
  projectPath: string | null | undefined,
) {
  const kind = getExplorationKind(item.toolName);
  const result = item.toolResult?.structured ?? item.toolResult?.content;
  const isComplete = item.status === "complete";
  const isError = item.toolResult?.isError ?? item.status === "error";
  const context: RenderContext = {
    isStreaming: item.status === "pending",
    theme: "dark",
    toolUseId: item.id,
    provider: sessionProvider,
    projectPath,
  };

  if (
    (kind === "read" || kind === "search") &&
    isComplete &&
    toolRegistry.hasInteractiveSummary(item.toolName)
  ) {
    const summary = toolRegistry.renderInteractiveSummary(
      item.toolName,
      item.toolInput,
      result,
      isError,
      context,
    );
    if (summary) {
      return summary;
    }
  }

  if (isComplete && (kind === "search" || kind === "list")) {
    return getToolSummary(
      item.toolName,
      item.toolInput,
      item.toolResult,
      item.status,
      { projectPath },
    );
  }

  return getFallbackSummary(item, projectPath);
}

export const ExploredToolGroup = memo(function ExploredToolGroup({
  id,
  items,
  sessionProvider,
  staleNowMs,
  latestVisibleTimestampMs,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const sessionMetadata = useOptionalSessionMetadata();
  const projectPath = sessionMetadata?.projectPath ?? null;
  const staticAgeNowMsRef = useRef(Date.now());
  const timestampMs = getGroupTimestampMs(items);
  const hasTimestamp = timestampMs !== null;
  const isLatestVisibleTimestamp =
    hasTimestamp && latestVisibleTimestampMs === timestampMs;
  const ageNowMs = isLatestVisibleTimestamp
    ? (staleNowMs ?? Date.now())
    : staticAgeNowMsRef.current;
  const showAgeByDefault =
    isLatestVisibleTimestamp &&
    ageNowMs !== null &&
    timestampMs !== null &&
    ageNowMs - timestampMs >= MESSAGE_STALE_THRESHOLD_MS;
  const toggleLabel = expanded
    ? "Collapse explored tools"
    : "Expand explored tools";

  return (
    <div
      className={[
        "message-render-row",
        "explored-message-row",
        hasTimestamp ? "has-message-age" : "",
        showAgeByDefault ? "is-message-age-visible" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-render-type="explored"
      data-render-id={id}
    >
      <div className="message-render-content">
        <div className="explored-group timeline-item">
          <button
            type="button"
            className="timeline-dot-btn"
            onClick={() => setExpanded((value) => !value)}
            aria-label={toggleLabel}
            title={toggleLabel}
          />
          <button
            type="button"
            className="explored-group-header"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <span className="explored-group-title">Explored</span>
            <span className="explored-group-count">
              {items.length} {items.length === 1 ? "item" : "items"}
            </span>
            <span className="expand-chevron" aria-hidden="true">
              {expanded ? "▾" : "▸"}
            </span>
          </button>
          {expanded && (
            <div className="explored-group-body" role="list">
              {items.map((item) => (
                <div
                  key={item.id}
                  className={`explored-entry status-${item.status}`}
                  data-render-id={item.id}
                  data-render-type={item.type}
                  role="listitem"
                >
                  <span className="explored-entry-status" aria-hidden="true">
                    {statusGlyph(item.status)}
                  </span>
                  <span className="explored-entry-tool">
                    {getDisplayLabel(item.toolName)}
                  </span>
                  <span className="explored-entry-summary">
                    {renderEntrySummary(item, sessionProvider, projectPath)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <MessageAge timestampMs={timestampMs} nowMs={ageNowMs ?? Date.now()} />
    </div>
  );
});
