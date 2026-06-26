import type {
  MarkdownAugment,
  TranscriptDisplayObject,
  UploadedFile,
  UserMessageMetadata,
} from "@yep-anywhere/shared";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  createCommentAnchor,
  type CommentAnchor,
  draftQuoteSignaturesContainAnchor,
  type DraftTextChangeMetadata,
  getCommentAnchorRange,
  getDraftQuoteLineSignatures,
} from "../lib/commentAnchors";
import { getShowThinkingSetting } from "../hooks/useModelSettings";
import { useAlwaysShowQuoteCircles } from "../hooks/useAlwaysShowQuoteCircles";
import { useRelativeNow } from "../hooks/useRelativeNow";
import { useI18n } from "../i18n";
import { markReloadPerfPhase } from "../lib/diagnostics/reloadPerfProbe";
import {
  copyMarkdownSelectionToClipboard,
  extractMarkdownSnippetsFromSelection,
} from "../lib/markdownSelectionCopy";
import {
  formatCompactRelativeAge,
  getLatestMessageTimestampMs,
  isStaleTimestamp,
  MESSAGE_STALE_THRESHOLD_MS,
  parseTimestampMs,
} from "../lib/messageAge";
import { parseUserPrompt } from "../lib/parseUserPrompt";
import {
  type ActiveToolApproval,
  preprocessMessages,
} from "../lib/preprocessMessages";
import {
  dispatchSessionIsearchGuideState,
  type SessionIsearchScope,
} from "../lib/sessionIsearchGuide";
import { stabilizeRenderItems } from "../lib/stableRenderItems";
import { insertTranscriptDisplayObjects } from "../lib/transcriptDisplayObjects";
import { UI_KEYS } from "../lib/storageKeys";
import type { ContentBlock, Message } from "../types";
import type { RenderItem } from "../types/renderItems";
import { AttachmentChip } from "./AttachmentChip";
import {
  BtwAsideTranscript,
  type BtwAsideTranscriptTurn,
} from "./BtwAsidePane";
import {
  type AssistantRenderSegment,
  buildAssistantRenderSegments,
  ExploredToolGroup,
  getExploredEntrySearchPreview,
  getExploredEntrySearchText,
} from "./blocks/ExploredToolGroup";
import { MessageAge } from "./MessageAge";
import { ProcessingIndicator } from "./ProcessingIndicator";
import { RenderItemComponent } from "./RenderItemComponent";
import {
  type UserTurnNavAnchor,
  UserTurnNavigator,
  type UserTurnNavMotionCue,
  type UserTurnNavSearchState,
} from "./UserTurnNavigator";
import { CopyTextButton } from "./ui/CopyTextButton";

const EMPTY_TRANSCRIPT_DISPLAY_OBJECTS: readonly TranscriptDisplayObject[] = [];
const SELECTION_QUOTE_BUTTON_SIZE_PX = 30;
const SELECTION_QUOTE_BUTTON_GAP_PX = 8;

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Groups consecutive assistant items (text, thinking, tool_call) into turns.
 * User prompts break the grouping and are returned as separate groups.
 */
function groupItemsIntoTurns(items: RenderItem[]): Array<{
  isUserPrompt: boolean;
  isStandalone?: boolean;
  items: RenderItem[];
}> {
  const groups: Array<{
    isUserPrompt: boolean;
    isStandalone?: boolean;
    items: RenderItem[];
  }> = [];
  let currentAssistantGroup: RenderItem[] = [];

  for (const item of items) {
    if (item.type === "transcript_display_object") {
      if (currentAssistantGroup.length > 0) {
        groups.push({ isUserPrompt: false, items: currentAssistantGroup });
        currentAssistantGroup = [];
      }
      groups.push({
        isUserPrompt: false,
        isStandalone: true,
        items: [item],
      });
    } else if (item.type === "user_prompt" || item.type === "session_setup") {
      // Flush any pending assistant items
      if (currentAssistantGroup.length > 0) {
        groups.push({ isUserPrompt: false, items: currentAssistantGroup });
        currentAssistantGroup = [];
      }
      // User prompt is its own group
      groups.push({ isUserPrompt: true, items: [item] });
    } else {
      // Accumulate assistant items
      currentAssistantGroup.push(item);
    }
  }

  // Flush remaining assistant items
  if (currentAssistantGroup.length > 0) {
    groups.push({ isUserPrompt: false, items: currentAssistantGroup });
  }

  return groups;
}

function getEarliestMessageTimestampMs(
  messages: readonly Message[],
): number | null {
  let earliest: number | null = null;
  for (const message of messages) {
    const timestampMs = parseTimestampMs(message.timestamp);
    if (timestampMs === null) {
      continue;
    }
    earliest =
      earliest === null ? timestampMs : Math.min(earliest, timestampMs);
  }
  return earliest;
}

function getLatestItemsTimestampMs(
  items: readonly RenderItem[],
): number | null {
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

function getThinkingDurationMs(
  item: RenderItem,
  items: readonly RenderItem[],
  index: number,
  nowMs: number,
): number | undefined {
  if (item.type !== "thinking") {
    return undefined;
  }

  const startMs =
    getEarliestMessageTimestampMs(item.sourceMessages) ??
    getLatestMessageTimestampMs(item.sourceMessages);
  if (startMs === null) {
    return undefined;
  }

  let endMs: number | null = item.status === "streaming" ? nowMs : null;
  for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
    const nextItem = items[nextIndex];
    if (!nextItem) {
      continue;
    }
    const nextTimestampMs =
      getEarliestMessageTimestampMs(nextItem.sourceMessages) ??
      getLatestMessageTimestampMs(nextItem.sourceMessages);
    if (nextTimestampMs !== null && nextTimestampMs >= startMs) {
      endMs = nextTimestampMs;
      break;
    }
  }

  if (endMs === null) {
    const latestOwnMs = getLatestMessageTimestampMs(item.sourceMessages);
    endMs = latestOwnMs !== null && latestOwnMs > startMs ? latestOwnMs : null;
  }

  if (endMs === null) {
    return undefined;
  }

  const durationMs = endMs - startMs;
  return durationMs >= 100 && durationMs < 24 * 60 * 60 * 1000
    ? durationMs
    : undefined;
}

const SESSION_SETUP_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
];

function getPromptTextForCorrection(content: string | ContentBlock[]): string {
  const rawText =
    typeof content === "string"
      ? content
      : content
          .filter(
            (block): block is ContentBlock & { type: "text"; text: string } =>
              block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("\n");
  return parseUserPrompt(rawText).text.trim();
}

function getUserTurnPreview(content: string | ContentBlock[]): string {
  const text = getPromptTextForCorrection(content).replace(/\s+/g, " ").trim();
  return getSearchPreviewFallback(text);
}

function getSearchPreviewFallback(text: string): string {
  const compactText = text.replace(/\s+/g, " ").trim();
  if (compactText.length <= 180) {
    return compactText;
  }
  return `${compactText.slice(0, 177).trimEnd()}...`;
}

function normalizeSearchText(text: string, caseSensitive = false): string {
  const compactText = text.replace(/\s+/g, " ").trim();
  return caseSensitive ? compactText : compactText.toLowerCase();
}

function getSearchableUserTurnPreview(item: RenderItem): string | null {
  if (item.type !== "user_prompt" || item.isSubagent) {
    return null;
  }
  const preview = getUserTurnPreview(item.content);
  return preview && !isSessionSetupText(preview) ? preview : null;
}

function isCtrlKeyShortcut(
  event: KeyboardEvent,
  key: string,
  code: string,
  options: { allowAlt?: boolean } = {},
): boolean {
  if (
    !event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    (!options.allowAlt && event.altKey) ||
    event.getModifierState("AltGraph")
  ) {
    return false;
  }
  return event.key.toLocaleLowerCase() === key || event.code === code;
}

function getSessionIsearchShortcutScope(
  event: KeyboardEvent,
): SessionIsearchScope | null {
  if (
    isCtrlKeyShortcut(event, "s", "KeyS", { allowAlt: true }) &&
    event.altKey
  ) {
    return "full";
  }
  if (isCtrlKeyShortcut(event, "s", "KeyS")) {
    return "all";
  }
  if (isCtrlKeyShortcut(event, "r", "KeyR", { allowAlt: true })) {
    return "user";
  }
  return null;
}

function findRenderRow(
  messageList: HTMLDivElement | null,
  id: string,
): HTMLElement | null {
  if (!messageList) return null;
  for (const row of messageList.querySelectorAll<HTMLElement>(
    "[data-render-id]",
  )) {
    if (row.dataset.renderId === id) {
      return row;
    }
  }
  return null;
}

interface VisibleRenderAnchor {
  id: string;
  topOffset: number;
}

function getFirstVisibleRenderAnchor(
  messageList: HTMLDivElement,
  scrollContainer: HTMLElement,
): VisibleRenderAnchor | null {
  const containerRect = scrollContainer.getBoundingClientRect();
  for (const row of messageList.querySelectorAll<HTMLElement>(
    "[data-render-id]",
  )) {
    const id = row.dataset.renderId;
    if (!id) {
      continue;
    }
    const rowRect = row.getBoundingClientRect();
    if (
      rowRect.bottom > containerRect.top &&
      rowRect.top < containerRect.bottom
    ) {
      return {
        id,
        topOffset: rowRect.top - containerRect.top,
      };
    }
  }
  return null;
}

function buildSearchPreview(
  text: string,
  query: string,
  caseSensitive = false,
): string {
  const compactText = text.replace(/\s+/g, " ").trim();
  const normalizedText = normalizeSearchText(compactText, caseSensitive);
  const normalizedQuery = normalizeSearchText(query, caseSensitive);
  const fallback =
    compactText.length > 420
      ? `${compactText.slice(0, 417).trimEnd()}...`
      : compactText;
  if (!normalizedQuery) {
    return fallback;
  }

  const matchIndexes: number[] = [];
  let searchFrom = 0;
  while (matchIndexes.length < 3) {
    const index = normalizedText.indexOf(normalizedQuery, searchFrom);
    if (index === -1) break;
    matchIndexes.push(index);
    searchFrom = index + normalizedQuery.length;
  }
  if (matchIndexes.length === 0) {
    return fallback;
  }

  return matchIndexes
    .map((index) => {
      const start = Math.max(0, index - 96);
      const end = Math.min(
        compactText.length,
        index + normalizedQuery.length + 180,
      );
      const prefix = start > 0 ? "..." : "";
      const suffix = end < compactText.length ? "..." : "";
      return `${prefix}${compactText.slice(start, end).trim()}${suffix}`;
    })
    .join(" ... ");
}

function stringifySearchValue(value: unknown): string {
  const seen = new WeakSet<object>();

  const stringify = (nestedValue: unknown): string => {
    if (nestedValue === null || nestedValue === undefined) {
      return "";
    }
    if (typeof nestedValue === "string") {
      return nestedValue;
    }
    if (
      typeof nestedValue === "number" ||
      typeof nestedValue === "boolean" ||
      typeof nestedValue === "bigint"
    ) {
      return String(nestedValue);
    }
    if (typeof nestedValue !== "object") {
      return String(nestedValue);
    }
    if (seen.has(nestedValue)) {
      return "[Circular]";
    }
    seen.add(nestedValue);
    if (Array.isArray(nestedValue)) {
      return nestedValue.map(stringify).filter(Boolean).join("\n");
    }
    return Object.entries(nestedValue as Record<string, unknown>)
      .map(([key, entryValue]) => {
        const text = stringify(entryValue);
        return text ? `${key}: ${text}` : key;
      })
      .filter(Boolean)
      .join("\n");
  };

  return stringify(value);
}

function getContentBlocksText(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "thinking" && typeof block.thinking === "string") {
        return block.thinking;
      }
      if (block.type === "tool_use") {
        return [block.name, block.id, stringifySearchValue(block.input)].join(
          "\n",
        );
      }
      if (block.type === "tool_result") {
        return [
          block.tool_use_id,
          typeof block.content === "string"
            ? block.content
            : stringifySearchValue(block.content),
        ].join("\n");
      }
      return stringifySearchValue(block);
    })
    .filter(Boolean)
    .join("\n");
}

