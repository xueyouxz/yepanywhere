import type { MarkdownAugment, UploadedFile } from "@yep-anywhere/shared";
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
import { useRelativeNow } from "../hooks/useRelativeNow";
import { markReloadPerfPhase } from "../lib/diagnostics/reloadPerfProbe";
import { copyMarkdownSelectionToClipboard } from "../lib/markdownSelectionCopy";
import {
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
import { UI_KEYS } from "../lib/storageKeys";
import type { ContentBlock, Message } from "../types";
import type { RenderItem } from "../types/renderItems";
import { AttachmentChip } from "./AttachmentChip";
import {
  BtwAsideTranscript,
  type BtwAsideTranscriptTurn,
} from "./BtwAsidePane";
import {
  buildAssistantRenderSegments,
  ExploredToolGroup,
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

/**
 * Groups consecutive assistant items (text, thinking, tool_call) into turns.
 * User prompts break the grouping and are returned as separate groups.
 */
function groupItemsIntoTurns(
  items: RenderItem[],
): Array<{ isUserPrompt: boolean; items: RenderItem[] }> {
  const groups: Array<{ isUserPrompt: boolean; items: RenderItem[] }> = [];
  let currentAssistantGroup: RenderItem[] = [];

  for (const item of items) {
    if (item.type === "user_prompt" || item.type === "session_setup") {
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

function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
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

function buildSearchPreview(text: string, query: string): string {
  const compactText = text.replace(/\s+/g, " ").trim();
  const normalizedText = normalizeSearchText(compactText);
  const normalizedQuery = normalizeSearchText(query);
  const fallback =
    compactText.length > 240
      ? `${compactText.slice(0, 237).trimEnd()}...`
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
      const start = Math.max(0, index - 42);
      const end = Math.min(
        compactText.length,
        index + normalizedQuery.length + 64,
      );
      const prefix = start > 0 ? "..." : "";
      const suffix = end < compactText.length ? "..." : "";
      return `${prefix}${compactText.slice(start, end).trim()}${suffix}`;
    })
    .join(" ... ");
}

function isSessionSetupText(text: string): boolean {
  const trimmed = text.trimStart();
  return SESSION_SETUP_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

interface UserTurnSearchSession {
  active: boolean;
  scope: SessionIsearchScope;
  query: string;
  selectedId: string | null;
  originalScrollTop: number | null;
}

const NAV_MOTION_CUE_CLEAR_MS = 760;
const MIN_BOTTOM_FOLLOW_THRESHOLD_PX = 120;
const MAX_BOTTOM_FOLLOW_THRESHOLD_PX = 520;
const BOTTOM_FOLLOW_VIEWPORT_FRACTION = 0.45;
const FOLLOW_CATCH_UP_DELAYS_MS = [50, 120, 240, 480, 960, 1600, 2400];
const SEND_CATCH_UP_DELAYS_MS = [80, 240, 640];
const TOUCH_SCROLL_CANCEL_THRESHOLD_PX = 6;
const THINKING_AUTO_COLLAPSE_MS = 4200;
const INTERACTIVE_SCROLL_TARGET_SELECTOR =
  "button, input, textarea, select, a[href], [contenteditable='true']";

type ThinkingStatus = "streaming" | "complete";

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

function getCurrentTurnThinkingItemId(items: readonly RenderItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "thinking") {
      return item.id;
    }
    if (item?.type === "user_prompt" || item?.type === "session_setup") {
      return null;
    }
  }
  return null;
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
  clientOrder?: number;
  attachmentCount?: number;
  attachments?: UploadedFile[];
  blockedByEdit?: boolean;
  deliveryState?: "queued" | "sending" | "recovered" | "verifying";
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
  const leftOrder = left.message.clientOrder;
  const rightOrder = right.message.clientOrder;
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
  /** Callback to cancel a deferred message */
  onCancelDeferred?: (tempId: string) => void;
  /** Callback to take a deferred message back into the composer */
  onEditDeferred?: (tempId: string) => void;
  /** Callback to correct the latest actually-sent user message */
  onCorrectLatestUserMessage?: (messageId: string, content: string) => void;
  /** Callback to aggressively reload the client transcript from a user turn */
  onTrimBeforeUserMessage?: (messageId: string) => void;
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
}

function PencilIcon({ size = 14 }: { size?: number }) {
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
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
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

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function hasSelectedTextInside(element: HTMLElement): boolean {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  if (selection.toString().length === 0) {
    return false;
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (rangeIntersectsNode(selection.getRangeAt(index), element)) {
      return true;
    }
  }

  return false;
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
            title="Return the composer to the main session"
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
  onCancelDeferred,
  onEditDeferred,
  onCorrectLatestUserMessage,
  onTrimBeforeUserMessage,
  markdownAugments,
  activeToolApproval,
  hasOlderMessages = false,
  loadingOlder = false,
  onLoadOlderMessages,
  clientTailActive = false,
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
  const thinkingDeltaFollowAllowedRef = useRef(false);
  const navMotionCueTokenRef = useRef(0);
  const navMotionCueClearTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const thinkingAutoCollapseTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const activeThinkingItemIdRef = useRef<string | null>(null);
  const thinkingStatusesRef = useRef<Map<string, ThinkingStatus>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRestoreFocusRef = useRef<HTMLElement | null>(null);
  const searchOriginalScrollTopRef = useRef<number | null>(null);
  const [thinkingItemsVisible, setThinkingItemsVisible] = useState(
    loadSessionThinkingVisible,
  );
  const [thinkingExpansionOverrides, setThinkingExpansionOverrides] = useState<
    Record<string, boolean>
  >({});
  const [recentCompletedThinkingId, setRecentCompletedThinkingId] = useState<
    string | null
  >(null);
  const [navMotionCue, setNavMotionCue] = useState<UserTurnNavMotionCue | null>(
    null,
  );
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);
  const [userTurnSearch, setUserTurnSearch] = useState<UserTurnSearchSession>({
    active: false,
    scope: "user",
    query: "",
    selectedId: null,
    originalScrollTop: null,
  });
  const nowMs = useRelativeNow();

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
    const nextRenderItems = preprocessMessages(messages, {
      markdown: markdownAugments,
      activeToolApproval,
    });
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
  }, [messages, markdownAugments, activeToolApproval]);
  useEffect(() => {
    previousRenderItemsRef.current = renderItems;
  }, [renderItems]);
  const thinkingItemCount = useMemo(
    () => countThinkingItems(renderItems),
    [renderItems],
  );
  const hasThinkingItems = thinkingItemCount > 0;
  const currentTurnThinkingItemId = useMemo(
    () => (isProcessing ? getCurrentTurnThinkingItemId(renderItems) : null),
    [isProcessing, renderItems],
  );
  const autoExpandedThinkingItemId =
    currentTurnThinkingItemId ?? recentCompletedThinkingId;
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

      const isExpanded =
        thinkingExpansionOverrides[item.id] ??
        item.id === autoExpandedThinkingItemId;
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
    autoExpandedThinkingItemId,
    renderItems,
    stopFollowingForUserScroll,
    thinkingExpansionOverrides,
    thinkingItemsVisible,
  ]);
  useEffect(() => {
    const previousStatuses = thinkingStatusesRef.current;
    const previousActiveThinkingId = activeThinkingItemIdRef.current;
    const nextStatuses = new Map<string, ThinkingStatus>();
    let completedFromStreamingId: string | null = null;

    for (const item of renderItems) {
      if (item.type !== "thinking") {
        continue;
      }
      nextStatuses.set(item.id, item.status);
      if (
        item.status === "complete" &&
        previousStatuses.get(item.id) === "streaming"
      ) {
        completedFromStreamingId = item.id;
      }
    }

    thinkingStatusesRef.current = nextStatuses;
    activeThinkingItemIdRef.current = currentTurnThinkingItemId;

    const clearThinkingAutoCollapseTimer = () => {
      if (thinkingAutoCollapseTimerRef.current !== null) {
        clearTimeout(thinkingAutoCollapseTimerRef.current);
        thinkingAutoCollapseTimerRef.current = null;
      }
    };

    if (currentTurnThinkingItemId) {
      clearThinkingAutoCollapseTimer();
      setRecentCompletedThinkingId(null);
      return;
    }

    const recentlyFinishedThinkingId =
      completedFromStreamingId ??
      (previousActiveThinkingId && nextStatuses.has(previousActiveThinkingId)
        ? previousActiveThinkingId
        : null);

    if (recentlyFinishedThinkingId) {
      clearThinkingAutoCollapseTimer();
      setRecentCompletedThinkingId(recentlyFinishedThinkingId);
      thinkingAutoCollapseTimerRef.current = setTimeout(() => {
        setRecentCompletedThinkingId((current) =>
          current === recentlyFinishedThinkingId ? null : current,
        );
        thinkingAutoCollapseTimerRef.current = null;
      }, THINKING_AUTO_COLLAPSE_MS);
      return;
    }

    setRecentCompletedThinkingId((current) =>
      current && nextStatuses.has(current) ? current : null,
    );
  }, [currentTurnThinkingItemId, renderItems]);
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
        const preview = getSearchPreviewFallback(item.content);
        if (preview) {
          anchors.push({ id: item.id, preview, searchText: item.content });
        }
      }
    }
    return anchors;
  }, [includeAllTurnSearchAnchors, displayRenderItems]);
  const activeSearchAnchors =
    userTurnSearch.scope === "all"
      ? sessionTurnNavAnchors
      : userTurnSearchAnchors;
  const userTurnSearchMatches = useMemo(() => {
    if (!searchReady) {
      return [];
    }
    const query = normalizeSearchText(userTurnSearch.query);
    return activeSearchAnchors.filter((anchor) =>
      normalizeSearchText(anchor.searchText ?? anchor.preview).includes(query),
    );
  }, [activeSearchAnchors, searchReady, userTurnSearch.query]);
  const userTurnSearchMatchIds = useMemo(
    () => new Set(userTurnSearchMatches.map((anchor) => anchor.id)),
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
        ),
      );
    }
    return previewsById;
  }, [searchReady, userTurnSearch.query, userTurnSearchMatches]);
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
  const userTurnSearchPreview =
    selectedSearchAnchor && searchReady
      ? (userTurnSearchPreviewsById.get(selectedSearchAnchor.id) ?? null)
      : null;
  const userTurnNavSearchState = useMemo<UserTurnNavSearchState | null>(
    () =>
      searchReady
        ? {
            activeId: selectedSearchAnchor?.id ?? null,
            matchIds: userTurnSearchMatchIds,
            preview: userTurnSearchPreview,
            previewsById: userTurnSearchPreviewsById,
            query: userTurnSearch.query,
          }
        : null,
    [
      searchReady,
      selectedSearchAnchor?.id,
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
  useEffect(
    () => () => {
      if (thinkingAutoCollapseTimerRef.current !== null) {
        clearTimeout(thinkingAutoCollapseTimerRef.current);
        thinkingAutoCollapseTimerRef.current = null;
      }
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
      const isVisible =
        userTurnSearch.scope === "all"
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
  }, [searchReady, turnGroups, userTurnSearch.scope, userTurnSearchMatchIds]);
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
      item.type === "thinking" &&
      (thinkingExpansionOverrides[item.id] ??
        item.id === autoExpandedThinkingItemId),
    [autoExpandedThinkingItemId, thinkingExpansionOverrides],
  );

  const toggleThinkingItemExpanded = useCallback(
    (item: RenderItem) => {
      if (item.type !== "thinking") {
        return;
      }
      setThinkingExpansionOverrides((previous) => {
        const current =
          previous[item.id] ?? item.id === autoExpandedThinkingItemId;
        return { ...previous, [item.id]: !current };
      });
    },
    [autoExpandedThinkingItemId],
  );

  const noopToggleThinkingExpanded = useCallback(() => {}, []);

  const toggleThinkingItemsVisible = useCallback(() => {
    setThinkingItemsVisible((previous) => {
      const next = !previous;
      saveSessionThinkingVisible(next);
      return next;
    });
  }, []);

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

  const cycleUserTurnSearch = useCallback(() => {
    setUserTurnSearch((previous) => {
      if (!previous.active || userTurnSearchMatches.length === 0) {
        return previous;
      }
      const currentIndex = previous.selectedId
        ? userTurnSearchMatches.findIndex(
            (anchor) => anchor.id === previous.selectedId,
          )
        : -1;
      const nextIndex =
        currentIndex >= 0
          ? (currentIndex - 1 + userTurnSearchMatches.length) %
            userTurnSearchMatches.length
          : userTurnSearchMatches.length - 1;
      const nextSelectedId = userTurnSearchMatches[nextIndex]?.id ?? null;
      return { ...previous, selectedId: nextSelectedId };
    });
  }, [userTurnSearchMatches]);

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
        selectedId: null,
        originalScrollTop: null,
      };
    });
  }, []);

  const openUserTurnSearch = useCallback(
    (scope: SessionIsearchScope) => {
      const canSearch =
        scope === "all" ? displayRenderItems.length > 0 : hasUserSearchableTurn;
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

  useEffect(() => {
    if (!userTurnSearch.active) {
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
      const requestedScope = getSessionIsearchShortcutScope(event);
      if (requestedScope) {
        event.preventDefault();
        event.stopPropagation();
        if (userTurnSearch.active && userTurnSearch.scope === requestedScope) {
          cycleUserTurnSearch();
        } else {
          openUserTurnSearch(requestedScope);
        }
        return;
      }
      if (!userTurnSearch.active) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeUserTurnSearch(true);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const selectedId = userTurnSearch.selectedId;
        closeUserTurnSearch(false);
        if (selectedId) {
          requestAnimationFrame(() =>
            scrollToRenderId(selectedId, "auto", "center", true),
          );
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    closeUserTurnSearch,
    cycleUserTurnSearch,
    openUserTurnSearch,
    scrollToCurrent,
    scrollToRenderId,
    userTurnSearch.active,
    userTurnSearch.scope,
    userTurnSearch.selectedId,
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

    const container = containerRef.current?.parentElement;
    if (!container) return;

    const atBottom = isNearScrollBottom(container);
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
        if (isNearScrollBottom(scrollContainer)) {
          shouldAutoScrollRef.current = true;
          setIsScrolledToBottom(true);
        }
        // Update height tracking even when not scrolling
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
      <span className="user-turn-search-label">
        {userTurnSearch.scope === "all" ? "All turns" : "User turns"}
      </span>
      <input
        ref={searchInputRef}
        className="user-turn-search-input"
        value={userTurnSearch.query}
        onChange={(event) =>
          handleUserTurnSearchQueryChange(event.target.value)
        }
        placeholder="reverse search"
        aria-label={
          userTurnSearch.scope === "all"
            ? "Reverse search all turns"
            : "Reverse search user turns"
        }
      />
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
      <span className="user-turn-search-keys">
        {userTurnSearch.scope === "all" ? "Ctrl+S" : "Ctrl+R/Ctrl+Alt+R"} prev /
        Enter jump / Esc cancel
      </span>
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
        onTrimAnchor={onTrimBeforeUserMessage}
        searchState={userTurnNavSearchState}
      />
      {searchPanelTarget && searchPanel
        ? createPortal(searchPanel, searchPanelTarget)
        : searchPanel}
      {followButtonTarget && followButton
        ? createPortal(followButton, followButtonTarget)
        : followButton}
      <div className="message-list" ref={containerRef}>
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
          const index = tailItem.deferredIndex;
          const canEditDeferred = !!(deferred.tempId && onEditDeferred);
          return (
            <div
              key={tailItem.key}
              className={`deferred-message message-render-row ${
                timestampMs !== null ? "has-message-age" : ""
              } ${showAgeByDefault ? "is-message-age-visible" : ""}`}
            >
              <div className="message-render-content">
                {canEditDeferred ? (
                  <div
                    role="button"
                    tabIndex={0}
                    className="message-user-prompt deferred-message-bubble deferred-message-edit"
                    onClick={(event) => {
                      if (hasSelectedTextInside(event.currentTarget)) {
                        return;
                      }
                      onEditDeferred?.(deferred.tempId as string);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") {
                        return;
                      }
                      event.preventDefault();
                      onEditDeferred?.(deferred.tempId as string);
                    }}
                    title="Select text or press Enter to edit queued message"
                    aria-label="Queued message text; press Enter to edit"
                  >
                    {deferred.content}
                  </div>
                ) : (
                  <div className="message-user-prompt deferred-message-bubble">
                    {deferred.content}
                  </div>
                )}
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
                  <span className="deferred-message-status">
                    {deferred.deliveryState === "sending"
                      ? "Sending queued message..."
                      : deferred.deliveryState === "recovered"
                        ? "Recovered draft (not queued)"
                        : deferred.deliveryState === "verifying"
                          ? "Queued (verifying)"
                          : deferred.blockedByEdit
                            ? "Queued (after edit)"
                            : index === 0
                              ? "Queued (next)"
                              : `Queued (#${index + 1})`}
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
                    {canEditDeferred && (
                      <button
                        type="button"
                        className="deferred-message-action deferred-message-action-edit"
                        onClick={() =>
                          onEditDeferred?.(deferred.tempId as string)
                        }
                        aria-label="Edit queued message"
                        title="Edit queued message"
                      >
                        <PencilIcon />
                        <span>Edit</span>
                      </button>
                    )}
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
        />
      </div>
    </>
  );
});
