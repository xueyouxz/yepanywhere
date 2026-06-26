import { memo, useCallback, useRef } from "react";
import {
  MESSAGE_STALE_THRESHOLD_MS,
  getLatestMessageTimestampMs,
} from "../lib/messageAge";
import type { CommentAnchor } from "../lib/commentAnchors";
import type { ContentBlock } from "../types";
import type { RenderItem } from "../types/renderItems";
import { MessageAge } from "./MessageAge";
import { ForkSummaryDisplayObject } from "./ForkSummaryDisplayObject";
import { SessionSetupBlock } from "./blocks/SessionSetupBlock";
import { TaskNotificationBlock } from "./blocks/TaskNotificationBlock";
import { TextBlock } from "./blocks/TextBlock";
import { ThinkingBlock } from "./blocks/ThinkingBlock";
import { ToolCallRow } from "./blocks/ToolCallRow";
import { UserPromptBlock } from "./blocks/UserPromptBlock";

interface Props {
  item: RenderItem;
  isStreaming: boolean;
  thinkingExpanded: boolean;
  toggleThinkingExpanded: () => void;
  sessionProvider?: string;
  onCorrectUserPrompt?: () => void;
  onTrimBeforeUserPrompt?: () => void;
  onForkBeforeUserPrompt?: () => void;
  onQuoteTextBlock?: (anchor: CommentAnchor) => void;
  alwaysShowQuoteCircle?: boolean;
  staleNowMs?: number;
  latestVisibleTimestampMs?: number | null;
  thinkingDurationMs?: number;
  getForkSummaryTargetHref?: (targetSessionId: string) => string;
  onCancelForkSummary?: (objectId: string) => void;
  onToggleForkSummaryAutoOpen?: (objectId: string, value: boolean) => void;
  onFollowForkSummary?: (objectId: string) => void;
}

function getMessageIdLike(message: Record<string, unknown>): string {
  if (typeof message.uuid === "string" && message.uuid.length > 0) {
    return message.uuid;
  }
  if (typeof message.id === "string" && message.id.length > 0) {
    return message.id;
  }
  return "<missing>";
}

function summarizeSourceMessages(messages: RenderItem["sourceMessages"]) {
  const bySource: Record<string, number> = {
    sdk: 0,
    jsonl: 0,
    unknown: 0,
  };
  const byType: Record<string, number> = {};
  const ids: string[] = [];
  let streamEventCount = 0;
  let streamingPlaceholderCount = 0;

  for (const message of messages) {
    const source =
      message._source === "sdk" || message._source === "jsonl"
        ? message._source
        : "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;

    const type = typeof message.type === "string" ? message.type : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    if (type === "stream_event") {
      streamEventCount++;
    }
    if (message._isStreaming) {
      streamingPlaceholderCount++;
    }

    ids.push(getMessageIdLike(message as Record<string, unknown>));
  }

  return {
    total: messages.length,
    bySource,
    byType,
    streamEventCount,
    streamingPlaceholderCount,
    ids,
  };
}

function buildDebugSnapshot(
  item: RenderItem,
  props: {
    isStreaming: boolean;
    thinkingExpanded: boolean;
    sessionProvider?: string;
  },
) {
  const sourceSummary = summarizeSourceMessages(item.sourceMessages);

  return {
    render: {
      id: item.id,
      type: item.type,
      isSubagent: item.isSubagent ?? false,
    },
    uiContext: {
      sessionProvider: props.sessionProvider ?? "unknown",
      sessionIsStreaming: props.isStreaming,
      thinkingExpanded: props.thinkingExpanded,
    },
    itemContext:
      item.type === "tool_call"
        ? {
            toolName: item.toolName,
            status: item.status,
            hasToolResult: Boolean(item.toolResult),
            hasStructuredResult: item.toolResult?.structured !== undefined,
            toolUseId: item.id,
          }
        : item.type === "text"
          ? {
              isStreamingTextBlock: item.isStreaming ?? false,
              hasAugmentHtml: Boolean(item.augmentHtml),
            }
          : item.type === "thinking"
            ? {
                status: item.status,
                thinkingLength: item.thinking.length,
              }
            : item.type === "system"
              ? {
                  subtype: item.subtype,
                  status: item.status ?? null,
                }
              : item.type === "session_setup"
                ? {
                    promptCount: item.prompts.length,
                  }
                : null,
    sourceSummary,
    sourceMessages: item.sourceMessages,
    renderItem: item,
  };
}