function joinSearchParts(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

function getToolSearchText(item: RenderItem): string {
  if (item.type !== "tool_call") {
    return "";
  }
  return joinSearchParts([
    item.toolName,
    item.id,
    item.status,
    stringifySearchValue(item.toolInput),
    item.toolResult?.isError ? "error" : null,
    item.toolResult?.content,
    stringifySearchValue(item.toolResult?.structured),
  ]);
}

function getToolSearchPreview(item: RenderItem): string {
  if (item.type !== "tool_call") {
    return "";
  }
  const input = stringifySearchValue(item.toolInput).replace(/\s+/g, " ");
  const detail = input ? `: ${getSearchPreviewFallback(input)}` : "";
  return `${item.toolName}${detail}`;
}

function getSystemSearchText(item: RenderItem): string {
  if (item.type !== "system") {
    return "";
  }
  return joinSearchParts([
    item.content,
    ...(item.details ?? []).map(getContentBlocksText),
  ]);
}

function getFullSessionSearchAnchorForItem(
  item: RenderItem,
): UserTurnNavAnchor | null {
  switch (item.type) {
    case "user_prompt": {
      const text = getPromptTextForCorrection(item.content);
      const preview = getSearchPreviewFallback(text);
      return preview ? { id: item.id, preview, searchText: text } : null;
    }
    case "session_setup": {
      const text = joinSearchParts([
        item.title,
        ...item.prompts.map(getContentBlocksText),
      ]);
      return text
        ? {
            id: item.id,
            preview: item.title || getSearchPreviewFallback(text),
            searchText: text,
          }
        : null;
    }
    case "transcript_display_object": {
      const searchText = joinSearchParts([
        item.object.title,
        item.object.status,
        item.object.error,
      ]);
      return searchText
        ? {
            id: item.id,
            preview:
              item.object.title ??
              getSearchPreviewFallback(item.object.error ?? item.object.status),
            searchText,
          }
        : null;
    }
    case "text":
      return item.text
        ? {
            id: item.id,
            preview: getSearchPreviewFallback(item.text),
            searchText: item.text,
          }
        : null;
    case "thinking":
      return item.thinking
        ? {
            id: item.id,
            preview: `Thinking: ${getSearchPreviewFallback(item.thinking)}`,
            searchText: joinSearchParts(["Thinking", item.thinking]),
          }
        : null;
    case "system": {
      const systemSearchText = getSystemSearchText(item);
      return systemSearchText
        ? {
            id: item.id,
            preview: getSearchPreviewFallback(systemSearchText),
            searchText: systemSearchText,
          }
        : null;
    }
    case "task_notification": {
      const searchText = item.summary ?? item.raw;
      return searchText
        ? {
            id: item.id,
            preview: getSearchPreviewFallback(searchText),
            searchText,
          }
        : null;
    }
    case "tool_call": {
      const searchText = getToolSearchText(item);
      return searchText
        ? {
            id: item.id,
            preview: getToolSearchPreview(item),
            searchText,
          }
        : null;
    }
  }
}

function getFullSessionSearchAnchorsForSegment(
  segment: AssistantRenderSegment,
): UserTurnNavAnchor[] {
  if (segment.kind === "item") {
    const anchor = getFullSessionSearchAnchorForItem(segment.item);
    return anchor ? [anchor] : [];
  }

  const anchors: UserTurnNavAnchor[] = [
    {
      id: segment.id,
      preview: `Explored: ${segment.items.length} ${
        segment.items.length === 1 ? "item" : "items"
      }`,
      searchText: joinSearchParts([
        "Explored",
        `${segment.items.length} items`,
      ]),
    },
  ];

  for (const item of segment.items) {
    const anchor = getFullSessionSearchAnchorForItem(item);
    if (anchor) {
      const exploredPreview = getExploredEntrySearchPreview(item);
      const exploredSearchText = getExploredEntrySearchText(item);
      anchors.push({
        ...anchor,
        id: `${segment.id}:${item.id}`,
        preview: `Explored / ${exploredPreview || anchor.preview}`,
        searchText: joinSearchParts([exploredSearchText, anchor.searchText]),
        targetId: segment.id,
      });
    }
  }

  return anchors;
}

function getSearchScopeLabel(scope: SessionIsearchScope): string {
  if (scope === "full") {
    return "Full session";
  }
  return scope === "all" ? "All turns" : "User turns";
}

function getSearchScopeAriaLabel(scope: SessionIsearchScope): string {
  if (scope === "full") {
    return "Reverse search full session";
  }
  return scope === "all"
    ? "Reverse search all turns"
    : "Reverse search user turns";
}

function getSearchScopeKeys(scope: SessionIsearchScope): string {
  if (scope === "full") {
    return "Ctrl+Alt+S";
  }
  return scope === "all" ? "Ctrl+S" : "Ctrl+R/Ctrl+Alt+R";
}

function isSessionSetupText(text: string): boolean {
  const trimmed = text.trimStart();
  return SESSION_SETUP_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

interface UserTurnSearchSession {
  active: boolean;
  scope: SessionIsearchScope;
  query: string;
  caseSensitive: boolean;
  selectedId: string | null;
  originalScrollTop: number | null;
}

const NAV_MOTION_CUE_CLEAR_MS = 760;
const SEARCH_ARROW_REPEAT_DELAY_MS = 150;
const SEARCH_ARROW_REPEAT_INTERVAL_MS = 42;
const MIN_BOTTOM_FOLLOW_THRESHOLD_PX = 120;
const MAX_BOTTOM_FOLLOW_THRESHOLD_PX = 520;
const BOTTOM_FOLLOW_VIEWPORT_FRACTION = 0.45;
const FOLLOW_CATCH_UP_DELAYS_MS = [50, 120, 240, 480, 960, 1600, 2400];
const SEND_CATCH_UP_DELAYS_MS = [80, 240, 640];
const TOUCH_SCROLL_CANCEL_THRESHOLD_PX = 6;
const INTERACTIVE_SCROLL_TARGET_SELECTOR =
  "button, input, textarea, select, a[href], [contenteditable='true']";

function highResolutionNowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function isNearScrollBottom(container: HTMLElement): boolean {
  const followThreshold = Math.min(
    MAX_BOTTOM_FOLLOW_THRESHOLD_PX,
    Math.max(
      MIN_BOTTOM_FOLLOW_THRESHOLD_PX,
      container.clientHeight * BOTTOM_FOLLOW_VIEWPORT_FRACTION,
    ),
  );
  return (
    container.scrollHeight - container.scrollTop - container.clientHeight <
    followThreshold
  );
}

// Tolerance for "the last line is in view" — sub-pixel / zoom / high-DPI
// rounding only, not a behavioural band.
const FOLLOW_BOTTOM_TOLERANCE_PX = 4;

// "At bottom" for follow purposes = the last rendered line is in view (its
// bottom edge at or above the viewport bottom), not that scrollTop reached the
// literal pixel-bottom. So trailing padding below the processing indicator
// needn't be scrolled past ("as soon as the fun-text line shows, we're
// following"), and the indicator being absent is handled for free —
// lastElementChild is then the last message row. The generous isNearScrollBottom
// stays only for *continuing* an already-on follow through fast-streaming gaps;
// re-acquiring follow is governed here.
//
// Deliberately position-only, with no scroll-direction inference. Momentum
// scrolling fires scroll events after the finger has lifted, and iOS rubber-band
// bounce briefly overshoots the bottom then springs back — both corrupt any
// velocity/direction reading. "Is the bottom line visible right now" stays
// consistent through momentum and bounce (during a bottom bounce the last line
// is *more* in view, which correctly reads as at-bottom), so it needs no
// direction tracking and no settle timer. Exit-follow stays sensitive via the
// directional wheel/touch/key handlers, which fire on intent during the touch,
// before momentum begins.
function isAtScrollBottom(
  viewport: HTMLElement,
  content: HTMLElement,
): boolean {
  const lastLine = content.lastElementChild;
  if (!lastLine) {
    return (
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
      FOLLOW_BOTTOM_TOLERANCE_PX
    );
  }
  return (
    lastLine.getBoundingClientRect().bottom <=
    viewport.getBoundingClientRect().bottom + FOLLOW_BOTTOM_TOLERANCE_PX
  );
}

function eventTargetIsInside(
  target: EventTarget | null,
  container: HTMLElement,
): boolean {
  return target instanceof Node && container.contains(target);
}

function isInteractiveScrollTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(INTERACTIVE_SCROLL_TARGET_SELECTOR) !== null
  );
}

function loadSessionThinkingVisible(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(UI_KEYS.sessionThinkingVisible) !==
      "false"
    );
  } catch {
    return true;
  }
}

function saveSessionThinkingVisible(visible: boolean) {
  try {
    globalThis.localStorage?.setItem(
      UI_KEYS.sessionThinkingVisible,
      visible ? "true" : "false",
    );
  } catch {
    // localStorage is only a display preference; in-memory state still applies.
  }
}

// Auto-expand policy for thinking blocks. Off (default): every newly-arriving
// block stays expanded ("all-new"). On: only the most-recent block is
// auto-open; it auto-collapses once a newer block appears ("latest-only").
// Manual per-block toggles win over either policy. See
// topics/thinking-expand-latest-only.md.
function loadSessionThinkingLatestOnly(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(UI_KEYS.sessionThinkingLatestOnly) ===
      "true"
    );
  } catch {
    return false;
  }
}

function saveSessionThinkingLatestOnly(latestOnly: boolean) {
  try {
    globalThis.localStorage?.setItem(
      UI_KEYS.sessionThinkingLatestOnly,
      latestOnly ? "true" : "false",
    );
  } catch {
    // localStorage is only a display preference; in-memory state still applies.
  }
}

function countThinkingItems(items: readonly RenderItem[]) {
  let count = 0;
  for (const item of items) {
    if (item.type === "thinking") {
      count += 1;
    }
  }
  return count;
}

function providerExpandsHistoricalThinking(provider: string | undefined) {
  return provider === "pi";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  if (bytes < 1024 * 1024 * 1024)
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
  return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10}\u202fgb`;
}

/** Pending message waiting for server confirmation */
interface PendingMessage {
  tempId: string;
  content: string;
  timestamp: string;
  clientOrder?: number;
  status?: string;
  attachments?: UploadedFile[];
}

/** Deferred message queued server-side */
interface DeferredMessage {
  tempId?: string;
  content: string;
  timestamp: string;
  metadata?: UserMessageMetadata;
  attachmentCount?: number;
  attachments?: UploadedFile[];
}

interface ComposerTailLanePosition {
  regularIndex?: number;
  patientIndex?: number;
}

function isPatientDeferredMessage(message: DeferredMessage): boolean {
  return message.metadata?.deliveryIntent === "patient";
}

function formatQueuedAge(timestampMs: number, nowMs: number): string {
  const label = formatCompactRelativeAge(timestampMs, nowMs);
  return label === "now" ? "now" : `${label} ago`;
}

function getDeferredMessageStatus({
  isPatient,
  lanePosition,
  timestampMs,
  nowMs,
}: {
  isPatient: boolean;
  lanePosition: ComposerTailLanePosition | undefined;
  timestampMs: number | null;
  nowMs: number;
}): string {
  if (isPatient) {
    const age =
      timestampMs !== null ? formatQueuedAge(timestampMs, nowMs) : null;
    const position =
      lanePosition?.patientIndex === undefined
        ? ""
        : lanePosition.patientIndex === 0
          ? "waiting"
          : `#${lanePosition.patientIndex + 1}`;
    const detail = [position, age].filter(Boolean).join(", ");
    return detail ? `Patient (${detail})` : "Patient queued";
  }

  const regularIndex = lanePosition?.regularIndex ?? 0;
  return regularIndex === 0
    ? "Queued (next regular)"
    : `Queued regular (#${regularIndex + 1})`;
}

type ComposerTailItem =
  | {
      kind: "pending";
      key: string;
      message: PendingMessage;
      sourceIndex: number;
    }
  | {
      kind: "deferred";
      key: string;
      message: DeferredMessage;
      deferredIndex: number;
      sourceIndex: number;
    };

