import type { MarkdownAugment, UploadedFile } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ActiveToolApproval,
  preprocessMessages,
} from "../lib/preprocessMessages";
import { useRelativeNow } from "../hooks/useRelativeNow";
import {
  MESSAGE_STALE_THRESHOLD_MS,
  getLatestMessageTimestampMs,
  isStaleTimestamp,
  parseTimestampMs,
} from "../lib/messageAge";
import { markReloadPerfPhase } from "../lib/diagnostics/reloadPerfProbe";
import { parseUserPrompt } from "../lib/parseUserPrompt";
import { copyMarkdownSelectionToClipboard } from "../lib/markdownSelectionCopy";
import {
  dispatchSessionIsearchGuideState,
  type SessionIsearchScope,
} from "../lib/sessionIsearchGuide";
import { stabilizeRenderItems } from "../lib/stableRenderItems";
import type { Message } from "../types";
import type { ContentBlock } from "../types";
import type { RenderItem } from "../types/renderItems";
import { ProcessingIndicator } from "./ProcessingIndicator";
import { MessageAge } from "./MessageAge";
import { AttachmentChip } from "./AttachmentChip";
import { RenderItemComponent } from "./RenderItemComponent";
import {
  UserTurnNavigator,
  type UserTurnNavAnchor,
  type UserTurnNavMotionCue,
  type UserTurnNavSearchState,
} from "./UserTurnNavigator";

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
  status?: string;
  attachments?: UploadedFile[];
}

/** Deferred message queued server-side */
interface DeferredMessage {
  tempId?: string;
  content: string;
  timestamp: string;
  attachmentCount?: number;
  attachments?: UploadedFile[];
  blockedByEdit?: boolean;
  deliveryState?: "queued" | "sending" | "recovered" | "verifying";
}