function compactDetailToText(detail: string | ContentBlock[]): string {
  if (typeof detail === "string") {
    return detail;
  }

  return detail
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "tool_result" && typeof block.content === "string") {
        return block.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function CompactBoundarySystemMessage({
  item,
  icon,
}: {
  item: Extract<RenderItem, { type: "system" }>;
  icon: string;
}) {
  const details = (item.details ?? [])
    .map(compactDetailToText)
    .map((text) => text.trim())
    .filter(Boolean);

  if (details.length === 0) {
    return (
      <div className="system-message system-message-compact-boundary">
        <span className="system-message-icon">{icon}</span>
        <span className="system-message-text">{item.content}</span>
      </div>
    );
  }

  return (
    <details className="system-message system-message-compact-boundary system-message-compact-boundary--details">
      <summary className="system-message-compact-summary">
        <span className="collapsible__icon" aria-hidden="true">
          ▸
        </span>
        <span className="system-message-icon">{icon}</span>
        <span className="system-message-text">{item.content}</span>
      </summary>
      <div className="system-message-compact-details">
        {details.map((detail, index) => (
          <pre
            className="system-message-compact-detail"
            key={`${item.id}-compact-detail-${index}`}
          >
            {detail}
          </pre>
        ))}
      </div>
    </details>
  );
}

export const RenderItemComponent = memo(function RenderItemComponent({
  item,
  isStreaming,
  thinkingExpanded,
  toggleThinkingExpanded,
  sessionProvider,
  onCorrectUserPrompt,
  onTrimBeforeUserPrompt,
  onForkBeforeUserPrompt,
  onQuoteTextBlock,
  alwaysShowQuoteCircle,
  staleNowMs,
  latestVisibleTimestampMs,
  thinkingDurationMs,
  getForkSummaryTargetHref,
  onCancelForkSummary,
  onToggleForkSummaryAutoOpen,
  onFollowForkSummary,
}: Props) {
  const staticAgeNowMsRef = useRef(Date.now());
  const timestampMs = getLatestMessageTimestampMs(item.sourceMessages);
  const hasTimestamp = timestampMs !== null;
  const isLatestVisibleTimestamp =
    hasTimestamp && latestVisibleTimestampMs === timestampMs;
  const ageNowMs = isLatestVisibleTimestamp
    ? (staleNowMs ?? Date.now())
    : staticAgeNowMsRef.current;
  const showAgeByDefault =
    isLatestVisibleTimestamp &&
    ageNowMs !== null &&
    ageNowMs - timestampMs >= MESSAGE_STALE_THRESHOLD_MS;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't interfere with text selection (important for mobile long-press)
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return;
      }

      // Shift+click to debug (not Cmd/Ctrl+click, which opens links in new tabs)
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        console.log(
          "[DEBUG] Render snapshot",
          buildDebugSnapshot(item, {
            isStreaming,
            thinkingExpanded,
            sessionProvider,
          }),
        );
      }
    },
    [item, isStreaming, thinkingExpanded, sessionProvider],
  );

  const renderContent = () => {
    switch (item.type) {
      case "text":
        return (
          <TextBlock
            text={item.text}
            isStreaming={item.isStreaming}
            augmentHtml={item.augmentHtml}
            onQuoteBlock={onQuoteTextBlock}
            alwaysShowQuoteCircle={alwaysShowQuoteCircle}
          />
        );

      case "thinking":
        return (
          <ThinkingBlock
            thinking={item.thinking}
            status={item.status}
            isExpanded={thinkingExpanded}
            onToggle={toggleThinkingExpanded}
            durationMs={thinkingDurationMs}
          />
        );

      case "tool_call":
        return (
          <ToolCallRow
            id={item.id}
            toolName={item.toolName}
            toolInput={item.toolInput}
            toolResult={item.toolResult}
            status={item.status}
            sessionProvider={sessionProvider}
          />
        );

      case "user_prompt":
        return (
          <UserPromptBlock
            content={item.content}
            onCorrect={onCorrectUserPrompt}
            onTrimBefore={onTrimBeforeUserPrompt}
            onForkBefore={onForkBeforeUserPrompt}
          />
        );

      case "session_setup":
        return <SessionSetupBlock title={item.title} prompts={item.prompts} />;

      case "transcript_display_object":
        return (
          <ForkSummaryDisplayObject
            object={item.object}
            targetHref={
              item.object.targetSessionId
                ? getForkSummaryTargetHref?.(item.object.targetSessionId)
                : undefined
            }
            onCancel={() => onCancelForkSummary?.(item.object.id)}
            onToggleAutoOpen={(value) =>
              onToggleForkSummaryAutoOpen?.(item.object.id, value)
            }
            onFollow={() => onFollowForkSummary?.(item.object.id)}
          />
        );

      case "task_notification":
        return <TaskNotificationBlock item={item} />;

      case "system": {
        if (item.subtype === "away_summary") {
          return (
            <div className="system-message-recap">
              <span className="system-message-recap-mark">※</span>
              <span className="system-message-recap-body">{item.content}</span>
            </div>
          );
        }

        // Different styling for compacting vs completed compaction
        const isCompacting =
          item.subtype === "status" && item.status === "compacting";
        const isError = item.subtype === "error";
        const isConfigAck = item.subtype === "config_ack";
        const isLocalCommand = item.subtype === "local_command";
        const isSubagentActivity = item.subtype === "subagent_activity";
        const isHighlightedConfigAck =
          isConfigAck && item.configChanged !== false;
        const icon = isError
          ? "!"
          : isConfigAck
            ? "✓"
            : isLocalCommand
              ? "/"
              : isSubagentActivity
                ? "↳"
                : "⟳";
        if (item.subtype === "compact_boundary") {
          return <CompactBoundarySystemMessage item={item} icon={icon} />;
        }
        return (
          <div
            className={`system-message ${isCompacting ? "system-message-compacting" : ""} ${isError ? "system-message-error" : ""} ${isHighlightedConfigAck ? "system-message-config-ack" : ""} ${isLocalCommand ? "system-message-local-command" : ""}`}
          >
            <span
              className={`system-message-icon ${isCompacting ? "spinning" : ""}`}
            >
              {icon}
            </span>
            <span className="system-message-text">{item.content}</span>
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: debug shift-click uses row-level event metadata
    // biome-ignore lint/a11y/useKeyWithClickEvents: debug feature, shift+click only
    <div
      className={[
        "message-render-row",
        hasTimestamp ? "has-message-age" : "",
        showAgeByDefault ? "is-message-age-visible" : "",
        item.isSubagent ? "subagent-item" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-render-type={item.type}
      data-render-id={item.id}
      onClick={handleClick}
    >
      <div className="message-render-content">{renderContent()}</div>
      <MessageAge timestampMs={timestampMs} nowMs={ageNowMs ?? Date.now()} />
    </div>
  );
});