function compareComposerTailItems(
  left: ComposerTailItem,
  right: ComposerTailItem,
): number {
  // Two lanes, each kept in its own order: optimistic pending sends (in flight)
  // render before server-queued deferred messages, and deferred messages
  // preserve the server's authoritative queue order rather than being re-sorted.
  if (left.kind !== right.kind) {
    return left.kind === "pending" ? -1 : 1;
  }

  if (left.kind === "deferred" && right.kind === "deferred") {
    return left.deferredIndex - right.deferredIndex;
  }

  const leftOrder =
    left.kind === "pending" ? left.message.clientOrder : undefined;
  const rightOrder =
    right.kind === "pending" ? right.message.clientOrder : undefined;
  if (
    typeof leftOrder === "number" &&
    Number.isFinite(leftOrder) &&
    typeof rightOrder === "number" &&
    Number.isFinite(rightOrder) &&
    leftOrder !== rightOrder
  ) {
    return leftOrder - rightOrder;
  }

  const leftTimestamp = parseTimestampMs(left.message.timestamp);
  const rightTimestamp = parseTimestampMs(right.message.timestamp);
  if (
    leftTimestamp !== null &&
    rightTimestamp !== null &&
    leftTimestamp !== rightTimestamp
  ) {
    return leftTimestamp - rightTimestamp;
  }

  return left.sourceIndex - right.sourceIndex;
}

interface BtwAsideTimelineItem {
  id: string;
  request: string;
  followUps: string[];
  status: "draft" | "starting" | "running" | "complete" | "failed" | "stopped";
  createdAt: string;
  updatedAt: string;
  historyAt?: string;
  preview?: string;
  error?: string;
  responses: string[];
  turns?: BtwAsideTranscriptTurn[];
  expanded?: boolean;
  isFocused?: boolean;
  canStop?: boolean;
}

interface Props {
  messages: Message[];
  transcriptDisplayObjects?: readonly TranscriptDisplayObject[];
  provider?: string;
  isStreaming?: boolean;
  isProcessing?: boolean;
  /** True when context is being compressed */
  isCompacting?: boolean;
  /** Increment this to force scroll to bottom (e.g., when user sends a message) */
  scrollTrigger?: number;
  /** Messages waiting for server confirmation (shown as "Sending...") */
  pendingMessages?: PendingMessage[];
  /** Deferred messages queued server-side (shown as "Queued") */
  deferredMessages?: DeferredMessage[];
  /** YA-owned /btw cards that have entered the scrollback timeline. */
  btwAsides?: BtwAsideTimelineItem[];
  /** Focus this /btw aside for follow-up turns. */
  onFocusBtwAside?: (asideId: string) => void;
  /** Exit focused /btw follow-up mode. */
  onDoneBtwAside?: () => void;
  /** Interrupt/abort a running /btw aside. */
  onStopBtwAside?: (asideId: string) => void;
  /** Toggle the inline /btw transcript preview. */
  onToggleBtwAsideExpanded?: (asideId: string) => void;
  /** Insert a /btw transcript turn into the Mother composer. */
  onTransferBtwAsideTurn?: (text: string) => void;
  /** Append quoted assistant output to the composer. */
  onQuoteSelection?: (quotedText: string) => string | null;
  /** Read current composer draft for quote tint reconciliation. */
  getComposerDraft?: () => string;
  composerDraft?: string;
  composerDraftChange?: DraftTextChangeMetadata;
  /** Clear all comment anchors after the quoted turn is sent. */
  quoteClearSignal?: number;
  /** Callback to cancel a deferred message */
  onCancelDeferred?: (tempId: string) => void;
  /** Callback to correct the latest actually-sent user message */
  onCorrectLatestUserMessage?: (messageId: string, content: string) => void;
  /** Callback to aggressively reload the client transcript from a user turn */
  onTrimBeforeUserMessage?: (messageId: string) => void;
  /** Fork the session from just before the given user message (real prefix fork only). */
  onForkBeforeUserMessage?: (messageId: string) => void;
  /** Fork after the completed turn for this user message, optionally with a summary. */
  onForkAfterUserMessage?: (messageId: string) => void;
  /** Copy the given user turn's text (turn-notch context menu). */
  onCopyUserMessage?: (messageId: string) => void;
  /** Pre-rendered markdown HTML from server (keyed by message ID) */
  markdownAugments?: Record<string, MarkdownAugment>;
  /** Active tool approval - prevents matching orphaned tool from showing as interrupted */
  activeToolApproval?: ActiveToolApproval;
  /** Whether there are older messages not yet loaded */
  hasOlderMessages?: boolean;
  /** Whether older messages are currently being loaded */
  loadingOlder?: boolean;
  /** Callback to load the next chunk of older messages */
  onLoadOlderMessages?: () => void;
  /** Whether the client transcript is intentionally loaded from a recent tail */
  clientTailActive?: boolean;
  getForkSummaryTargetHref?: (targetSessionId: string) => string;
  onCancelForkSummary?: (objectId: string) => void;
  onToggleForkSummaryAutoOpen?: (objectId: string, value: boolean) => void;
  onFollowForkSummary?: (objectId: string) => void;
}