interface BtwAsideTimelineItem {
  id: string;
  request: string;
  followUps: string[];
  status:
    | "draft"
    | "starting"
    | "running"
    | "complete"
    | "failed"
    | "stopped";
  createdAt: string;
  updatedAt: string;
  historyAt?: string;
  preview?: string;
  error?: string;
  responses: string[];
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
  /** Active recent-turn tail size, when set by tailTurns */
  clientTailTurns?: number;
  /** Callback to reload with the default recent-turn tail */
  onTrimToRecentTurns?: () => void;
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

function BtwAsideTimelineCard({
  aside,
  onFocus,
  onDone,
  onStop,
  onToggleExpanded,
}: {
  aside: BtwAsideTimelineItem;
  onFocus?: (asideId: string) => void;
  onDone?: () => void;
  onStop?: (asideId: string) => void;
  onToggleExpanded?: (asideId: string) => void;
}) {
  const canExpand = Boolean(
    aside.request || aside.followUps.length > 0 || aside.responses.length > 0,
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
        {aside.error && (
          <span className="btw-aside-error">{aside.error}</span>
        )}
      </button>
      {aside.expanded && canExpand && (
        <div className="btw-aside-transcript">
          {aside.request && (
            <div className="btw-aside-turn btw-aside-turn-user">
              {aside.request}
            </div>
          )}
          {aside.responses.map((response, index) => (
            <div
              key={`response-${index}`}
              className="btw-aside-turn btw-aside-turn-assistant"
            >
              {response}
            </div>
          ))}
          {aside.followUps.map((followUp, index) => (
            <div
              key={`followup-${index}`}
              className="btw-aside-turn btw-aside-turn-user"
            >
              {followUp}
            </div>
          ))}
        </div>
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
  clientTailTurns,
  onTrimToRecentTurns,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const isInitialLoadRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const lastHeightRef = useRef(0);
  const followUpScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forcedCurrentScrollTimersRef = useRef<ReturnType<typeof setTimeout>[]>(
    [],
  );
  const programmaticScrollReleaseRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousRenderItemsRef = useRef<RenderItem[]>([]);
  const navMotionCueTokenRef = useRef(0);
  const navMotionCueClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRestoreFocusRef = useRef<HTMLElement | null>(null);
  const searchOriginalScrollTopRef = useRef<number | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [navMotionCue, setNavMotionCue] =
    useState<UserTurnNavMotionCue | null>(null);
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);
  const [userTurnSearch, setUserTurnSearch] =
    useState<UserTurnSearchSession>({
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

  // Preprocess messages into render items and group into turns
  const renderItems = useMemo(
    () => {
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
    },
    [messages, markdownAugments, activeToolApproval],
  );
  useEffect(() => {
    previousRenderItemsRef.current = renderItems;
  }, [renderItems]);
  const turnGroups = useMemo(
    () => {
      const startedAt = highResolutionNowMs();
      const grouped = groupItemsIntoTurns(renderItems);
      markReloadPerfPhase("message_list_group_end", {
        renderItems: renderItems.length,
        turnGroups: grouped.length,
        durationMs: highResolutionNowMs() - startedAt,
      });
      return grouped;
    },
    [renderItems],
  );
  useEffect(() => {
    markReloadPerfPhase("message_list_commit_effect", {
      messages: messages.length,
      renderItems: renderItems.length,
      turnGroups: turnGroups.length,
    });
  }, [messages.length, renderItems.length, turnGroups.length]);
  const userSearchableTurnCount = useMemo(() => {
    let count = 0;
    for (const item of renderItems) {
      if (item.type === "user_prompt" && !item.isSubagent) {
        count += 1;
        if (count >= 2) {
          break;
        }
      }
    }
    return count;
  }, [renderItems]);
  const getUserTurnNavAnchors = useCallback((): UserTurnNavAnchor[] => {
    const anchors: UserTurnNavAnchor[] = [];
    for (const item of renderItems) {
      if (item.type !== "user_prompt" || item.isSubagent) {
        continue;
      }
      const preview = getUserTurnPreview(item.content);
      if (!preview || isSessionSetupText(preview)) {
        continue;
      }
      anchors.push({ id: item.id, preview });
    }
    return anchors;
  }, [renderItems]);
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
    for (const item of renderItems) {
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
  }, [includeUserTurnSearchAnchors, renderItems]);
  const includeAllTurnSearchAnchors =
    searchReady && userTurnSearch.scope === "all";
  const sessionTurnNavAnchors = useMemo<UserTurnNavAnchor[]>(() => {
    if (!includeAllTurnSearchAnchors) {
      return [];
    }
    const anchors: UserTurnNavAnchor[] = [];
    for (const item of renderItems) {
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
  }, [includeAllTurnSearchAnchors, renderItems]);
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

    for (const item of renderItems) {
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
  }, [renderItems, pendingMessages, deferredMessages, btwAsides]);
  const latestCorrectablePrompt = useMemo(() => {
    if (!onCorrectLatestUserMessage) return null;

    for (let index = renderItems.length - 1; index >= 0; index -= 1) {
      const item = renderItems[index];
      if (!item || item.type !== "user_prompt" || item.isSubagent) {
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

  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  const showNavMotionCue = useCallback((direction: "up" | "down") => {
    if (navMotionCueClearTimerRef.current !== null) {
      clearTimeout(navMotionCueClearTimerRef.current);
    }
    setNavMotionCue({
      direction,
      token: (navMotionCueTokenRef.current += 1),
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
    const scrollContainer = containerRef.current?.parentElement;
    if (!scrollContainer) return;
    shouldAutoScrollRef.current = true;
    scrollToBottom(scrollContainer, "smooth");
  }, [scrollToBottom]);

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

  const openUserTurnSearch = useCallback((scope: SessionIsearchScope) => {
    const canSearch =
      scope === "all" ? renderItems.length >= 2 : userSearchableTurnCount >= 2;
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
  }, [renderItems.length, userSearchableTurnCount]);

  const handleUserTurnSearchQueryChange = useCallback(
    (query: string) => {
      setUserTurnSearch((previous) => ({
        ...previous,
        query,
        selectedId: null,
      }));
    },
    [],
  );

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
          previous.selectedId &&
          userTurnSearchMatchIds.has(previous.selectedId)
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
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key.toLocaleLowerCase() === "r" ||
          event.key.toLocaleLowerCase() === "s")
      ) {
        event.preventDefault();
        event.stopPropagation();
        const requestedScope: SessionIsearchScope =
          event.key.toLocaleLowerCase() === "s" ? "all" : "user";
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
    setIsScrolledToBottom(atBottom);
  }, []);

  // Attach scroll listener to parent container
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    container.addEventListener("scroll", handleScroll);

    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll]);

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
      if (followUpScrollRef.current !== null) {
        clearTimeout(followUpScrollRef.current);
      }
      if (programmaticScrollReleaseRef.current !== null) {
        clearTimeout(programmaticScrollReleaseRef.current);
      }
      for (const timer of forcedCurrentScrollTimersRef.current) {
        clearTimeout(timer);
      }
      forcedCurrentScrollTimersRef.current = [];
      if (navMotionCueClearTimerRef.current !== null) {
        clearTimeout(navMotionCueClearTimerRef.current);
      }
    };
  }, [scrollToBottom]);

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
            container.scrollHeight - container.scrollTop - container.clientHeight,
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
      shouldAutoScrollRef.current = true;
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
        for (const timer of forcedCurrentScrollTimersRef.current) {
          clearTimeout(timer);
        }
        forcedCurrentScrollTimersRef.current = [80, 240, 640].map((delay) =>
          setTimeout(() => {
            shouldAutoScrollRef.current = true;
            const currentContainer = containerRef.current?.parentElement;
            if (currentContainer) {
              scrollToBottom(currentContainer);
            }
          }, delay),
        );
      }
    }
  }, [scrollTrigger, scrollToBottom]);

  // Initial scroll to bottom on first render
  useEffect(() => {
    if (isInitialLoadRef.current && renderItems.length > 0) {
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
      }
      isInitialLoadRef.current = false;
    }
  }, [renderItems.length, scrollToBottom]);

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
        {userTurnSearch.scope === "all" ? "Ctrl+S" : "Ctrl+R"} prev / Enter jump
        / Esc cancel
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
      {!isScrolledToBottom && (
        <button
          type="button"
          className="scroll-to-current-button"
          onClick={scrollToCurrent}
          aria-label="Scroll to latest"
          title="Scroll to latest"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
        </button>
      )}
      {searchPanelTarget && searchPanel
        ? createPortal(searchPanel, searchPanelTarget)
        : searchPanel}
      {followButtonTarget && followButton
        ? createPortal(followButton, followButtonTarget)
        : followButton}
      <div className="message-list" ref={containerRef}>
        {(hasOlderMessages || onTrimToRecentTurns) && (
          <div className="load-older-messages">
            {onTrimToRecentTurns && (
              <button
                type="button"
                className="load-older-button"
                onClick={onTrimToRecentTurns}
                disabled={clientTailActive && clientTailTurns === 20}
                title="Reload this page with only the recent client transcript"
              >
                {clientTailActive ? "Client tail active" : "Recent 20 turns"}
              </button>
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
                thinkingExpanded={thinkingExpanded}
                toggleThinkingExpanded={toggleThinkingExpanded}
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
              {group.items.map((item) => (
                <RenderItemComponent
                  key={item.id}
                  item={item}
                  isStreaming={isStreaming}
                  thinkingExpanded={thinkingExpanded}
                  toggleThinkingExpanded={toggleThinkingExpanded}
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
                />
              ))}
            </div>
          );
        })}
        {/* Pending messages - shown as "Uploading..." or "Sending..." until server confirms */}
        {pendingMessages.map((pending) => {
          const timestampMs = parseTimestampMs(pending.timestamp);
          const showAgeByDefault =
            latestVisibleTimestampMs === timestampMs &&
            isStaleTimestamp(
              timestampMs,
              nowMs,
              MESSAGE_STALE_THRESHOLD_MS,
            );
          return (
            <div
              key={pending.tempId}
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
                <div className="pending-message-status">
                  {pending.status || "Sending..."}
                </div>
              </div>
              <MessageAge timestampMs={timestampMs} nowMs={nowMs} />
            </div>
          );
        })}
        {/* Deferred messages - queued server-side, waiting for agent turn to end */}
        {deferredMessages.map((deferred, index) => {
          const canEditDeferred = !!(deferred.tempId && onEditDeferred);
          const timestampMs = parseTimestampMs(deferred.timestamp);
          const showAgeByDefault =
            latestVisibleTimestampMs === timestampMs &&
            isStaleTimestamp(
              timestampMs,
              nowMs,
              MESSAGE_STALE_THRESHOLD_MS,
            );
          return (
            <div
              key={deferred.tempId ?? `deferred-${index}`}
              className={`deferred-message message-render-row ${
                timestampMs !== null ? "has-message-age" : ""
              } ${showAgeByDefault ? "is-message-age-visible" : ""}`}
            >
              <div className="message-render-content">
                {canEditDeferred ? (
                  <button
                    type="button"
                    className="message-user-prompt deferred-message-bubble deferred-message-edit"
                    onClick={() => onEditDeferred?.(deferred.tempId as string)}
                    title="Edit queued message"
                    aria-label="Edit queued message text"
                  >
                    {deferred.content}
                  </button>
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
                {deferred.attachmentCount && !deferred.attachments?.length ? (
                  <span
                    className="deferred-message-attachments"
                    title={`${deferred.attachmentCount} attachment${
                      deferred.attachmentCount === 1 ? "" : "s"
                    } queued`}
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
                  {(canEditDeferred ||
                    (deferred.tempId && onCancelDeferred)) && (
                    <div className="deferred-message-actions">
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
                  )}
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
        <ProcessingIndicator isProcessing={isProcessing} />
      </div>
    </>
  );
});