function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function BtwAsideTimelineCard({
  aside,
  onFocus,
  onDone,
  onStop,
  onToggleExpanded,
  onTransferTurn,
}: {
  aside: BtwAsideTimelineItem;
  onFocus?: (asideId: string) => void;
  onDone?: () => void;
  onStop?: (asideId: string) => void;
  onToggleExpanded?: (asideId: string) => void;
  onTransferTurn?: (text: string) => void;
}) {
  const { t } = useI18n();
  const canExpand = Boolean(
    aside.request ||
      aside.followUps.length > 0 ||
      aside.responses.length > 0 ||
      (aside.turns?.length ?? 0) > 0,
  );

  return (
    <div
      className={`btw-aside-card btw-aside-card-history is-${aside.status} ${
        aside.isFocused ? "is-focused" : ""
      }`}
      data-render-id={`btw-${aside.id}`}
    >
      <button
        type="button"
        className="btw-aside-main"
        onClick={() => onFocus?.(aside.id)}
      >
        <span className="btw-aside-meta">/btw {aside.status}</span>
        <span className="btw-aside-request">
          {aside.request || "New aside"}
        </span>
        {aside.followUps.length > 0 && (
          <span className="btw-aside-followups">
            +{aside.followUps.length} follow-up
            {aside.followUps.length === 1 ? "" : "s"}
          </span>
        )}
        {aside.preview && (
          <span className="btw-aside-preview">{aside.preview}</span>
        )}
        {aside.error && <span className="btw-aside-error">{aside.error}</span>}
      </button>
      {aside.expanded && canExpand && (
        <BtwAsideTranscript
          aside={aside}
          autoScrollLatest
          onTransferToComposer={onTransferTurn}
        />
      )}
      <div className="btw-aside-actions">
        {canExpand && (
          <button
            type="button"
            className="btw-aside-action"
            onClick={() => onToggleExpanded?.(aside.id)}
          >
            {aside.expanded ? "Less" : "Show"}
          </button>
        )}
        {aside.isFocused ? (
          <button
            type="button"
            className="btw-aside-action"
            onClick={onDone}
            title={t("btwAsideReturnComposerTitle")}
          >
            Done
          </button>
        ) : (
          <button
            type="button"
            className="btw-aside-action"
            onClick={() => onFocus?.(aside.id)}
          >
            Focus
          </button>
        )}
        {aside.canStop && (
          <button
            type="button"
            className="btw-aside-action btw-aside-action-stop"
            onClick={() => onStop?.(aside.id)}
            title={
              aside.isFocused
                ? "Stop this /btw aside and return to the main session"
                : "Stop this /btw aside"
            }
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

export const MessageList = memo(function MessageList({
  messages,
  transcriptDisplayObjects = EMPTY_TRANSCRIPT_DISPLAY_OBJECTS,
  provider,
  isStreaming = false,
  isProcessing = false,
  isCompacting = false,
  scrollTrigger = 0,
  pendingMessages = [],
  deferredMessages = [],
  btwAsides = [],
  onFocusBtwAside,
  onDoneBtwAside,
  onStopBtwAside,
  onToggleBtwAsideExpanded,
  onTransferBtwAsideTurn,
  onQuoteSelection,
  getComposerDraft,
  composerDraft = "",
  composerDraftChange,
  quoteClearSignal = 0,
  onCancelDeferred,
  onCorrectLatestUserMessage,
  onTrimBeforeUserMessage,
  onForkBeforeUserMessage,
  onForkAfterUserMessage,
  onCopyUserMessage,
  markdownAugments,
  activeToolApproval,
  hasOlderMessages = false,
  loadingOlder = false,
  onLoadOlderMessages,
  clientTailActive = false,
  getForkSummaryTargetHref,
  onCancelForkSummary,
  onToggleForkSummaryAutoOpen,
  onFollowForkSummary,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const isInitialLoadRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const lastHeightRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const followUpScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forcedCurrentScrollTimersRef = useRef<ReturnType<typeof setTimeout>[]>(
    [],
  );
  const programmaticScrollReleaseRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const previousRenderItemsRef = useRef<RenderItem[]>([]);
  const previousThinkingTextLengthsRef = useRef<Map<string, number> | null>(
    null,
  );
  const observedThinkingItemIdsRef = useRef<ReadonlySet<string> | null>(null);
  const autoExpandedHistoricalThinkingProviderRef = useRef<string | null>(null);
  const thinkingDeltaFollowAllowedRef = useRef(false);
  const navMotionCueTokenRef = useRef(0);
  const navMotionCueClearTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRestoreFocusRef = useRef<HTMLElement | null>(null);
  const searchOriginalScrollTopRef = useRef<number | null>(null);
  const selectedSearchTargetIdRef = useRef<string | null>(null);
  const searchArrowRepeatTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const searchArrowRepeatIntervalRef = useRef<ReturnType<
    typeof setInterval
  > | null>(null);
  const searchArrowRepeatDirectionRef = useRef<"previous" | "next" | null>(
    null,
  );
  const selectionPointerStartRef = useRef<{ clientY: number } | null>(null);
  const quoteInsertionDraftRef = useRef<string | null>(null);
  const [thinkingItemsVisible, setThinkingItemsVisible] = useState(() => {
    // "Show thinking" preference seeds the render gate's default; "default"
    // falls back to the live eye-toggle value. The eye icon still overrides
    // within a view.
    const showThinking = getShowThinkingSetting();
    if (showThinking === "on") return true;
    if (showThinking === "off") return false;
    return loadSessionThinkingVisible();
  });
  const [thinkingExpansionOverrides, setThinkingExpansionOverrides] = useState<
    Record<string, boolean>
  >({});
  const [thinkingLatestOnly, setThinkingLatestOnly] = useState(
    loadSessionThinkingLatestOnly,
  );
  const [autoExpandedThinkingItemIds, setAutoExpandedThinkingItemIds] =
    useState<ReadonlySet<string>>(() => new Set());
  const [navMotionCue, setNavMotionCue] = useState<UserTurnNavMotionCue | null>(
    null,
  );
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);
  const [userTurnSearch, setUserTurnSearch] = useState<UserTurnSearchSession>({
    active: false,
    scope: "user",
    query: "",
    caseSensitive: false,
    selectedId: null,
    originalScrollTop: null,
  });
  const [commentAnchors, setCommentAnchors] = useState<
    readonly CommentAnchor[]
  >([]);
  const [floatingQuoteButton, setFloatingQuoteButton] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const { alwaysShowQuoteCircles } = useAlwaysShowQuoteCircles();
  const { t } = useI18n();
  const nowMs = useRelativeNow();

  const applyQuoteAnchors = useCallback(
    (anchors: readonly CommentAnchor[], typedPrefix = "") => {
      if (!onQuoteSelection || anchors.length === 0) {
        return false;
      }
      const quotedText = anchors
        .map((anchor) => anchor.quotedText)
        .join("\n\n");
      const nextDraft = onQuoteSelection(
        typedPrefix ? `${quotedText}\n${typedPrefix}` : `${quotedText}\n`,
      );
      if (nextDraft === null) {
        return false;
      }
      quoteInsertionDraftRef.current = nextDraft;
      setCommentAnchors((previous) => [...previous, ...anchors]);
      containerRef.current?.ownerDocument.getSelection()?.removeAllRanges();
      setFloatingQuoteButton(null);
      return true;
    },
    [onQuoteSelection],
  );

  const applyQuoteFromSelection = useCallback(
    (typedPrefix = "") => {
      const root = containerRef.current;
      if (!root) {
        return false;
      }
      const anchors =
        extractMarkdownSnippetsFromSelection(root).map(createCommentAnchor);
      return applyQuoteAnchors(anchors, typedPrefix);
    },
    [applyQuoteAnchors],
  );

  const handleQuoteTextBlock = useCallback(
    (anchor: CommentAnchor) => {
      applyQuoteAnchors([anchor]);
    },
    [applyQuoteAnchors],
  );

  useEffect(() => {
    if (commentAnchors.length === 0) {
      return;
    }
    const insertionDraft = quoteInsertionDraftRef.current;
    if (
      insertionDraft === null &&
      composerDraftChange?.mayAffectQuoteAnchors === false
    ) {
      return;
    }
    const draft = insertionDraft ?? getComposerDraft?.() ?? composerDraft;
    quoteInsertionDraftRef.current = null;
    const draftSignatures = getDraftQuoteLineSignatures(draft);
    setCommentAnchors((previous) => {
      const next = previous.filter((anchor) =>
        draftQuoteSignaturesContainAnchor(draftSignatures, anchor),
      );
      return next.length === previous.length ? previous : next;
    });
  }, [
    commentAnchors.length,
    composerDraft,
    composerDraftChange,
    getComposerDraft,
  ]);

  useEffect(() => {
    if (quoteClearSignal > 0) {
      setCommentAnchors([]);
    }
  }, [quoteClearSignal]);

  useEffect(() => {
    if (
      typeof CSS === "undefined" ||
      !("highlights" in CSS) ||
      typeof Highlight === "undefined"
    ) {
      return;
    }

    if (commentAnchors.length === 0) {
      CSS.highlights.delete("comment-tint");
      return;
    }

    const ranges = commentAnchors
      .map(getCommentAnchorRange)
      .filter((range): range is Range => range !== null);
    if (ranges.length === 0) {
      CSS.highlights.delete("comment-tint");
      return;
    }

    const highlight = new Highlight(...ranges);
    CSS.highlights.set("comment-tint", highlight);
    return () => {
      CSS.highlights.delete("comment-tint");
    };
  }, [commentAnchors]);

  // Scroll to bottom, marking it as programmatic so scroll handler ignores it
  const scrollToBottom = useCallback(
    (container: HTMLElement, behavior: ScrollBehavior = "auto") => {
      isProgrammaticScrollRef.current = true;
      if (programmaticScrollReleaseRef.current !== null) {
        clearTimeout(programmaticScrollReleaseRef.current);
        programmaticScrollReleaseRef.current = null;
      }
      const top = Math.max(0, container.scrollHeight - container.clientHeight);
      if (behavior === "auto") {
        container.scrollTop = top;
      } else {
        container.scrollTo({ top, behavior });
      }
      lastHeightRef.current = container.scrollHeight;
      setIsScrolledToBottom(true);

      // Clear programmatic flag after scroll events have fired
      const releaseProgrammaticScroll = () => {
        isProgrammaticScrollRef.current = false;
        programmaticScrollReleaseRef.current = null;
        if (isNearScrollBottom(container)) {
          shouldAutoScrollRef.current = true;
          setIsScrolledToBottom(true);
        }
      };
      if (behavior === "smooth") {
        programmaticScrollReleaseRef.current = setTimeout(
          releaseProgrammaticScroll,
          520,
        );
      } else {
        requestAnimationFrame(releaseProgrammaticScroll);
      }

      // Schedule a follow-up scroll to catch any async rendering (markdown, syntax highlighting)
      if (followUpScrollRef.current !== null) {
        clearTimeout(followUpScrollRef.current);
      }
      followUpScrollRef.current = setTimeout(() => {
        followUpScrollRef.current = null;
        if (shouldAutoScrollRef.current) {
          isProgrammaticScrollRef.current = true;
          const followUpTop = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
          );
          if (behavior === "auto") {
            container.scrollTop = followUpTop;
          } else {
            container.scrollTo({ top: followUpTop, behavior });
          }
          lastHeightRef.current = container.scrollHeight;
          setIsScrolledToBottom(true);
          if (programmaticScrollReleaseRef.current === null) {
            requestAnimationFrame(() => {
              isProgrammaticScrollRef.current = false;
            });
          }
        }
      }, 50);
    },
    [],
  );

  const clearForcedCurrentScrollTimers = useCallback(() => {
    for (const timer of forcedCurrentScrollTimersRef.current) {
      clearTimeout(timer);
    }
    forcedCurrentScrollTimersRef.current = [];
  }, []);

  const clearFollowUpScrollTimer = useCallback(() => {
    if (followUpScrollRef.current !== null) {
      clearTimeout(followUpScrollRef.current);
      followUpScrollRef.current = null;
    }
  }, []);

  const stopFollowingForUserScroll = useCallback(
    (container: HTMLElement | null | undefined) => {
      shouldAutoScrollRef.current = false;
      thinkingDeltaFollowAllowedRef.current = false;
      isProgrammaticScrollRef.current = false;
      if (programmaticScrollReleaseRef.current !== null) {
        clearTimeout(programmaticScrollReleaseRef.current);
        programmaticScrollReleaseRef.current = null;
      }
      clearFollowUpScrollTimer();
      clearForcedCurrentScrollTimers();
      if (container) {
        lastHeightRef.current = container.scrollHeight;
      }
      setIsScrolledToBottom(false);
    },
    [clearFollowUpScrollTimer, clearForcedCurrentScrollTimers],
  );

  const forceScrollToCurrent = useCallback(
    (
      delays: readonly number[] = FOLLOW_CATCH_UP_DELAYS_MS,
      options: { allowThinkingDeltas?: boolean } = {},
    ) => {
      shouldAutoScrollRef.current = true;
      if (options.allowThinkingDeltas) {
        thinkingDeltaFollowAllowedRef.current = true;
      }
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
      }

      clearForcedCurrentScrollTimers();
      forcedCurrentScrollTimersRef.current = delays.map((delay) =>
        setTimeout(() => {
          if (!shouldAutoScrollRef.current) {
            return;
          }
          const currentContainer = containerRef.current?.parentElement;
          if (currentContainer) {
            scrollToBottom(currentContainer);
          }
        }, delay),
      );
    },
    [clearForcedCurrentScrollTimers, scrollToBottom],
  );

  // Preprocess messages into render items and group into turns
  const renderItems = useMemo(() => {
    const startedAt = highResolutionNowMs();
    markReloadPerfPhase("message_list_preprocess_start", {
      messages: messages.length,
      markdownAugments: Object.keys(markdownAugments ?? {}).length,
      hasActiveToolApproval: !!activeToolApproval,
    });
    const nextRenderItems = insertTranscriptDisplayObjects(
      preprocessMessages(messages, {
        markdown: markdownAugments,
        activeToolApproval,
      }),
      transcriptDisplayObjects,
    );
    const stabilized = stabilizeRenderItems(
      previousRenderItemsRef.current,
      nextRenderItems,
    );
    markReloadPerfPhase("message_list_preprocess_end", {
      messages: messages.length,
      renderItems: stabilized.length,
      durationMs: highResolutionNowMs() - startedAt,
    });
    return stabilized;
  }, [
    messages,
    markdownAugments,
    activeToolApproval,
    transcriptDisplayObjects,
  ]);
  useEffect(() => {
    previousRenderItemsRef.current = renderItems;
  }, [renderItems]);
  const thinkingItemCount = useMemo(
    () => countThinkingItems(renderItems),
    [renderItems],
  );
  const hasThinkingItems = thinkingItemCount > 0;
  const isThinkingItemAutoExpanded = useCallback(
    (itemId: string) => autoExpandedThinkingItemIds.has(itemId),
    [autoExpandedThinkingItemIds],
  );
  // Most-recent thinking item; only meaningful in latest-only mode, where its
  // auto-openness is recomputed each render rather than stored, so the prior
  // block collapses with no mutation as soon as a newer one arrives.
  const lastThinkingItemId = useMemo(() => {
    for (let i = renderItems.length - 1; i >= 0; i -= 1) {
      const item = renderItems[i];
      if (item?.type === "thinking") return item.id;
    }
    return null;
  }, [renderItems]);
  // Single source of truth for "is this thinking block expanded": an explicit
  // user toggle (tri-state: open / collapsed / absent) always wins; otherwise
  // the active auto policy decides. A manual expand is a permanent pin — the
  // override is never cleared — so it never auto-hides. See
  // topics/thinking-expand-latest-only.md.
  const resolveThinkingItemExpanded = useCallback(
    (itemId: string) => {
      const override = thinkingExpansionOverrides[itemId];
      if (override !== undefined) return override;
      return thinkingLatestOnly
        ? itemId === lastThinkingItemId
        : isThinkingItemAutoExpanded(itemId);
    },
    [
      isThinkingItemAutoExpanded,
      lastThinkingItemId,
      thinkingExpansionOverrides,
      thinkingLatestOnly,
    ],
  );
  const displayRenderItems = useMemo(
    () =>
      thinkingItemsVisible
        ? renderItems
        : renderItems.filter((item) => item.type !== "thinking"),
    [renderItems, thinkingItemsVisible],
  );
  useLayoutEffect(() => {
    const previousThinkingTextLengths = previousThinkingTextLengthsRef.current;
    const nextThinkingTextLengths = new Map<string, number>();
    let visibleThinkingDelta = false;

    for (const item of renderItems) {
      if (item.type !== "thinking") {
        continue;
      }
      const nextLength = item.thinking.length;
      nextThinkingTextLengths.set(item.id, nextLength);

      if (previousThinkingTextLengths === null || !thinkingItemsVisible) {
        continue;
      }

      const isExpanded = resolveThinkingItemExpanded(item.id);
      const previousLength = previousThinkingTextLengths.get(item.id) ?? 0;
      if (isExpanded && nextLength > previousLength) {
        visibleThinkingDelta = true;
      }
    }

    previousThinkingTextLengthsRef.current = nextThinkingTextLengths;

    if (visibleThinkingDelta && !thinkingDeltaFollowAllowedRef.current) {
      stopFollowingForUserScroll(containerRef.current?.parentElement);
    }
  }, [
    renderItems,
    resolveThinkingItemExpanded,
    stopFollowingForUserScroll,
    thinkingItemsVisible,
  ]);
  useLayoutEffect(() => {
    const previouslyObservedThinkingIds = observedThinkingItemIdsRef.current;
    const existingThinkingIds = new Set<string>();
    for (const item of renderItems) {
      if (item.type === "thinking") {
        existingThinkingIds.add(item.id);
      }
    }
    observedThinkingItemIdsRef.current = existingThinkingIds;
    const seedHistoricalThinking =
      existingThinkingIds.size > 0 &&
      providerExpandsHistoricalThinking(provider) &&
      autoExpandedHistoricalThinkingProviderRef.current !== provider;
    if (seedHistoricalThinking) {
      autoExpandedHistoricalThinkingProviderRef.current = provider ?? null;
    }

    setAutoExpandedThinkingItemIds((previous) => {
      const next = new Set<string>();
      let changed = false;
      for (const itemId of previous) {
        if (existingThinkingIds.has(itemId)) {
          next.add(itemId);
        } else {
          changed = true;
        }
      }

      if (seedHistoricalThinking) {
        for (const itemId of existingThinkingIds) {
          if (!next.has(itemId)) {
            next.add(itemId);
            changed = true;
          }
        }
      } else if (previouslyObservedThinkingIds !== null) {
        for (const itemId of existingThinkingIds) {
          if (!previouslyObservedThinkingIds.has(itemId) && !next.has(itemId)) {
            next.add(itemId);
            changed = true;
          }
        }
      }

      return changed ? next : previous;
    });
  }, [provider, renderItems]);
  const turnGroups = useMemo(() => {
    const startedAt = highResolutionNowMs();
    const grouped = groupItemsIntoTurns(displayRenderItems);
    markReloadPerfPhase("message_list_group_end", {
      renderItems: displayRenderItems.length,
      turnGroups: grouped.length,
      durationMs: highResolutionNowMs() - startedAt,
    });
    return grouped;
  }, [displayRenderItems]);
  useEffect(() => {
    markReloadPerfPhase("message_list_commit_effect", {
      messages: messages.length,
      renderItems: displayRenderItems.length,
      turnGroups: turnGroups.length,
    });
  }, [messages.length, displayRenderItems.length, turnGroups.length]);
  const hasUserSearchableTurn = useMemo(
    () => displayRenderItems.some((item) => getSearchableUserTurnPreview(item)),
    [displayRenderItems],
  );
  const getUserTurnNavAnchors = useCallback((): UserTurnNavAnchor[] => {
    const anchors: UserTurnNavAnchor[] = [];
    for (const item of displayRenderItems) {
      const preview = getSearchableUserTurnPreview(item);
      if (!preview) {
        continue;
      }
      anchors.push({ id: item.id, preview });
    }
    return anchors;
  }, [displayRenderItems]);
  const searchReady =
    userTurnSearch.active &&
    normalizeSearchText(userTurnSearch.query).length >= 2;
  const includeUserTurnSearchAnchors =
    searchReady && userTurnSearch.scope === "user";
  const userTurnSearchAnchors = useMemo<UserTurnNavAnchor[]>(() => {
    if (!includeUserTurnSearchAnchors) {
      return [];
    }
    const anchors: UserTurnNavAnchor[] = [];
    for (const item of displayRenderItems) {
      if (item.type !== "user_prompt" || item.isSubagent) {
        continue;
      }
      const text = getPromptTextForCorrection(item.content);
      const preview = getSearchPreviewFallback(text);
      if (preview && !isSessionSetupText(preview)) {
        anchors.push({ id: item.id, preview, searchText: text });
      }
    }
    return anchors;
  }, [includeUserTurnSearchAnchors, displayRenderItems]);
  const includeAllTurnSearchAnchors =
    searchReady && userTurnSearch.scope === "all";
  const sessionTurnNavAnchors = useMemo<UserTurnNavAnchor[]>(() => {
    if (!includeAllTurnSearchAnchors) {
      return [];
    }
    const anchors: UserTurnNavAnchor[] = [];
    for (const item of displayRenderItems) {
      if (item.type === "user_prompt") {
        const text = getPromptTextForCorrection(item.content);
        const preview = getSearchPreviewFallback(text);
        if (preview && !isSessionSetupText(preview)) {
          anchors.push({ id: item.id, preview, searchText: text });
        }
        continue;
      }
      if (item.type === "text") {
        const preview = getSearchPreviewFallback(item.text);
        if (preview) {
          anchors.push({ id: item.id, preview, searchText: item.text });
        }
        continue;
      }
      if (item.type === "system") {
        const systemSearchText = getSystemSearchText(item);
        const preview = getSearchPreviewFallback(systemSearchText);
        if (preview) {
          anchors.push({
            id: item.id,
            preview,
            searchText: systemSearchText,
          });
        }
      }
    }
    return anchors;
  }, [includeAllTurnSearchAnchors, displayRenderItems]);
  const includeFullSessionSearchAnchors =
    searchReady && userTurnSearch.scope === "full";
  const fullSessionSearchAnchors = useMemo<UserTurnNavAnchor[]>(() => {
    if (!includeFullSessionSearchAnchors) {
      return [];
    }
    const anchors: UserTurnNavAnchor[] = [];
    for (const group of turnGroups) {
      if (group.isUserPrompt) {
        const item = group.items[0];
        const anchor = item ? getFullSessionSearchAnchorForItem(item) : null;
        if (anchor) {
          anchors.push(anchor);
        }
        continue;
      }

      for (const segment of buildAssistantRenderSegments(group.items)) {
        anchors.push(...getFullSessionSearchAnchorsForSegment(segment));
      }
    }
    return anchors;
  }, [includeFullSessionSearchAnchors, turnGroups]);
  const activeSearchAnchors =
    userTurnSearch.scope === "full"
      ? fullSessionSearchAnchors
      : userTurnSearch.scope === "all"
        ? sessionTurnNavAnchors
        : userTurnSearchAnchors;
  const userTurnSearchMatches = useMemo(() => {
    if (!searchReady) {
      return [];
    }
    const query = normalizeSearchText(
      userTurnSearch.query,
      userTurnSearch.caseSensitive,
    );
    return activeSearchAnchors.filter((anchor) =>
      normalizeSearchText(
        anchor.searchText ?? anchor.preview,
        userTurnSearch.caseSensitive,
      ).includes(query),
    );
  }, [
    activeSearchAnchors,
    searchReady,
    userTurnSearch.caseSensitive,
    userTurnSearch.query,
  ]);
  const userTurnSearchMatchIds = useMemo(
    () => new Set(userTurnSearchMatches.map((anchor) => anchor.id)),
    [userTurnSearchMatches],
  );
  const userTurnSearchMatchTargetIds = useMemo(
    () =>
      new Set(
        userTurnSearchMatches.map((anchor) => anchor.targetId ?? anchor.id),
      ),
    [userTurnSearchMatches],
  );
  const userTurnSearchPreviewsById = useMemo(() => {
    const previewsById = new Map<string, string>();
    if (!searchReady) {
      return previewsById;
    }
    for (const anchor of userTurnSearchMatches) {
      previewsById.set(
        anchor.id,
        buildSearchPreview(
          anchor.searchText ?? anchor.preview,
          userTurnSearch.query,
          userTurnSearch.caseSensitive,
        ),
      );
    }
    return previewsById;
  }, [
    searchReady,
    userTurnSearch.caseSensitive,
    userTurnSearch.query,
    userTurnSearchMatches,
  ]);
  const getNavigatorAnchors = useCallback(
    () =>
      searchReady
        ? userTurnSearchMatches
        : userTurnSearch.active
          ? []
          : getUserTurnNavAnchors(),
    [
      getUserTurnNavAnchors,
      searchReady,
      userTurnSearch.active,
      userTurnSearchMatches,
    ],
  );
  const selectedSearchAnchor =
    userTurnSearch.selectedId && searchReady
      ? (activeSearchAnchors.find(
          (anchor) => anchor.id === userTurnSearch.selectedId,
        ) ?? null)
      : null;
  const selectedSearchTargetId =
    selectedSearchAnchor?.targetId ?? selectedSearchAnchor?.id ?? null;
  selectedSearchTargetIdRef.current = selectedSearchTargetId;
  const userTurnSearchPreview =
    selectedSearchAnchor && searchReady
      ? (userTurnSearchPreviewsById.get(selectedSearchAnchor.id) ?? null)
      : null;
  const userTurnNavSearchState = useMemo<UserTurnNavSearchState | null>(
    () =>
      searchReady
        ? {
            activeId: selectedSearchAnchor?.id ?? null,
            caseSensitive: userTurnSearch.caseSensitive,
            matchIds: userTurnSearchMatchIds,
            preview: userTurnSearchPreview,
            previewsById: userTurnSearchPreviewsById,
            query: userTurnSearch.query,
          }
        : null,
    [
      searchReady,
      selectedSearchAnchor?.id,
      userTurnSearch.caseSensitive,
      userTurnSearch.query,
      userTurnSearchPreviewsById,
      userTurnSearchMatchIds,
      userTurnSearchPreview,
    ],
  );

  useEffect(() => {
    dispatchSessionIsearchGuideState({
      active: userTurnSearch.active,
      scope: userTurnSearch.scope,
    });
  }, [userTurnSearch.active, userTurnSearch.scope]);

  useEffect(
    () => () => {
      dispatchSessionIsearchGuideState({ active: false, scope: "user" });
    },
    [],
  );
  useEffect(() => {
    const handleCopy = (event: ClipboardEvent) => {
      const root = containerRef.current;
      if (!root) {
        return;
      }

      copyMarkdownSelectionToClipboard(event, root);
    };

    document.addEventListener("copy", handleCopy);
    return () => document.removeEventListener("copy", handleCopy);
  }, []);

  useEffect(() => {
    if (!onQuoteSelection) {
      setFloatingQuoteButton(null);
      return;
    }

    const updateFloatingQuoteButton = (pointerEnd?: {
      clientX: number;
      clientY: number;
      placeBelow?: boolean;
    }) => {
      const root = containerRef.current;
      const selection = root?.ownerDocument.getSelection();
      if (
        !root ||
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0 ||
        extractMarkdownSnippetsFromSelection(root).length === 0
      ) {
        setFloatingQuoteButton(null);
        return;
      }

      const range = selection.getRangeAt(selection.rangeCount - 1);
      const rect = pointerEnd ? null : range.getBoundingClientRect();
      if (!pointerEnd && rect && rect.width === 0 && rect.height === 0) {
        setFloatingQuoteButton(null);
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const clientX = pointerEnd?.clientX ?? rect?.right ?? rootRect.left;
      const clientY = pointerEnd?.clientY ?? rect?.top ?? rootRect.top;
      const maxTop = Math.max(
        0,
        root.scrollHeight - SELECTION_QUOTE_BUTTON_SIZE_PX,
      );
      const maxLeft = Math.max(
        0,
        root.clientWidth - SELECTION_QUOTE_BUTTON_SIZE_PX,
      );
      setFloatingQuoteButton({
        top: clampNumber(
          pointerEnd?.placeBelow
            ? clientY - rootRect.top + SELECTION_QUOTE_BUTTON_GAP_PX
            : clientY -
                rootRect.top -
                SELECTION_QUOTE_BUTTON_SIZE_PX -
                SELECTION_QUOTE_BUTTON_GAP_PX,
          0,
          maxTop,
        ),
        left: clampNumber(
          clientX - rootRect.left + SELECTION_QUOTE_BUTTON_GAP_PX,
          0,
          maxLeft,
        ),
      });
    };
    const handlePointerDown = (event: PointerEvent) => {
      const root = containerRef.current;
      if (!root?.contains(event.target as Node | null)) {
        selectionPointerStartRef.current = null;
        return;
      }
      selectionPointerStartRef.current = { clientY: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      const start = selectionPointerStartRef.current;
      selectionPointerStartRef.current = null;
      window.setTimeout(() => {
        updateFloatingQuoteButton({
          clientX: event.clientX,
          clientY: event.clientY,
          placeBelow: start ? event.clientY > start.clientY : false,
        });
      }, 0);
    };
    const updateFromSelectionRange = () => updateFloatingQuoteButton();

    document.addEventListener("selectionchange", updateFromSelectionRange);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("resize", updateFromSelectionRange);
    window.addEventListener("scroll", updateFromSelectionRange, true);
    return () => {
      document.removeEventListener("selectionchange", updateFromSelectionRange);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("resize", updateFromSelectionRange);
      window.removeEventListener("scroll", updateFromSelectionRange, true);
    };
  }, [onQuoteSelection]);

  useEffect(() => {
    if (!onQuoteSelection) {
      return;
    }
    const handleSelectionTyping = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.key.length !== 1 ||
        isInteractiveScrollTarget(event.target)
      ) {
        return;
      }
      if (!applyQuoteFromSelection(event.key)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleSelectionTyping, true);
    return () =>
      window.removeEventListener("keydown", handleSelectionTyping, true);
  }, [applyQuoteFromSelection, onQuoteSelection]);
  const latestVisibleTimestampMs = useMemo(() => {
    let latest: number | null = null;
    const includeTimestamp = (timestampMs: number | null) => {
      if (timestampMs === null) return;
      latest = latest === null ? timestampMs : Math.max(latest, timestampMs);
    };

    for (const item of displayRenderItems) {
      includeTimestamp(getLatestMessageTimestampMs(item.sourceMessages));
    }
    for (const pending of pendingMessages) {
      includeTimestamp(parseTimestampMs(pending.timestamp));
    }
    for (const deferred of deferredMessages) {
      includeTimestamp(parseTimestampMs(deferred.timestamp));
    }
    for (const aside of btwAsides) {
      includeTimestamp(parseTimestampMs(aside.historyAt ?? aside.updatedAt));
    }

    return latest;
  }, [displayRenderItems, pendingMessages, deferredMessages, btwAsides]);
  const composerTailItems = useMemo(() => {
    let sourceIndex = 0;
    const items: ComposerTailItem[] = [];

    for (const pending of pendingMessages) {
      items.push({
        kind: "pending",
        key: pending.tempId,
        message: pending,
        sourceIndex: sourceIndex++,
      });
    }
    deferredMessages.forEach((deferred, deferredIndex) => {
      items.push({
        kind: "deferred",
        key: deferred.tempId ?? `deferred-${deferredIndex}`,
        message: deferred,
        deferredIndex,
        sourceIndex: sourceIndex++,
      });
    });

    return items.sort(compareComposerTailItems);
  }, [pendingMessages, deferredMessages]);
  const composerTailLanePositions = useMemo(() => {
    const positions = new Map<string, ComposerTailLanePosition>();
    let regularIndex = 0;
    let patientIndex = 0;

    for (const item of composerTailItems) {
      if (item.kind !== "deferred") {
        continue;
      }
      if (isPatientDeferredMessage(item.message)) {
        positions.set(item.key, { patientIndex });
        patientIndex += 1;
      } else {
        positions.set(item.key, { regularIndex });
        regularIndex += 1;
      }
    }

    return positions;
  }, [composerTailItems]);
  const latestCorrectablePrompt = useMemo(() => {
    if (!onCorrectLatestUserMessage) return null;

    for (let index = renderItems.length - 1; index >= 0; index -= 1) {
      const item = renderItems[index];
      if (item?.type !== "user_prompt" || item.isSubagent) {
        continue;
      }
      const content = getPromptTextForCorrection(item.content);
      if (!content || isSessionSetupText(content)) {
        continue;
      }
      return { id: item.id, content };
    }
    return null;
  }, [renderItems, onCorrectLatestUserMessage]);
  const visibleTurnGroups = useMemo(() => {
    if (!searchReady || userTurnSearchMatchIds.size === 0) {
      return turnGroups;
    }

    let currentUserTurnId: string | null = null;
    const visibleGroups: typeof turnGroups = [];
    for (const group of turnGroups) {
      const firstItem = group.items[0];
      if (group.isUserPrompt && firstItem?.type === "user_prompt") {
        currentUserTurnId = firstItem.id;
      }
      const isFullSessionVisible =
        userTurnSearch.scope === "full" &&
        (group.items.some((item) =>
          userTurnSearchMatchTargetIds.has(item.id),
        ) ||
          buildAssistantRenderSegments(group.items).some((segment) =>
            segment.kind === "explored"
              ? userTurnSearchMatchTargetIds.has(segment.id) ||
                segment.items.some((item) =>
                  userTurnSearchMatchTargetIds.has(item.id),
                )
              : userTurnSearchMatchTargetIds.has(segment.item.id),
          ));
      const isVisible =
        userTurnSearch.scope === "full"
          ? isFullSessionVisible
          : userTurnSearch.scope === "all"
            ? group.items.some((item) => userTurnSearchMatchIds.has(item.id)) ||
              (!!currentUserTurnId &&
                userTurnSearchMatchIds.has(currentUserTurnId))
            : !!currentUserTurnId &&
              userTurnSearchMatchIds.has(currentUserTurnId);
      if (isVisible) {
        visibleGroups.push(group);
      }
    }
    return visibleGroups;
  }, [
    searchReady,
    turnGroups,
    userTurnSearch.scope,
    userTurnSearchMatchIds,
    userTurnSearchMatchTargetIds,
  ]);
  const visibleTimelineEntries = useMemo(() => {
    const entries: Array<
      | {
          kind: "turn";
          key: string;
          timestampMs: number | null;
          ordinal: number;
          group: (typeof visibleTurnGroups)[number];
        }
      | {
          kind: "btw";
          key: string;
          timestampMs: number | null;
          ordinal: number;
          aside: BtwAsideTimelineItem;
        }
    > = [];

    visibleTurnGroups.forEach((group, index) => {
      let timestampMs: number | null = null;
      for (const item of group.items) {
        const itemTimestamp = getLatestMessageTimestampMs(item.sourceMessages);
        if (itemTimestamp !== null) {
          timestampMs =
            timestampMs === null
              ? itemTimestamp
              : Math.max(timestampMs, itemTimestamp);
        }
      }
      const firstItem = group.items[0];
      entries.push({
        kind: "turn",
        key: firstItem ? `turn-${firstItem.id}` : `turn-${index}`,
        timestampMs,
        ordinal: index,
        group,
      });
    });

    btwAsides.forEach((aside, index) => {
      entries.push({
        kind: "btw",
        key: `btw-${aside.id}`,
        timestampMs: parseTimestampMs(aside.historyAt ?? aside.updatedAt),
        ordinal: visibleTurnGroups.length + index,
        aside,
      });
    });

    return entries.sort((left, right) => {
      if (left.timestampMs !== null && right.timestampMs !== null) {
        return (
          left.timestampMs - right.timestampMs || left.ordinal - right.ordinal
        );
      }
      if (left.timestampMs !== null) return -1;
      if (right.timestampMs !== null) return 1;
      return left.ordinal - right.ordinal;
    });
  }, [btwAsides, visibleTurnGroups]);

  const getThinkingItemExpanded = useCallback(
    (item: RenderItem) =>
      item.type === "thinking" && resolveThinkingItemExpanded(item.id),
    [resolveThinkingItemExpanded],
  );

  const toggleThinkingItemExpanded = useCallback(
    (item: RenderItem) => {
      if (item.type !== "thinking") {
        return;
      }
      // Absolute write against the currently-resolved state, never cleared:
      // toggling open from the auto state pins it open permanently.
      const next = !resolveThinkingItemExpanded(item.id);
      setThinkingExpansionOverrides((previous) => ({
        ...previous,
        [item.id]: next,
      }));
    },
    [resolveThinkingItemExpanded],
  );

  const noopToggleThinkingExpanded = useCallback(() => {}, []);

  const preserveScrollAfterTranscriptHeightChange = useCallback(
    (mutate: () => void) => {
      const messageList = containerRef.current;
      const scrollContainer = messageList?.parentElement;
      if (!messageList || !scrollContainer) {
        mutate();
        return;
      }

      const wasAtBottom = isNearScrollBottom(scrollContainer);
      const scrollTopBefore = scrollContainer.scrollTop;
      const scrollHeightBefore = scrollContainer.scrollHeight;
      const anchorBefore = wasAtBottom
        ? null
        : getFirstVisibleRenderAnchor(messageList, scrollContainer);

      mutate();

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const nextMessageList = containerRef.current;
          const nextScrollContainer =
            nextMessageList?.parentElement ?? scrollContainer;
          isProgrammaticScrollRef.current = true;

          if (wasAtBottom) {
            scrollToBottom(nextScrollContainer);
            return;
          }

          let restoredFromAnchor = false;
          if (anchorBefore && nextMessageList) {
            const row = findRenderRow(nextMessageList, anchorBefore.id);
            if (row) {
              const containerRect = nextScrollContainer.getBoundingClientRect();
              const rowRect = row.getBoundingClientRect();
              nextScrollContainer.scrollTop = Math.max(
                0,
                nextScrollContainer.scrollTop +
                  rowRect.top -
                  containerRect.top -
                  anchorBefore.topOffset,
              );
              restoredFromAnchor = true;
            }
          }

          if (!restoredFromAnchor) {
            const heightDelta =
              nextScrollContainer.scrollHeight - scrollHeightBefore;
            nextScrollContainer.scrollTop = Math.max(
              0,
              scrollTopBefore + heightDelta,
            );
          }
          lastHeightRef.current = nextScrollContainer.scrollHeight;
          requestAnimationFrame(() => {
            isProgrammaticScrollRef.current = false;
          });
        });
      });
    },
    [scrollToBottom],
  );

  const toggleThinkingItemsVisible = useCallback(() => {
    preserveScrollAfterTranscriptHeightChange(() => {
      setThinkingItemsVisible((previous) => {
        const next = !previous;
        saveSessionThinkingVisible(next);
        return next;
      });
    });
  }, [preserveScrollAfterTranscriptHeightChange]);

  const toggleThinkingLatestOnly = useCallback(() => {
    preserveScrollAfterTranscriptHeightChange(() => {
      setThinkingLatestOnly((previous) => {
        const next = !previous;
        saveSessionThinkingLatestOnly(next);
        return next;
      });
    });
  }, [preserveScrollAfterTranscriptHeightChange]);

  const showNavMotionCue = useCallback((direction: "up" | "down") => {
    if (navMotionCueClearTimerRef.current !== null) {
      clearTimeout(navMotionCueClearTimerRef.current);
    }
    navMotionCueTokenRef.current += 1;
    setNavMotionCue({
      direction,
      token: navMotionCueTokenRef.current,
    });
    navMotionCueClearTimerRef.current = setTimeout(() => {
      setNavMotionCue(null);
      navMotionCueClearTimerRef.current = null;
    }, NAV_MOTION_CUE_CLEAR_MS);
  }, []);

  const moveUserTurnSearchSelection = useCallback(
    (direction: "previous" | "next") => {
      setUserTurnSearch((previous) => {
        if (!previous.active || userTurnSearchMatches.length === 0) {
          return previous;
        }
        const currentIndex = previous.selectedId
          ? userTurnSearchMatches.findIndex(
              (anchor) => anchor.id === previous.selectedId,
            )
          : -1;
        const step = direction === "previous" ? -1 : 1;
        const fallbackIndex =
          direction === "previous" ? userTurnSearchMatches.length - 1 : 0;
        const nextIndex =
          currentIndex >= 0
            ? (currentIndex + step + userTurnSearchMatches.length) %
              userTurnSearchMatches.length
            : fallbackIndex;
        const nextSelectedId = userTurnSearchMatches[nextIndex]?.id ?? null;
        return { ...previous, selectedId: nextSelectedId };
      });
    },
    [userTurnSearchMatches],
  );
  const stopUserTurnSearchArrowRepeat = useCallback(() => {
    if (searchArrowRepeatTimeoutRef.current !== null) {
      clearTimeout(searchArrowRepeatTimeoutRef.current);
      searchArrowRepeatTimeoutRef.current = null;
    }
    if (searchArrowRepeatIntervalRef.current !== null) {
      clearInterval(searchArrowRepeatIntervalRef.current);
      searchArrowRepeatIntervalRef.current = null;
    }
    searchArrowRepeatDirectionRef.current = null;
  }, []);
  const startUserTurnSearchArrowRepeat = useCallback(
    (direction: "previous" | "next") => {
      if (
        searchArrowRepeatDirectionRef.current === direction &&
        (searchArrowRepeatTimeoutRef.current !== null ||
          searchArrowRepeatIntervalRef.current !== null)
      ) {
        return;
      }
      stopUserTurnSearchArrowRepeat();
      searchArrowRepeatDirectionRef.current = direction;
      searchArrowRepeatTimeoutRef.current = setTimeout(() => {
        searchArrowRepeatTimeoutRef.current = null;
        moveUserTurnSearchSelection(direction);
        searchArrowRepeatIntervalRef.current = setInterval(() => {
          moveUserTurnSearchSelection(direction);
        }, SEARCH_ARROW_REPEAT_INTERVAL_MS);
      }, SEARCH_ARROW_REPEAT_DELAY_MS);
    },
    [moveUserTurnSearchSelection, stopUserTurnSearchArrowRepeat],
  );
  const selectUserTurnSearchMatch = useCallback((id: string) => {
    setUserTurnSearch((previous) =>
      previous.active ? { ...previous, selectedId: id } : previous,
    );
    requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
  }, []);
  const scrollToRenderId = useCallback(
    (
      id: string,
      behavior: ScrollBehavior,
      align: "start" | "center" = "start",
      showMotionCue = false,
    ) => {
      const messageList = containerRef.current;
      const scrollContainer = messageList?.parentElement;
      const row = findRenderRow(messageList, id);
      if (!scrollContainer || !row) return;
      shouldAutoScrollRef.current = false;
      setIsScrolledToBottom(false);
      const scrollRect = scrollContainer.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const offset =
        align === "center"
          ? Math.max(0, (scrollContainer.clientHeight - rowRect.height) / 2)
          : 12;
      const nextTop = Math.max(
        0,
        scrollContainer.scrollTop + rowRect.top - scrollRect.top - offset,
      );
      if (showMotionCue) {
        showNavMotionCue(nextTop < scrollContainer.scrollTop ? "up" : "down");
      }
      scrollContainer.scrollTo({
        top: nextTop,
        behavior,
      });
    },
    [showNavMotionCue],
  );

  const scrollToCurrent = useCallback(() => {
    forceScrollToCurrent(FOLLOW_CATCH_UP_DELAYS_MS, {
      allowThinkingDeltas: true,
    });
  }, [forceScrollToCurrent]);

  const closeUserTurnSearch = useCallback((restoreScroll: boolean) => {
    const scrollTopToRestore = restoreScroll
      ? searchOriginalScrollTopRef.current
      : null;
    const focusTarget = restoreScroll ? searchRestoreFocusRef.current : null;
    searchOriginalScrollTopRef.current = null;
    searchRestoreFocusRef.current = null;

    if (restoreScroll || focusTarget) {
      requestAnimationFrame(() => {
        const scrollContainer = containerRef.current?.parentElement;
        if (scrollContainer && scrollTopToRestore !== null) {
          scrollContainer.scrollTop = scrollTopToRestore;
        }
        if (focusTarget?.isConnected) {
          focusTarget.focus({ preventScroll: true });
        }
      });
    }

    setUserTurnSearch((previous) => {
      return {
        active: false,
        scope: previous.scope,
        query: "",
        caseSensitive: false,
        selectedId: null,
        originalScrollTop: null,
      };
    });
  }, []);

  const openUserTurnSearch = useCallback(
    (scope: SessionIsearchScope) => {
      const canSearch =
        scope === "user"
          ? hasUserSearchableTurn
          : displayRenderItems.length > 0;
      if (!canSearch) {
        return;
      }
      const activeElement = document.activeElement;
      searchRestoreFocusRef.current =
        activeElement instanceof HTMLElement && activeElement !== document.body
          ? activeElement
          : null;
      const scrollContainer = containerRef.current?.parentElement;
      searchOriginalScrollTopRef.current = scrollContainer?.scrollTop ?? null;
      setUserTurnSearch({
        active: true,
        scope,
        query: "",
        caseSensitive: false,
        selectedId: null,
        originalScrollTop: searchOriginalScrollTopRef.current,
      });
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    },
    [hasUserSearchableTurn, displayRenderItems.length],
  );

  const handleUserTurnSearchQueryChange = useCallback((query: string) => {
    setUserTurnSearch((previous) => ({
      ...previous,
      query,
      selectedId: null,
    }));
  }, []);

  const toggleUserTurnSearchCaseSensitive = useCallback(() => {
    setUserTurnSearch((previous) =>
      previous.active
        ? {
            ...previous,
            caseSensitive: !previous.caseSensitive,
            selectedId: null,
          }
        : previous,
    );
  }, []);

  useEffect(() => {
    if (!userTurnSearch.active) {
      stopUserTurnSearchArrowRepeat();
      return;
    }
    setUserTurnSearch((previous) => {
      if (!previous.active) {
        return previous;
      }
      let nextSelectedId: string | null = null;
      if (searchReady && userTurnSearchMatches.length > 0) {
        nextSelectedId =
          previous.selectedId && userTurnSearchMatchIds.has(previous.selectedId)
            ? previous.selectedId
            : (userTurnSearchMatches[userTurnSearchMatches.length - 1]?.id ??
              null);
      }
      if (previous.selectedId === nextSelectedId) {
        return previous;
      }
      return { ...previous, selectedId: nextSelectedId };
    });
  }, [
    searchReady,
    stopUserTurnSearchArrowRepeat,
    userTurnSearch.active,
    userTurnSearchMatches,
    userTurnSearchMatchIds,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "End" ||
          event.code === "End" ||
          event.key === "." ||
          event.code === "Period")
      ) {
        event.preventDefault();
        event.stopPropagation();
        scrollToCurrent();
        return;
      }
      if (isCtrlKeyShortcut(event, "o", "KeyO")) {
        event.preventDefault();
        event.stopPropagation();
        toggleThinkingItemsVisible();
        return;
      }
      const requestedScope = getSessionIsearchShortcutScope(event);
      if (requestedScope) {
        event.preventDefault();
        event.stopPropagation();
        if (userTurnSearch.active && userTurnSearch.scope === requestedScope) {
          moveUserTurnSearchSelection("previous");
        } else {
          openUserTurnSearch(requestedScope);
        }
        return;
      }
      if (!userTurnSearch.active) {
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === "ArrowUp" ? "previous" : "next";
        if (
          !event.repeat ||
          searchArrowRepeatDirectionRef.current !== direction
        ) {
          moveUserTurnSearchSelection(direction);
          startUserTurnSearchArrowRepeat(direction);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        stopUserTurnSearchArrowRepeat();
        closeUserTurnSearch(true);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const selectedId = selectedSearchTargetIdRef.current;
        stopUserTurnSearchArrowRepeat();
        closeUserTurnSearch(false);
        if (selectedId) {
          requestAnimationFrame(() =>
            scrollToRenderId(selectedId, "auto", "center", true),
          );
        }
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        stopUserTurnSearchArrowRepeat();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      stopUserTurnSearchArrowRepeat();
    };
  }, [
    closeUserTurnSearch,
    moveUserTurnSearchSelection,
    openUserTurnSearch,
    scrollToCurrent,
    scrollToRenderId,
    startUserTurnSearchArrowRepeat,
    stopUserTurnSearchArrowRepeat,
    toggleThinkingItemsVisible,
    userTurnSearch.active,
    userTurnSearch.scope,
  ]);

  // Load older messages with scroll position preservation
  const handleLoadOlder = useCallback(() => {
    if (!onLoadOlderMessages) return;
    const container = containerRef.current?.parentElement;
    if (!container) {
      onLoadOlderMessages();
      return;
    }
    // Capture scroll state before prepending older messages
    const scrollHeightBefore = container.scrollHeight;
    const scrollTopBefore = container.scrollTop;
    onLoadOlderMessages();
    // Restore scroll position after React re-renders with prepended messages
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scrollHeightAfter = container.scrollHeight;
        const heightDelta = scrollHeightAfter - scrollHeightBefore;
        isProgrammaticScrollRef.current = true;
        container.scrollTop = scrollTopBefore + heightDelta;
        lastHeightRef.current = container.scrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      });
    });
  }, [onLoadOlderMessages]);

  // Track scroll position to determine if user is near bottom.
  // Ignore programmatic scrolls - only user-initiated scrolls should affect auto-scroll state.
  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;

    const content = containerRef.current;
    const container = content?.parentElement;
    if (!content || !container) return;

    const atBottom = isAtScrollBottom(container, content);
    shouldAutoScrollRef.current = atBottom;
    thinkingDeltaFollowAllowedRef.current = atBottom;
    if (!atBottom) {
      clearForcedCurrentScrollTimers();
    }
    setIsScrolledToBottom(atBottom);
  }, [clearForcedCurrentScrollTimers]);

  // Attach scroll listener to parent container
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    container.addEventListener("scroll", handleScroll);

    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll]);

  // Cancel follow before browser scroll events when the user clearly tries to
  // move away from the live tail. Programmatic scroll bursts can otherwise keep
  // the scroll handler muted long enough to rubber-band the viewport back down.
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && !isInteractiveScrollTarget(event.target)) {
        stopFollowingForUserScroll(container);
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    };

    const handleTouchMove = (event: TouchEvent) => {
      const startY = touchStartYRef.current;
      const currentY = event.touches[0]?.clientY;
      if (
        startY !== null &&
        currentY !== undefined &&
        currentY - startY > TOUCH_SCROLL_CANCEL_THRESHOLD_PX &&
        !isInteractiveScrollTarget(event.target)
      ) {
        stopFollowingForUserScroll(container);
      }
    };

    const handleTouchEnd = () => {
      touchStartYRef.current = null;
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || isInteractiveScrollTarget(event.target)) {
        return;
      }
      const scrollbarWidth = container.offsetWidth - container.clientWidth;
      if (scrollbarWidth <= 0) {
        return;
      }
      const rect = container.getBoundingClientRect();
      if (event.clientX >= rect.right - scrollbarWidth) {
        stopFollowingForUserScroll(container);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isInteractiveScrollTarget(event.target)
      ) {
        return;
      }
      const target = event.target;
      const scrollTargetActive =
        target === document.body ||
        target === document ||
        eventTargetIsInside(target, container);
      if (!scrollTargetActive) {
        return;
      }
      if (
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey)
      ) {
        stopFollowingForUserScroll(container);
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    container.addEventListener("touchmove", handleTouchMove, {
      passive: true,
    });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });
    container.addEventListener("touchcancel", handleTouchEnd, {
      passive: true,
    });
    container.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
      container.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [stopFollowingForUserScroll]);

  // Use ResizeObserver to detect content height changes (handles async markdown rendering)
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    const scrollContainer = container;
    lastHeightRef.current = scrollContainer.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      const newHeight = scrollContainer.scrollHeight;
      const heightIncreased = newHeight > lastHeightRef.current;

      // Auto-scroll when content height increases and auto-scroll is enabled
      if (heightIncreased && shouldAutoScrollRef.current) {
        scrollToBottom(scrollContainer);
      } else {
        // A size change must never *start* following — only continue it (the
        // branch above). Re-arming here from proximity is what trapped the
        // reading area near the bottom. Just track the new height.
        lastHeightRef.current = newHeight;
      }
    });

    // Observe the inner container (message-list) since that's what changes size
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      // Clean up any pending scroll on unmount
      clearFollowUpScrollTimer();
      if (programmaticScrollReleaseRef.current !== null) {
        clearTimeout(programmaticScrollReleaseRef.current);
      }
      clearForcedCurrentScrollTimers();
      if (navMotionCueClearTimerRef.current !== null) {
        clearTimeout(navMotionCueClearTimerRef.current);
      }
    };
  }, [
    clearFollowUpScrollTimer,
    clearForcedCurrentScrollTimers,
    scrollToBottom,
  ]);

  // Preserve relative scroll position when the viewport is resized.
  useEffect(() => {
    let pendingFrame = 0;
    let anchorFromBottom = 0;
    let preserveAutoScroll = true;

    const handleResize = () => {
      const container = containerRef.current?.parentElement;
      if (!container || isProgrammaticScrollRef.current) return;

      preserveAutoScroll = shouldAutoScrollRef.current;
      anchorFromBottom = preserveAutoScroll
        ? 0
        : Math.max(
            0,
            container.scrollHeight -
              container.scrollTop -
              container.clientHeight,
          );

      if (pendingFrame !== 0) {
        cancelAnimationFrame(pendingFrame);
      }

      pendingFrame = requestAnimationFrame(() => {
        const resizeContainer = containerRef.current?.parentElement;
        if (!resizeContainer) return;

        if (preserveAutoScroll) {
          scrollToBottom(resizeContainer);
          return;
        }

        const targetScrollTop = Math.max(
          0,
          resizeContainer.scrollHeight -
            resizeContainer.clientHeight -
            anchorFromBottom,
        );

        isProgrammaticScrollRef.current = true;
        resizeContainer.scrollTop = targetScrollTop;
        lastHeightRef.current = resizeContainer.scrollHeight;
        const nearBottom = isNearScrollBottom(resizeContainer);
        shouldAutoScrollRef.current = nearBottom;
        setIsScrolledToBottom(nearBottom);

        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (pendingFrame !== 0) {
        cancelAnimationFrame(pendingFrame);
      }
    };
  }, [scrollToBottom]);

  // Force scroll to bottom when scrollTrigger changes (user sent a message)
  useEffect(() => {
    if (scrollTrigger > 0) {
      forceScrollToCurrent(SEND_CATCH_UP_DELAYS_MS);
    }
  }, [forceScrollToCurrent, scrollTrigger]);

  // Initial scroll to bottom on first render
  useEffect(() => {
    if (isInitialLoadRef.current && displayRenderItems.length > 0) {
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
      }
      isInitialLoadRef.current = false;
    }
  }, [displayRenderItems.length, scrollToBottom]);

  const searchPanelTarget =
    userTurnSearch.active && typeof document !== "undefined"
      ? document.querySelector<HTMLElement>(".session-input-inner")
      : null;
  const followButtonTarget =
    !isScrolledToBottom && typeof document !== "undefined"
      ? document.querySelector<HTMLElement>(".session-input-inner")
      : null;
  const getItemStaleNowMs = useCallback(
    (item: RenderItem) =>
      getLatestMessageTimestampMs(item.sourceMessages) ===
      latestVisibleTimestampMs
        ? nowMs
        : undefined,
    [latestVisibleTimestampMs, nowMs],
  );
  const searchPanel = userTurnSearch.active ? (
    <div
      className="user-turn-search-panel"
      role="search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          closeUserTurnSearch(false);
        }
      }}
    >
      <div className="user-turn-search-main">
        <span className="user-turn-search-label">
          {getSearchScopeLabel(userTurnSearch.scope)}
        </span>
        <input
          ref={searchInputRef}
          className="user-turn-search-input"
          value={userTurnSearch.query}
          onChange={(event) =>
            handleUserTurnSearchQueryChange(event.target.value)
          }
          placeholder="reverse search"
          aria-label={getSearchScopeAriaLabel(userTurnSearch.scope)}
        />
        <button
          type="button"
          className={[
            "user-turn-search-case-toggle",
            userTurnSearch.caseSensitive ? "is-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label="Case-sensitive search"
          aria-pressed={userTurnSearch.caseSensitive}
          title={
            userTurnSearch.caseSensitive
              ? "Case-sensitive search on"
              : "Case-sensitive search off"
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleUserTurnSearchCaseSensitive}
        >
          Aa
        </button>
        <span className="user-turn-search-count">
          {!searchReady
            ? "2+ chars"
            : userTurnSearchMatches.length > 0
              ? `${Math.max(
                  1,
                  userTurnSearchMatches.findIndex(
                    (anchor) => anchor.id === userTurnSearch.selectedId,
                  ) + 1,
                )}/${userTurnSearchMatches.length}`
              : "0/0"}
        </span>
      </div>
      <div className="user-turn-search-help">
        <span>
          {getSearchScopeKeys(userTurnSearch.scope)} prev · ↑↓ matches · click
          selects
        </span>
        <span>Enter jump+close · Esc cancel · Aa case</span>
      </div>
    </div>
  ) : null;
  const followButton = !isScrolledToBottom ? (
    <button
      type="button"
      className="message-follow-toggle"
      onClick={scrollToCurrent}
      aria-label="Follow latest session output"
      title="Follow latest session output"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 5v14" />
        <path d="m19 12-7 7-7-7" />
      </svg>
      <span>Follow</span>
    </button>
  ) : null;
  return (
    <>
      <UserTurnNavigator
        getAnchors={getNavigatorAnchors}
        messageListRef={containerRef}
        motionCue={navMotionCue}
        onNavigateStart={() => {
          shouldAutoScrollRef.current = false;
          setIsScrolledToBottom(false);
        }}
        onSearchMatchSelect={selectUserTurnSearchMatch}
        onTrimAnchor={onTrimBeforeUserMessage}
        onForkBeforeAnchor={onForkBeforeUserMessage}
        onForkAfterAnchor={onForkAfterUserMessage}
        onCopyAnchor={onCopyUserMessage}
        searchState={userTurnNavSearchState}
      />
      {searchPanelTarget && searchPanel
        ? createPortal(searchPanel, searchPanelTarget)
        : searchPanel}
      {followButtonTarget && followButton
        ? createPortal(followButton, followButtonTarget)
        : followButton}
      <div className="message-list" ref={containerRef}>
        {floatingQuoteButton && (
          <button
            type="button"
            className="selection-quote-button"
            style={{
              top: `${floatingQuoteButton.top}px`,
              left: `${floatingQuoteButton.left}px`,
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyQuoteFromSelection()}
            aria-label={t("sessionQuoteSelection")}
            title={t("sessionQuoteSelection")}
          >
            &gt;
          </button>
        )}
        {(hasOlderMessages || clientTailActive) && (
          <div className="load-older-messages">
            {clientTailActive && (
              <span className="load-older-status">
                Recent transcript loaded
              </span>
            )}
            {hasOlderMessages && (
              <button
                type="button"
                className="load-older-button"
                onClick={handleLoadOlder}
                disabled={loadingOlder}
              >
                {loadingOlder ? (
                  <>
                    <span className="spinning">&#x21BB;</span> Loading...
                  </>
                ) : (
                  "Load older messages"
                )}
              </button>
            )}
          </div>
        )}
        {visibleTimelineEntries.map((entry) => {
          if (entry.kind === "btw") {
            return (
              <BtwAsideTimelineCard
                key={entry.key}
                aside={entry.aside}
                onFocus={onFocusBtwAside}
                onDone={onDoneBtwAside}
                onStop={onStopBtwAside}
                onToggleExpanded={onToggleBtwAsideExpanded}
                onTransferTurn={onTransferBtwAsideTurn}
              />
            );
          }

          const { group } = entry;
          if (group.isStandalone) {
            const item = group.items[0];
            if (!item) return null;
            return (
              <RenderItemComponent
                key={item.id}
                item={item}
                isStreaming={isStreaming}
                thinkingExpanded={false}
                toggleThinkingExpanded={noopToggleThinkingExpanded}
                sessionProvider={provider}
                getForkSummaryTargetHref={getForkSummaryTargetHref}
                onCancelForkSummary={onCancelForkSummary}
                onToggleForkSummaryAutoOpen={onToggleForkSummaryAutoOpen}
                onFollowForkSummary={onFollowForkSummary}
              />
            );
          }
          if (group.isUserPrompt) {
            // User prompts render directly without timeline wrapper
            const item = group.items[0];
            if (!item) return null;
            return (
              <RenderItemComponent
                key={item.id}
                item={item}
                isStreaming={isStreaming}
                thinkingExpanded={getThinkingItemExpanded(item)}
                toggleThinkingExpanded={noopToggleThinkingExpanded}
                sessionProvider={provider}
                onCorrectUserPrompt={
                  latestCorrectablePrompt?.id === item.id
                    ? () =>
                        onCorrectLatestUserMessage?.(
                          latestCorrectablePrompt.id,
                          latestCorrectablePrompt.content,
                        )
                    : undefined
                }
                onTrimBeforeUserPrompt={
                  onTrimBeforeUserMessage && !item.isSubagent
                    ? () => onTrimBeforeUserMessage(item.id)
                    : undefined
                }
                onForkBeforeUserPrompt={
                  onForkBeforeUserMessage && !item.isSubagent
                    ? () => onForkBeforeUserMessage(item.id)
                    : undefined
                }
                staleNowMs={getItemStaleNowMs(item)}
                latestVisibleTimestampMs={latestVisibleTimestampMs}
              />
            );
          }
          // Assistant items wrapped in timeline container - key based on first item
          const firstItem = group.items[0];
          if (!firstItem) return null;
          return (
            <div key={entry.key} className="assistant-turn">
              {buildAssistantRenderSegments(group.items).map((segment) => {
                if (segment.kind === "explored") {
                  const segmentTimestampMs = getLatestItemsTimestampMs(
                    segment.items,
                  );
                  return (
                    <ExploredToolGroup
                      key={segment.id}
                      id={segment.id}
                      items={segment.items}
                      sessionProvider={provider}
                      staleNowMs={
                        segmentTimestampMs === latestVisibleTimestampMs
                          ? nowMs
                          : undefined
                      }
                      latestVisibleTimestampMs={latestVisibleTimestampMs}
                    />
                  );
                }

                const { item } = segment;
                const itemIndex = group.items.indexOf(item);
                return (
                  <RenderItemComponent
                    key={item.id}
                    item={item}
                    isStreaming={isStreaming}
                    thinkingExpanded={getThinkingItemExpanded(item)}
                    toggleThinkingExpanded={
                      item.type === "thinking"
                        ? () => toggleThinkingItemExpanded(item)
                        : noopToggleThinkingExpanded
                    }
                    sessionProvider={provider}
                    onTrimBeforeUserPrompt={
                      item.type === "user_prompt" &&
                      onTrimBeforeUserMessage &&
                      !item.isSubagent
                        ? () => onTrimBeforeUserMessage(item.id)
                        : undefined
                    }
                    onForkBeforeUserPrompt={
                      item.type === "user_prompt" &&
                      onForkBeforeUserMessage &&
                      !item.isSubagent
                        ? () => onForkBeforeUserMessage(item.id)
                        : undefined
                    }
                    onQuoteTextBlock={
                      item.type === "text" ? handleQuoteTextBlock : undefined
                    }
                    alwaysShowQuoteCircle={alwaysShowQuoteCircles}
                    staleNowMs={getItemStaleNowMs(item)}
                    latestVisibleTimestampMs={latestVisibleTimestampMs}
                    thinkingDurationMs={getThinkingDurationMs(
                      item,
                      group.items,
                      itemIndex,
                      nowMs,
                    )}
                  />
                );
              })}
            </div>
          );
        })}
        {composerTailItems.map((tailItem) => {
          const timestampMs = parseTimestampMs(tailItem.message.timestamp);
          const showAgeByDefault =
            latestVisibleTimestampMs === timestampMs &&
            isStaleTimestamp(timestampMs, nowMs, MESSAGE_STALE_THRESHOLD_MS);

          if (tailItem.kind === "pending") {
            const pending = tailItem.message;
            return (
              <div
                key={tailItem.key}
                className={`pending-message message-render-row ${
                  timestampMs !== null ? "has-message-age" : ""
                } ${showAgeByDefault ? "is-message-age-visible" : ""}`}
              >
                <div className="message-render-content">
                  <div className="message-user-prompt pending-message-bubble">
                    {pending.content}
                  </div>
                  {pending.attachments?.length ? (
                    <div className="attachment-list pending-message-attachments">
                      {pending.attachments.map((file) => (
                        <AttachmentChip
                          key={file.id}
                          attachmentId={file.id}
                          originalName={file.originalName}
                          path={file.path}
                          mimeType={file.mimeType}
                          sizeLabel={formatSize(file.size)}
                          imageWidth={file.width}
                          imageHeight={file.height}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div className="pending-message-footer">
                    <div className="pending-message-status">
                      {pending.status || "Sending..."}
                    </div>
                    <div className="deferred-message-actions">
                      <CopyTextButton
                        text={pending.content}
                        label="Copy message text"
                        className="deferred-message-action deferred-message-action-copy"
                        showTextLabel
                        onClick={(event) => event.stopPropagation()}
                      />
                    </div>
                  </div>
                </div>
                <MessageAge timestampMs={timestampMs} nowMs={nowMs} />
              </div>
            );
          }

          const deferred = tailItem.message;
          const isPatientDeferred = isPatientDeferredMessage(deferred);
          const lanePosition = composerTailLanePositions.get(tailItem.key);
          const deferredStatus = getDeferredMessageStatus({
            isPatient: isPatientDeferred,
            lanePosition,
            timestampMs,
            nowMs,
          });
          return (
            <div
              key={tailItem.key}
              className={`deferred-message message-render-row ${
                timestampMs !== null ? "has-message-age" : ""
              } ${showAgeByDefault ? "is-message-age-visible" : ""}`}
            >
              <div className="message-render-content">
                <div className="message-user-prompt deferred-message-bubble">
                  {deferred.content}
                </div>
                {deferred.attachments?.length ? (
                  <div className="attachment-list deferred-message-attachments-list">
                    {deferred.attachments.map((file) => (
                      <AttachmentChip
                        key={file.id}
                        attachmentId={file.id}
                        originalName={file.originalName}
                        path={file.path}
                        mimeType={file.mimeType}
                        sizeLabel={formatSize(file.size)}
                        imageWidth={file.width}
                        imageHeight={file.height}
                      />
                    ))}
                  </div>
                ) : null}
                <div className="deferred-message-footer">
                  <span
                    className="deferred-message-status"
                    title={
                      isPatientDeferred
                        ? "Patient queue waits for verified quiet. Regular queued messages may pass it."
                        : undefined
                    }
                  >
                    {deferredStatus}
                  </span>
                  {deferred.attachmentCount ? (
                    <span
                      className="deferred-message-attachments"
                      title={`${deferred.attachmentCount} attachment${
                        deferred.attachmentCount === 1 ? "" : "s"
                      } queued`}
                      role="img"
                      aria-label={`${deferred.attachmentCount} attachment${
                        deferred.attachmentCount === 1 ? "" : "s"
                      } queued`}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                      </svg>
                      <span>{deferred.attachmentCount}</span>
                    </span>
                  ) : null}
                  <div className="deferred-message-actions">
                    <CopyTextButton
                      text={deferred.content}
                      label="Copy queued message"
                      className="deferred-message-action deferred-message-action-copy"
                      showTextLabel
                      onClick={(event) => event.stopPropagation()}
                    />
                    {deferred.tempId && onCancelDeferred && (
                      <button
                        type="button"
                        className="deferred-message-action deferred-message-action-cancel"
                        onClick={() =>
                          onCancelDeferred(deferred.tempId as string)
                        }
                        aria-label="Cancel queued message"
                        title="Cancel queued message"
                      >
                        <XIcon />
                        <span>Cancel</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <MessageAge timestampMs={timestampMs} nowMs={nowMs} />
            </div>
          );
        })}
        {/* Compacting indicator - shown when context is being compressed */}
        {isCompacting && (
          <div className="system-message system-message-compacting">
            <span className="system-message-icon spinning">⟳</span>
            <span className="system-message-text">Compacting context...</span>
          </div>
        )}
        <ProcessingIndicator
          isProcessing={isProcessing}
          thinkingItemsVisible={thinkingItemsVisible}
          hasThinkingItems={hasThinkingItems}
          onToggleThinkingItemsVisible={toggleThinkingItemsVisible}
          thinkingLatestOnly={thinkingLatestOnly}
          onToggleThinkingLatestOnly={toggleThinkingLatestOnly}
        />
      </div>
    </>
  );
});
