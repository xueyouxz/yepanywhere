import type {
  AppContentBlock,
  PromptSuggestionMode,
  ProviderName,
  PublicSessionShareSessionStatusResponse,
  ThinkingOption,
  UploadedFile,
} from "@yep-anywhere/shared";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, type DeferredMessagePlacement } from "../api/client";
import {
  BtwAsidePane,
  BtwAsideTranscript,
  type BtwAsideTranscriptTurn,
} from "../components/BtwAsidePane";
import { ClientLogRecordingBadge } from "../components/ClientLogRecordingBadge";
import {
  MessageInput,
  type MessageSubmissionMetadata,
  type UploadProgress,
} from "../components/MessageInput";
import { MessageInputToolbar } from "../components/MessageInputToolbar";
import { MessageList } from "../components/MessageList";
import { ModelSwitchModal } from "../components/ModelSwitchModal";
import { ProcessInfoModal } from "../components/ProcessInfoModal";
import { ProviderBadge } from "../components/ProviderBadge";
import { QuestionAnswerPanel } from "../components/QuestionAnswerPanel";
import { RecentSessionsDropdown } from "../components/RecentSessionsDropdown";
import { RestartSessionModal } from "../components/RestartSessionModal";
import { SessionHeartbeatModal } from "../components/SessionHeartbeatModal";
import { SessionMenu } from "../components/SessionMenu";
import { SessionRecapModal } from "../components/SessionRecapModal";
import { SessionShareModal } from "../components/SessionShareModal";
import { ThinkingIndicator } from "../components/ThinkingIndicator";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import type { ModalAnchorRect } from "../components/ui/Modal";
import { ViewerCountIndicator } from "../components/ViewerCountIndicator";
import { AgentContentProvider } from "../contexts/AgentContentContext";
import { RenderModeProvider } from "../contexts/RenderModeContext";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import {
  StreamingMarkdownProvider,
  useStreamingMarkdownContext,
} from "../contexts/StreamingMarkdownContext";
import { useToastContext } from "../contexts/ToastContext";
import { useActivityBusState } from "../hooks/useActivityBusState";
import {
  getAttachmentUploadLongEdgePx,
  useAttachmentUploadQuality,
} from "../hooks/useAttachmentUploadQuality";
import { useConnection } from "../hooks/useConnection";
import { useDeveloperMode } from "../hooks/useDeveloperMode";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import type { DraftControls } from "../hooks/useDraftPersistence";
import { useEngagementTracking } from "../hooks/useEngagementTracking";
import { getModelSetting, getThinkingSetting } from "../hooks/useModelSettings";
import { useProject } from "../hooks/useProjects";
import { useProviders } from "../hooks/useProviders";
import { usePublicShareStatus } from "../hooks/usePublicShareStatus";
import { recordSessionVisit } from "../hooks/useRecentSessions";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import {
  type DeferredMessage,
  type StreamingMarkdownCallbacks,
  useSession,
} from "../hooks/useSession";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { storeUploadedAttachmentPreview } from "../lib/attachmentPreviewCache";
import { getBtwSplitRouting, getBtwToolbarMode } from "../lib/btwAsideRouting";
import {
  buildBtwAsideParentHref,
  getBtwAsideSessionDisplayTitle,
} from "../lib/btwAsideSessions";
import {
  getRecallSubmissionAfterQueuedCancel,
  type LastComposerSubmission,
  type SentComposerSubmission,
} from "../lib/composerRecall";
import { buildCorrectionText } from "../lib/correctionText";
import { logSessionUiTrace } from "../lib/diagnostics/uiTrace";
import { prepareImageUpload } from "../lib/imageAttachmentResize";
import {
  getEffortLevelLabel,
  normalizeEffortLevelForProvider,
} from "../lib/effortLevels";
import { getIndicatorToneFromProcess } from "../lib/modelConfigIndicator";
import { getModelIndicatorModelLabel } from "../lib/modelIndicatorText";
import { preprocessMessages } from "../lib/preprocessMessages";
import { resolveSessionProviderCapabilities } from "../lib/providerCapabilities";
import {
  getEstimatedServerOffsetMs,
  getServerClockTimestamp,
  measureServerLatencyMs,
  recordServerClockSample,
} from "../lib/serverClock";
import {
  createSessionNavigationState,
  parseSessionNavigationState,
} from "../lib/sessionNavigationState";
import { getSessionActivityUiState } from "../lib/sessionActivityUi";
import {
  CLIENT_SLASH_COMMANDS,
  resolveComposerSlashTurn,
} from "../lib/slashCommands";
import { generateUUID } from "../lib/uuid";
import type { Message } from "../types";
import { getSessionDisplayTitle } from "../utils";

const PENDING_ELSEWHERE_DISMISS_KEY_PREFIX =
  "yepanywhere:pending-elsewhere-dismissed:";
const PUBLIC_SHARE_STATUS_POLL_MS = 5000;
const PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH = 700;
const BTW_ASIDE_POLL_MS = 1500;
const BTW_ASIDE_MAX_POLLS = 160;
const BTW_ASIDE_PREVIEW_MAX_LENGTH = 700;
const BTW_ASIDE_PROMPT_MARKER = "[YA /btw aside]";
const CLAUDE_HANDOFF_REQUIRED_MESSAGE =
  "Claude session cannot be safely resumed because the Claude SDK recorded an API-error response as the latest assistant message. Start a handoff session instead.";
const BTW_ASIDE_FORK_PROVIDERS = new Set<ProviderName>([
  "claude",
  "codex",
  "codex-oss",
]);

interface QueuedEditDraft {
  originalTempId: string;
  placement?: DeferredMessagePlacement;
}

interface PreparedComposerSubmission {
  outgoingText: string;
  thinking?: ThinkingOption;
  slashCommand?: "fast" | "run";
}

type BtwAsideStatus =
  | "draft"
  | "starting"
  | "running"
  | "complete"
  | "failed"
  | "stopped";

interface BtwAside {
  id: string;
  sessionId?: string;
  baseMessageCount: number;
  request: string;
  followUps: string[];
  status: BtwAsideStatus;
  error?: string;
  preview?: string;
  responses: string[];
  turns?: BtwAsideTranscriptTurn[];
  processId?: string;
  createdAt: string;
  updatedAt: string;
  historyAt?: string;
  expanded?: boolean;
}

function providerSupportsBtwAsideFork(
  provider: ProviderName | undefined,
): boolean {
  return provider ? BTW_ASIDE_FORK_PROVIDERS.has(provider) : false;
}

function appendComposerTransferDraft(
  currentDraft: string,
  text: string,
): string {
  const current = currentDraft.trimEnd();
  const addition = text.trim();
  if (!current) {
    return addition;
  }
  if (!addition) {
    return current;
  }
  return `${current}\n\n${addition}`;
}

function getDeferredEditPlacement(
  messages: DeferredMessage[],
  tempId: string,
): DeferredMessagePlacement | undefined {
  const index = messages.findIndex((message) => message.tempId === tempId);
  if (index === -1) {
    return undefined;
  }
  const afterTempId = messages[index - 1]?.tempId;
  const beforeTempId = messages[index + 1]?.tempId;
  if (!afterTempId && !beforeTempId) {
    return undefined;
  }
  return {
    ...(afterTempId ? { afterTempId } : {}),
    ...(beforeTempId ? { beforeTempId } : {}),
  };
}

function isMissingDeferredQueueEntryError(error: unknown): boolean {
  if ((error as { status?: number } | null)?.status === 404) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No active process") ||
    message.includes("Deferred message not found")
  );
}

function requiresHandoffAfterClaudeResumeError(
  error: unknown,
  provider: ProviderName | undefined,
): boolean {
  if ((error as { status?: number } | null)?.status !== 409) {
    return false;
  }
  if (provider !== "claude" && provider !== "claude-ollama") {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Start a handoff session") ||
    message.includes("API error: 409")
  );
}

function messageContentToPlainText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const value = block as AppContentBlock;
      if (value.type === "text" && typeof value.text === "string") {
        return value.text;
      }
      if (value.type === "thinking" && typeof value.thinking === "string") {
        return value.thinking;
      }
      return typeof value.content === "string" ? value.content : "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageContentToBtwLiveText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const value = block as AppContentBlock & Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") {
        return value.text;
      }
      if (value.type === "thinking" && typeof value.thinking === "string") {
        return `Thinking: ${truncateBtwPreview(value.thinking)}`;
      }
      if (value.type === "tool_use" && typeof value.name === "string") {
        const input = value.input as Record<string, unknown> | undefined;
        const detail =
          (typeof input?.command === "string" && input.command) ||
          (typeof input?.cmd === "string" && input.cmd) ||
          (typeof input?.file_path === "string" && input.file_path) ||
          (typeof input?.query === "string" && input.query) ||
          (typeof input?.url === "string" && input.url) ||
          "";
        return detail
          ? `Using ${value.name}: ${truncateBtwPreview(detail)}`
          : `Using ${value.name}`;
      }
      return typeof value.content === "string" ? value.content : "";
    })
    .filter(Boolean)
    .join("\n");
}

function truncateBtwPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= BTW_ASIDE_PREVIEW_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, BTW_ASIDE_PREVIEW_MAX_LENGTH - 3).trimEnd()}...`;
}

function getMessagePlainText(message: Message | undefined): string {
  return (
    messageContentToPlainText(message?.content) ||
    messageContentToPlainText(message?.message?.content)
  );
}

function isAssistantRole(message: Message | undefined): message is Message {
  return (
    message?.type === "assistant" ||
    message?.role === "assistant" ||
    message?.message?.role === "assistant"
  );
}

function isUserRole(message: Message | undefined): message is Message {
  return (
    message?.type === "user" ||
    message?.role === "user" ||
    message?.message?.role === "user"
  );
}

function getLatestAssistantText(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantRole(message)) {
      continue;
    }

    const text = getMessagePlainText(message);
    if (text.trim()) {
      return truncateBtwPreview(text);
    }
  }
  return null;
}

function findLatestBtwPromptIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (
      getMessagePlainText(messages[index] ?? {}).includes(
        BTW_ASIDE_PROMPT_MARKER,
      )
    ) {
      return index;
    }
  }
  return -1;
}

function findFirstBtwPromptIndex(messages: Message[]): number {
  for (let index = 0; index < messages.length; index += 1) {
    if (
      getMessagePlainText(messages[index] ?? {}).includes(
        BTW_ASIDE_PROMPT_MARKER,
      )
    ) {
      return index;
    }
  }
  return -1;
}

function getBtwSideRequestFromPromptText(text: string): string | null {
  const requestMarker = "[Side request]";
  const requestIndex = text.indexOf(requestMarker);
  if (requestIndex < 0) {
    return null;
  }
  const request = text.slice(requestIndex + requestMarker.length).trim();
  return request || null;
}

function getBtwTranscriptTurns(
  messages: Message[],
  baseMessageCount: number,
): BtwAsideTranscriptTurn[] {
  const firstBtwPromptIndex = findFirstBtwPromptIndex(messages);
  const startIndex =
    firstBtwPromptIndex >= 0
      ? firstBtwPromptIndex
      : Math.min(Math.max(0, baseMessageCount), messages.length);

  return messages
    .slice(startIndex)
    .flatMap((message, relativeIndex): BtwAsideTranscriptTurn[] => {
      const messageId =
        typeof message.uuid === "string"
          ? message.uuid
          : typeof message.id === "string"
            ? message.id
            : `message-${startIndex + relativeIndex}`;

      if (isUserRole(message)) {
        const request = getBtwSideRequestFromPromptText(
          getMessagePlainText(message),
        );
        return request
          ? [{ id: `${messageId}-user`, role: "user", text: request }]
          : [];
      }

      if (!isAssistantRole(message)) {
        return [];
      }

      const assistantMessage = message as Message;
      const text = (
        messageContentToBtwLiveText(assistantMessage.content) ||
        messageContentToBtwLiveText(assistantMessage.message?.content)
      ).trim();
      return text
        ? [{ id: `${messageId}-assistant`, role: "assistant", text }]
        : [];
    });
}

function getBtwRequestFromMessages(messages: Message[]): string | null {
  const promptIndex = findLatestBtwPromptIndex(messages);
  if (promptIndex < 0) {
    return null;
  }
  const text = getMessagePlainText(messages[promptIndex] ?? {});
  return getBtwSideRequestFromPromptText(text);
}

function buildBtwAsideInitialPrompt(prompt: string): string {
  return [
    BTW_ASIDE_PROMPT_MARKER,
    "You are a forked side session running alongside a still-active parent session.",
    "The transcript above this turn was produced by that parent; call it 'Mother'.",
    "Earlier assistant turns are Mother's actions, not your own; when reasoning about or referring back to them, treat them as Mother's and attribute them in writing ('Mother said X', 'Mother edited Y') rather than using first person.",
    "Your view of Mother's work is frozen at fork time; Mother may have continued since.",
    "Mother is responsible for the main task; do not continue, take over, or report on it unless the side request below explicitly asks you to.",
    "You share Mother's working directory. Prefer read-only investigation; if writes are necessary, scope them tightly to avoid colliding with Mother's edits.",
    "Answer only the side request below. End with a short report block (1-5 lines) suitable for the user to paste back to Mother verbatim.",
    "",
    "[Side request]",
    prompt,
  ].join("\n");
}

function buildBtwAsideFollowupPrompt(prompt: string): string {
  return [
    BTW_ASIDE_PROMPT_MARKER,
    "(Continuing the side session. Mother remains responsible for the main task; refer to Mother's prior turns as 'Mother said ...'; share working directory with care; end with a short paste-ready report.)",
    "",
    "[Side request]",
    prompt,
  ].join("\n");
}

function normalizePublicShareInitialPrompt(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("<environment_context>")
  ) {
    return null;
  }
  const normalized = trimmed.replace(/\s+/g, " ");
  return normalized.length > PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH
    ? `${normalized.slice(0, PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH - 3).trimEnd()}...`
    : normalized;
}

function parsePositiveIntegerParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getPublicShareInitialPrompt(messages: unknown[]): string | null {
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const entry = message as {
      content?: unknown;
      message?: { content?: unknown };
      type?: unknown;
    };
    if (entry.type !== "user") {
      continue;
    }
    const content =
      messageContentToPlainText(entry.content) ||
      messageContentToPlainText(entry.message?.content);
    const preview = normalizePublicShareInitialPrompt(content);
    if (preview) {
      return preview;
    }
  }
  return null;
}

function parseCodexConfigAck(
  message: { [key: string]: unknown } | null | undefined,
): {
  model?: string;
  thinking?: { type: string };
  effort?: string;
} | null {
  if (message?.type !== "system" || message.subtype !== "config_ack") {
    return null;
  }

  const configModel =
    typeof message.configModel === "string" ? message.configModel.trim() : "";
  const configThinking =
    typeof message.configThinking === "string"
      ? message.configThinking.trim().toLowerCase()
      : "";

  const ack: {
    model?: string;
    thinking?: { type: string };
    effort?: string;
  } = {};

  if (configModel) {
    ack.model = configModel;
  }

  if (configThinking.startsWith("effort ")) {
    const acknowledgedEffort = configThinking.slice("effort ".length).trim();
    if (acknowledgedEffort === "none") {
      ack.thinking = { type: "disabled" };
      ack.effort = "none";
    } else if (acknowledgedEffort) {
      ack.thinking = { type: "enabled" };
      ack.effort = acknowledgedEffort;
    }
  }

  return ack.model || ack.thinking || ack.effort ? ack : null;
}

export function SessionPage() {
  const { projectId, sessionId } = useParams<{
    projectId: string;
    sessionId: string;
  }>();

  // Guard against missing params - this shouldn't happen with proper routing
  if (!projectId || !sessionId) {
    return <SessionPageInvalidRoute />;
  }

  // Key ensures component remounts on session change, resetting all state
  // Wrap with StreamingMarkdownProvider for server-rendered markdown streaming
  return (
    <StreamingMarkdownProvider>
      <RenderModeProvider key={sessionId}>
        <SessionPageContent
          key={sessionId}
          projectId={projectId}
          sessionId={sessionId}
        />
      </RenderModeProvider>
    </StreamingMarkdownProvider>
  );
}

function SessionPageInvalidRoute() {
  const { t } = useI18n();
  return <div className="error">{t("sessionInvalidUrl")}</div>;
}

function SessionPageContent({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const { t } = useI18n();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const basePath = useRemoteBasePath();
  const { project } = useProject(projectId);
  const navigate = useNavigate();
  const location = useLocation();
  // Get initial status and title from navigation state (passed by NewSessionPage)
  // This allows SSE to connect immediately and show optimistic title without waiting for getSession
  // Also get model/provider so ProviderBadge can render immediately
  const navState = parseSessionNavigationState(location.state);
  const initialStatus = navState?.initialStatus;
  const initialTitle = navState?.initialTitle;
  const initialModel = navState?.initialModel;
  const initialProvider = navState?.initialProvider;
  const clientTailParams = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return {
      tailTurns: parsePositiveIntegerParam(params.get("tailTurns")),
      tailFrom: params.get("tailFrom")?.trim() || undefined,
    };
  }, [location.search]);
  const clientTailActive =
    clientTailParams.tailTurns !== undefined ||
    clientTailParams.tailFrom !== undefined;

  const updateClientTailParams = useCallback(
    (update: { tailTurns?: number; tailFrom?: string }) => {
      const params = new URLSearchParams(location.search);
      params.delete("tailTurns");
      params.delete("tailFrom");
      if (update.tailTurns !== undefined) {
        params.set("tailTurns", String(update.tailTurns));
      }
      if (update.tailFrom) {
        params.set("tailFrom", update.tailFrom);
      }
      const search = params.toString();
      navigate(
        {
          pathname: location.pathname,
          search: search ? `?${search}` : "",
        },
        { replace: false },
      );
    },
    [location.pathname, location.search, navigate],
  );

  const trimClientFromUserMessage = useCallback(
    (messageId: string) => {
      updateClientTailParams({ tailFrom: messageId });
    },
    [updateClientTailParams],
  );

  // Get streaming markdown context for server-rendered markdown streaming
  const streamingMarkdownContext = useStreamingMarkdownContext();

  // Memoize the callbacks object to avoid recreating on every render
  const streamingMarkdownCallbacks = useMemo<
    StreamingMarkdownCallbacks | undefined
  >(() => {
    if (!streamingMarkdownContext) return undefined;
    return {
      onAugment: streamingMarkdownContext.dispatchAugment,
      onPending: streamingMarkdownContext.dispatchPending,
      onStreamEnd: streamingMarkdownContext.dispatchStreamEnd,
      setCurrentMessageId: streamingMarkdownContext.setCurrentMessageId,
      captureHtml: streamingMarkdownContext.captureStreamingHtml,
    };
  }, [streamingMarkdownContext]);

  const {
    session,
    messages,
    agentContent,
    setAgentContent,
    toolUseToAgent,
    markdownAugments,
    status,
    processState,
    sessionLiveness,
    isCompacting,
    setIsCompacting,
    pendingInputRequest,
    actualSessionId,
    permissionMode,
    loading,
    error,
    sessionUpdatesConnected,
    lastStreamActivityAt,
    setStatus,
    setProcessState,
    setPendingInputRequest,
    setPermissionMode,
    setHold,
    isHeld,
    pendingMessages,
    addPendingMessage,
    removePendingMessage,
    updatePendingMessage,
    deferredMessages,
    addDeferredMessage,
    syncDeferredMessages,
    removeDeferredMessage,
    slashCommands,
    setSessionModel,
    pagination,
    loadingOlder,
    loadOlderMessages,
    reconnectStream,
    promptSuggestion,
    dismissPromptSuggestion,
  } = useSession(
    projectId,
    sessionId,
    initialStatus,
    streamingMarkdownCallbacks,
    clientTailParams,
  );

  // Developer mode settings
  const { holdModeEnabled, showConnectionBars } = useDeveloperMode();
  const { settings: serverSettings } = useServerSettings();
  const publicSharesEnabled = serverSettings?.publicSharesEnabled ?? false;
  const { status: publicShareGlobalStatus } = usePublicShareStatus({
    poll: publicSharesEnabled,
  });

  // Session connection bar state for active session update streams
  const { connectionState } = useActivityBusState();
  const hasSessionUpdateStream =
    status.owner === "self" || status.owner === "external";

  // Always compute the real connection state. We only hide the bar behind
  // developer mode for connected/idle states; a disconnected state is
  // always shown so users can see when the live pipe is broken (e.g. dropped
  // SSH tunnel, relay issue, etc.).
  const rawSessionConnectionStatus = !hasSessionUpdateStream
    ? "idle"
    : sessionUpdatesConnected
      ? "connected"
      : connectionState === "reconnecting"
        ? "connecting"
        : "disconnected";

  const sessionConnectionStatus =
    showConnectionBars || rawSessionConnectionStatus === "disconnected"
      ? rawSessionConnectionStatus
      : "idle";

  // Effective provider/model for immediate display before session data loads
  const effectiveProvider = session?.provider ?? initialProvider;
  const effectiveModel = session?.model ?? initialModel;
  const supportsBtwAsides = providerSupportsBtwAsideFork(effectiveProvider);
  const [liveModelConfig, setLiveModelConfig] = useState<{
    model?: string;
    thinking?: { type: string };
    effort?: string;
    promptSuggestionMode?: PromptSuggestionMode;
  } | null>(null);

  const [scrollTrigger, setScrollTrigger] = useState(0);
  const draftControlsRef = useRef<DraftControls | null>(null);
  const pendingMotherComposerTransferRef = useRef<string | null>(null);
  const lastComposerSubmissionRef = useRef<LastComposerSubmission | null>(null);
  const lastSentComposerSubmissionRef = useRef<SentComposerSubmission | null>(
    null,
  );
  const [btwAsides, setBtwAsides] = useState<BtwAside[]>([]);
  const [focusedBtwAsideId, setFocusedBtwAsideId] = useState<string | null>(
    null,
  );
  // Wide-screen split pane (side-by-side parent + focused aside). Collapsed
  // hides the pane while keeping the aside focused for composer routing.
  const [btwSidePaneCollapsed, setBtwSidePaneCollapsed] = useState(false);
  // Draft text for the in-pane aside composer (cleared on focus change; not
  // persisted to localStorage in this initial ship).
  const [asideDraft, setAsideDraft] = useState("");
  const asideComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const btwAsidesRef = useRef<BtwAside[]>([]);
  const hydratedBtwSessionIdsRef = useRef<Set<string>>(new Set());
  const [correctionDraft, setCorrectionDraft] = useState<{
    messageId: string;
    originalText: string;
  } | null>(null);
  const [queuedEditDraft, setQueuedEditDraft] =
    useState<QueuedEditDraft | null>(null);
  const { showToast } = useToastContext();

  const releaseQueuedEditBarrier = useCallback(
    (editDraft: QueuedEditDraft | null, reason: string) => {
      if (!editDraft) {
        return;
      }
      logSessionUiTrace("queued-edit-release", {
        sessionId,
        originalTempId: editDraft.originalTempId,
        reason,
      });
      api
        .releaseDeferredEditBarrier(sessionId, editDraft.originalTempId)
        .then((result) => {
          if (result.deferredMessages) {
            syncDeferredMessages(result.deferredMessages, {
              reason: "edited",
              tempId: editDraft.originalTempId,
              source: "rest",
            });
          }
        })
        .catch((err) => {
          console.warn("Failed to release deferred edit barrier:", err);
        });
    },
    [sessionId, syncDeferredMessages],
  );

  const rememberSentSubmission = useCallback((text: string, id: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const submission: SentComposerSubmission = {
      kind: "sent",
      text: trimmed,
      id,
    };
    lastSentComposerSubmissionRef.current = submission;
    lastComposerSubmissionRef.current = submission;
  }, []);

  // Connection for uploads (uses WebSocket when enabled)
  const connection = useConnection();

  const supportsManualCompact =
    status.owner === "self" && slashCommands.includes("compact");

  // Inject custom client-side commands alongside SDK-discovered ones.
  // Keep /model last so it stays nearest the slash button in the upward menu.
  const allSlashCommands = useMemo(() => {
    if (status.owner !== "self") {
      return slashCommands;
    }

    const orderedCommands: string[] = CLIENT_SLASH_COMMANDS.filter(
      (command) =>
        command !== "model" &&
        (command !== "btw" || supportsBtwAsides) &&
        (command !== "done" || !!focusedBtwAsideId),
    );
    if (supportsManualCompact) {
      orderedCommands.push("compact");
    }

    for (const command of slashCommands) {
      if (command !== "model" && !orderedCommands.includes(command)) {
        orderedCommands.push(command);
      }
    }

    orderedCommands.push("model");

    return orderedCommands;
  }, [
    focusedBtwAsideId,
    slashCommands,
    status.owner,
    supportsBtwAsides,
    supportsManualCompact,
  ]);

  // Get provider capabilities based on session's provider
  const { providers } = useProviders();
  const providerCapabilities = useMemo(
    () =>
      resolveSessionProviderCapabilities({
        providers,
        providerName: effectiveProvider,
      }),
    [effectiveProvider, providers],
  );
  const currentProviderInfo = providerCapabilities.providerInfo;
  // Default to true for backwards compatibility (except slash commands)
  const supportsPermissionMode =
    currentProviderInfo?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    currentProviderInfo?.supportsThinkingToggle ?? true;
  const { generallySupportsSteering, supportsSteeringNow } =
    providerCapabilities;
  const currentOwnedProcessId =
    status.owner === "self" ? status.processId : undefined;
  const activityRenderItems = useMemo(
    () => preprocessMessages(messages),
    [messages],
  );
  const sessionActivityUi = useMemo(
    () =>
      getSessionActivityUiState({
        owner: status.owner,
        processState,
        items: activityRenderItems,
        hasSessionUpdateStream,
        sessionUpdatesConnected,
      }),
    [
      activityRenderItems,
      hasSessionUpdateStream,
      processState,
      sessionUpdatesConnected,
      status.owner,
    ],
  );
  const hasPendingRenderedToolCalls = sessionActivityUi.hasPendingToolCalls;
  const canStopOwnedProcess = sessionActivityUi.canStopOwnedProcess;
  const shouldDeferMessages = sessionActivityUi.shouldDeferMessages;
  const primaryComposerAction =
    shouldDeferMessages && generallySupportsSteering
      ? supportsSteeringNow
        ? "steer"
        : "queue"
      : shouldDeferMessages
        ? "queue"
        : "send";

  useEffect(() => {
    let cancelled = false;

    if (!currentOwnedProcessId) {
      setLiveModelConfig(null);
      return;
    }

    api
      .getProcessInfo(actualSessionId)
      .then((res) => {
        if (cancelled) return;
        const process = res.process;
        setLiveModelConfig(
          process
            ? {
                model: process.model,
                thinking: process.thinking,
                effort: process.effort,
                promptSuggestionMode: process.promptSuggestionMode,
              }
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setLiveModelConfig(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [actualSessionId, currentOwnedProcessId]);

  const latestCodexConfigAck = useMemo(() => {
    if (effectiveProvider !== "codex" && effectiveProvider !== "codex-oss") {
      return null;
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const acknowledged = parseCodexConfigAck(
        messages[index] as { [key: string]: unknown } | undefined,
      );
      if (acknowledged) {
        return acknowledged;
      }
    }

    return null;
  }, [effectiveProvider, messages]);

  const publicShareInitialPrompt = useMemo(
    () => getPublicShareInitialPrompt(messages),
    [messages],
  );

  useEffect(() => {
    if (!latestCodexConfigAck) return;

    setLiveModelConfig((prev) => {
      if (currentOwnedProcessId && prev) {
        return {
          model: prev.model ?? latestCodexConfigAck.model,
          thinking: prev.thinking ?? latestCodexConfigAck.thinking,
          effort: prev.effort ?? latestCodexConfigAck.effort,
        };
      }
      return {
        model: latestCodexConfigAck.model ?? prev?.model,
        thinking: latestCodexConfigAck.thinking ?? prev?.thinking,
        effort: latestCodexConfigAck.effort ?? prev?.effort,
      };
    });
  }, [currentOwnedProcessId, latestCodexConfigAck]);

  // Inline title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isSavingTitleRef = useRef(false);

  // Recent sessions dropdown state
  const [showRecentSessions, setShowRecentSessions] = useState(false);
  const titleButtonRef = useRef<HTMLButtonElement>(null);

  // Local metadata state (for optimistic updates)
  // Reset when session changes to avoid showing stale data from previous session
  const [localCustomTitle, setLocalCustomTitle] = useState<string | undefined>(
    undefined,
  );
  const [localIsArchived, setLocalIsArchived] = useState<boolean | undefined>(
    undefined,
  );
  const [localIsStarred, setLocalIsStarred] = useState<boolean | undefined>(
    undefined,
  );
  const [localHeartbeatTurnsEnabled, setLocalHeartbeatTurnsEnabled] = useState<
    boolean | undefined
  >(undefined);
  const [localHeartbeatTurnsAfterMinutes, setLocalHeartbeatTurnsAfterMinutes] =
    useState<number | undefined>(undefined);
  const [localHeartbeatTurnText, setLocalHeartbeatTurnText] = useState<
    string | undefined
  >(undefined);
  const [localHeartbeatForceAfterMinutes, setLocalHeartbeatForceAfterMinutes] =
    useState<number | undefined>(undefined);
  const [localHasUnread, setLocalHasUnread] = useState<boolean | undefined>(
    undefined,
  );

  // Reset local metadata state when sessionId changes
  useEffect(() => {
    setLocalCustomTitle(undefined);
    setLocalIsArchived(undefined);
    setLocalIsStarred(undefined);
    setLocalHeartbeatTurnsEnabled(undefined);
    setLocalHeartbeatTurnsAfterMinutes(undefined);
    setLocalHeartbeatTurnText(undefined);
    setLocalHeartbeatForceAfterMinutes(undefined);
    setLocalHasUnread(undefined);
  }, [sessionId]);

  // Record session visit for recents tracking
  useEffect(() => {
    recordSessionVisit(sessionId, projectId);
  }, [sessionId, projectId]);

  // Navigate to new session ID when temp ID is replaced with real SDK session ID
  // This ensures the URL stays in sync with the actual session
  useEffect(() => {
    if (actualSessionId && actualSessionId !== sessionId) {
      // Use replace to avoid creating a history entry for the temp ID
      navigate(
        `${basePath}/projects/${projectId}/sessions/${actualSessionId}`,
        {
          replace: true,
          state: location.state, // Preserve initial state for seamless transition
        },
      );
    }
  }, [
    actualSessionId,
    sessionId,
    projectId,
    navigate,
    location.state,
    basePath,
  ]);

  // Navigate to the session reader canonical project when the API followed
  // a provider-native redirect from a stale project-scoped link.
  useEffect(() => {
    const canonicalProjectId = session?.projectId;
    if (!canonicalProjectId || canonicalProjectId === projectId) {
      return;
    }

    navigate(
      `${basePath}/projects/${canonicalProjectId}/sessions/${actualSessionId}${location.search}`,
      {
        replace: true,
        state: location.state,
      },
    );
  }, [
    actualSessionId,
    basePath,
    location.search,
    location.state,
    navigate,
    projectId,
    session?.projectId,
  ]);

  // File attachment state
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  const [attachmentQuality] = useAttachmentUploadQuality();
  // Track in-flight upload promises so handleSend can wait for them
  const pendingUploadsRef = useRef<Map<string, Promise<UploadedFile | null>>>(
    new Map(),
  );

  useEffect(() => {
    setCorrectionDraft(null);
    setQueuedEditDraft(null);
    setBtwAsides([]);
    btwAsidesRef.current = [];
    setFocusedBtwAsideId(null);
    hydratedBtwSessionIdsRef.current.clear();
    lastComposerSubmissionRef.current = null;
    lastSentComposerSubmissionRef.current = null;
  }, [sessionId]);

  const handleCancelCorrection = useCallback(() => {
    const editDraft = queuedEditDraft;
    setCorrectionDraft(null);
    setQueuedEditDraft(null);
    draftControlsRef.current?.clearDraft();
    setAttachments([]);
    releaseQueuedEditBarrier(editDraft, "cancel-correction");
  }, [queuedEditDraft, releaseQueuedEditBarrier]);

  const handleCorrectLatestUserMessage = useCallback(
    (messageId: string, content: string) => {
      const draftControls = draftControlsRef.current;
      if (!draftControls) {
        showToast(
          t("sessionCorrectionEditFailed", {
            message: "Composer is not available",
          }),
          "error",
        );
        return;
      }

      draftControls.setDraft(content);
      setAttachments([]);
      releaseQueuedEditBarrier(queuedEditDraft, "start-sent-correction");
      setCorrectionDraft({ messageId, originalText: content });
      setQueuedEditDraft(null);
    },
    [queuedEditDraft, releaseQueuedEditBarrier, showToast, t],
  );

  const getOutgoingMessageText = useCallback(
    (text: string): string | null => {
      if (!correctionDraft) {
        return text;
      }

      const correctionText = buildCorrectionText(
        correctionDraft.originalText,
        text,
      );
      if (!correctionText) {
        draftControlsRef.current?.setDraft(text);
        showToast(t("sessionCorrectionNoChanges"), "info");
        return null;
      }
      return correctionText;
    },
    [correctionDraft, showToast, t],
  );

  const prepareComposerSubmission = (
    text: string,
  ): PreparedComposerSubmission | null => {
    const slashTurn = resolveComposerSlashTurn(text);
    if (slashTurn.kind === "custom") {
      if (slashTurn.command === "btw" && !supportsBtwAsides) {
        draftControlsRef.current?.setDraft(text);
        showToast(
          "/btw asides are available only for providers with a wired fork path.",
          "error",
        );
        return null;
      }
      if (slashTurn.command === "done" && !focusedBtwAside) {
        draftControlsRef.current?.setDraft(text);
        showToast(
          "/done closes a focused /btw aside; no aside is focused.",
          "error",
        );
        return null;
      }
      if (handleCustomCommand(slashTurn.command, slashTurn.argument)) {
        return null;
      }
      const outgoingText = getOutgoingMessageText(text);
      return outgoingText ? { outgoingText } : null;
    }

    if (slashTurn.kind === "error") {
      draftControlsRef.current?.setDraft(text);
      showToast(slashTurn.message, "error");
      return null;
    }

    const outgoingText = getOutgoingMessageText(slashTurn.text);
    if (!outgoingText) {
      return null;
    }

    return {
      outgoingText,
      thinking: slashTurn.thinking,
      slashCommand: slashTurn.command,
    };
  };

  // Approval panel collapsed state (separate from message input collapse)
  const [approvalCollapsed, setApprovalCollapsed] = useState(false);

  // Process info modal state
  const [showProcessInfoModal, setShowProcessInfoModal] = useState(false);
  const [showHeartbeatModal, setShowHeartbeatModal] = useState(false);
  const [showRecapModal, setShowRecapModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareModalAnchor, setShareModalAnchor] =
    useState<ModalAnchorRect | null>(null);
  const [publicShareStatus, setPublicShareStatus] =
    useState<PublicSessionShareSessionStatusResponse | null>(null);
  const showPublicShareControls = publicShareGlobalStatus?.canCreate ?? false;
  const [pendingElsewhereDismissed, setPendingElsewhereDismissed] =
    useState(false);

  // Model switch modal state
  const [showModelSwitchModal, setShowModelSwitchModal] = useState(false);
  const [showHandoffModal, setShowHandoffModal] = useState(false);

  // Track user engagement to mark session as "seen"
  // Only enabled when not in external session (we own or it's idle)
  //
  // We use two timestamps:
  // - activityAt: max(file mtime, SSE activity) - triggers the mark-seen action
  // - updatedAt: file mtime only - the timestamp we record
  //
  // This separation prevents a race condition where SSE timestamps (client clock)
  // could be ahead of file mtime (server disk write time), causing sessions to
  // never become unread again after viewing.
  const sessionUpdatedAt = session?.updatedAt ?? null;
  const activityAt = useMemo(() => {
    if (!sessionUpdatedAt && !lastStreamActivityAt) return null;
    if (!sessionUpdatedAt) return lastStreamActivityAt;
    if (!lastStreamActivityAt) return sessionUpdatedAt;
    // Return the more recent timestamp
    return sessionUpdatedAt > lastStreamActivityAt
      ? sessionUpdatedAt
      : lastStreamActivityAt;
  }, [sessionUpdatedAt, lastStreamActivityAt]);

  useEngagementTracking({
    sessionId,
    activityAt,
    updatedAt: sessionUpdatedAt,
    lastSeenAt: session?.lastSeenAt,
    hasUnread: session?.hasUnread,
    enabled: status.owner !== "external",
  });

  const handleSend = async (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ) => {
    const prepared = prepareComposerSubmission(text);
    if (!prepared) {
      return;
    }
    const { outgoingText, slashCommand } = prepared;
    const thinking = prepared.thinking ?? getThinkingSetting();
    const queuedEditDraftAtSubmit = queuedEditDraft;
    const actionAtMs = Date.now();
    const clientTimestamp = getServerClockTimestamp(actionAtMs);
    const clientTimestampIso = new Date(clientTimestamp).toISOString();

    // Add to pending queue and get tempId to pass to server
    const { tempId } = addPendingMessage(
      outgoingText,
      undefined,
      clientTimestampIso,
    );
    setProcessState("in-turn"); // Optimistic: show processing indicator immediately
    setScrollTrigger((prev) => prev + 1); // Force scroll to bottom
    logSessionUiTrace("composer-send-start", {
      sessionId,
      projectId,
      tempId,
      owner: status.owner,
      processId: status.owner === "self" ? status.processId : null,
      permissionMode,
      thinking,
      slashCommand: slashCommand ?? null,
      textLength: outgoingText.length,
      attachmentCount: attachments.length,
      hasCorrectionDraft: !!correctionDraft,
      hasQueuedEditDraft: !!queuedEditDraft,
      clientTimestamp,
      serverOffsetMs: getEstimatedServerOffsetMs(),
    });

    // Capture already-completed attachments
    const currentAttachments = [...attachments];

    // Wait for any in-flight uploads to complete before sending
    const pendingAtSendTime = [...pendingUploadsRef.current.values()];
    if (pendingAtSendTime.length > 0) {
      updatePendingMessage(tempId, { status: t("sessionUploading") });
      setAttachments([]); // Clear input area immediately
      const results = await Promise.all(pendingAtSendTime);
      for (const result of results) {
        if (result) currentAttachments.push(result);
      }
      // Remove uploaded files that handleAttach added to state during the wait
      // (they're already captured in currentAttachments). Preserve any new uploads
      // started after send was clicked.
      const sentIds = new Set(currentAttachments.map((a) => a.id));
      setAttachments((prev) => prev.filter((a) => !sentIds.has(a.id)));
      updatePendingMessage(tempId, { status: undefined });
    } else {
      setAttachments([]);
    }

    if (currentAttachments.length > 0) {
      updatePendingMessage(tempId, { attachments: currentAttachments });
    }

    try {
      const requestSentAtMs = Date.now();
      if (status.owner === "none") {
        // Resume the session with current permission mode and model settings
        // Use session's existing model if available (important for non-Claude providers),
        // otherwise fall back to user's model preference for new Claude sessions
        const model = session?.model ?? getModelSetting();
        // Use effectiveProvider to ensure correct provider even if session data hasn't loaded
        // effectiveProvider = session?.provider ?? initialProvider (from navigation state)
        const result = await api.resumeSession(
          projectId,
          sessionId,
          outgoingText,
          {
            mode: permissionMode,
            model,
            thinking,
            provider: effectiveProvider,
            executor: session?.executor,
          },
          currentAttachments.length > 0 ? currentAttachments : undefined,
          tempId,
          clientTimestamp,
          metadata,
        );
        const responseReceivedAtMs = Date.now();
        const timing = recordServerClockSample({
          clientRequestStartMs: requestSentAtMs,
          clientResponseEndMs: responseReceivedAtMs,
          serverTimestamp: result.serverTimestamp,
        });
        // Update status to trigger SSE connection
        logSessionUiTrace("composer-send-resume-success", {
          sessionId,
          tempId,
          processId: result.processId,
          clientTimestamp,
          serverTimestamp: result.serverTimestamp,
          uploadWaitMs: requestSentAtMs - actionAtMs,
          requestRttMs: timing?.roundTripMs ?? null,
          estimatedServerOffsetMs: timing?.serverOffsetMs ?? null,
          clientToServerLatencyMs: measureServerLatencyMs(
            clientTimestamp,
            result.serverTimestamp,
          ),
        });
        setStatus({ owner: "self", processId: result.processId });
      } else {
        // Queue to existing process with current permission mode and thinking setting
        const result = await api.queueMessage(
          sessionId,
          outgoingText,
          permissionMode,
          currentAttachments.length > 0 ? currentAttachments : undefined,
          tempId,
          thinking,
          undefined,
          undefined,
          clientTimestamp,
          metadata,
        );
        const responseReceivedAtMs = Date.now();
        const timing = recordServerClockSample({
          clientRequestStartMs: requestSentAtMs,
          clientResponseEndMs: responseReceivedAtMs,
          serverTimestamp: result.serverTimestamp,
        });
        logSessionUiTrace("composer-send-queue-success", {
          sessionId,
          tempId,
          restarted: !!result.restarted,
          processId: result.processId ?? null,
          clientTimestamp,
          serverTimestamp: result.serverTimestamp,
          uploadWaitMs: requestSentAtMs - actionAtMs,
          requestRttMs: timing?.roundTripMs ?? null,
          estimatedServerOffsetMs: timing?.serverOffsetMs ?? null,
          clientToServerLatencyMs: measureServerLatencyMs(
            clientTimestamp,
            result.serverTimestamp,
          ),
        });
        if (result.compactQueued) {
          setIsCompacting(true);
        }
        // If process was restarted due to thinking mode change, reconnect stream
        if (result.restarted && result.processId) {
          setStatus({ owner: "self", processId: result.processId });
          reconnectStream();
        }
      }
      // Success - clear the draft from localStorage
      rememberSentSubmission(text, tempId);
      draftControlsRef.current?.clearDraft();
      setCorrectionDraft(null);
      setQueuedEditDraft(null);
      releaseQueuedEditBarrier(queuedEditDraftAtSubmit, "send-edited-queue");
    } catch (err) {
      console.error("Failed to send:", err);
      let finalError: unknown = err;
      logSessionUiTrace("composer-send-error", {
        sessionId,
        tempId,
        message: err instanceof Error ? err.message : String(err),
      });

      // Check if process is dead (404) - auto-retry with resumeSession
      const is404 =
        err instanceof Error &&
        (err.message.includes("404") ||
          err.message.includes("No active process"));
      if (is404) {
        try {
          const model = session?.model ?? getModelSetting();
          const retryRequestSentAtMs = Date.now();
          const result = await api.resumeSession(
            projectId,
            sessionId,
            outgoingText,
            {
              mode: permissionMode,
              model,
              thinking,
              provider: effectiveProvider,
              executor: session?.executor,
            },
            currentAttachments.length > 0 ? currentAttachments : undefined,
            tempId,
            clientTimestamp,
            metadata,
          );
          const retryResponseReceivedAtMs = Date.now();
          const retryTiming = recordServerClockSample({
            clientRequestStartMs: retryRequestSentAtMs,
            clientResponseEndMs: retryResponseReceivedAtMs,
            serverTimestamp: result.serverTimestamp,
          });
          logSessionUiTrace("composer-send-retry-resume-success", {
            sessionId,
            tempId,
            processId: result.processId,
            clientTimestamp,
            serverTimestamp: result.serverTimestamp,
            uploadWaitMs: retryRequestSentAtMs - actionAtMs,
            requestRttMs: retryTiming?.roundTripMs ?? null,
            estimatedServerOffsetMs: retryTiming?.serverOffsetMs ?? null,
            clientToServerLatencyMs: measureServerLatencyMs(
              clientTimestamp,
              result.serverTimestamp,
            ),
          });
          setStatus({ owner: "self", processId: result.processId });
          rememberSentSubmission(text, tempId);
          draftControlsRef.current?.clearDraft();
          setCorrectionDraft(null);
          setQueuedEditDraft(null);
          releaseQueuedEditBarrier(
            queuedEditDraftAtSubmit,
            "retry-send-edited-queue",
          );
          return;
        } catch (retryErr) {
          console.error("Failed to resume session:", retryErr);
          finalError = retryErr;
          logSessionUiTrace("composer-send-retry-resume-error", {
            sessionId,
            tempId,
            message:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
          // Fall through to error handling below
        }
      }

      // Remove from pending queue and restore draft on error
      removePendingMessage(tempId);
      draftControlsRef.current?.restoreFromStorage();
      setAttachments(currentAttachments); // Restore attachments on error
      setProcessState("idle");
      const errorMsg =
        finalError instanceof Error ? finalError.message : String(finalError);
      if (requiresHandoffAfterClaudeResumeError(finalError, effectiveProvider)) {
        setShowHandoffModal(true);
        showToast(
          errorMsg.includes("API error: 409")
            ? CLAUDE_HANDOFF_REQUIRED_MESSAGE
            : errorMsg,
          "error",
        );
      } else {
        showToast(t("sessionSendFailed", { message: errorMsg }), "error");
      }
    }
  };

  const handleQueue = async (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ) => {
    const prepared = prepareComposerSubmission(text);
    if (!prepared) {
      return;
    }
    const { outgoingText, slashCommand } = prepared;
    const thinking = prepared.thinking ?? getThinkingSetting();
    const actionAtMs = Date.now();
    const clientTimestamp = getServerClockTimestamp(actionAtMs);
    const clientTimestampIso = new Date(clientTimestamp).toISOString();

    const { tempId, clientOrder } = addPendingMessage(
      outgoingText,
      undefined,
      clientTimestampIso,
    );
    setScrollTrigger((prev) => prev + 1);
    logSessionUiTrace("composer-deferred-start", {
      sessionId,
      tempId,
      owner: status.owner,
      processId: status.owner === "self" ? status.processId : null,
      permissionMode,
      thinking,
      slashCommand: slashCommand ?? null,
      textLength: outgoingText.length,
      attachmentCount: attachments.length,
      queuedEditOriginalTempId: queuedEditDraft?.originalTempId ?? null,
      clientTimestamp,
      serverOffsetMs: getEstimatedServerOffsetMs(),
    });

    // Capture already-completed attachments
    const currentAttachments = [...attachments];

    // Wait for any in-flight uploads to complete before queuing
    const pendingAtSendTime = [...pendingUploadsRef.current.values()];
    if (pendingAtSendTime.length > 0) {
      updatePendingMessage(tempId, { status: t("sessionUploading") });
      setAttachments([]);
      const results = await Promise.all(pendingAtSendTime);
      for (const result of results) {
        if (result) currentAttachments.push(result);
      }
      const sentIds = new Set(currentAttachments.map((a) => a.id));
      setAttachments((prev) => prev.filter((a) => !sentIds.has(a.id)));
      updatePendingMessage(tempId, { status: undefined });
    } else {
      setAttachments([]);
    }

    if (currentAttachments.length > 0) {
      updatePendingMessage(tempId, { attachments: currentAttachments });
    }

    try {
      const requestSentAtMs = Date.now();
      const queuedEditDraftAtSubmit = queuedEditDraft;
      const queuedEditPlacement = queuedEditDraftAtSubmit
        ? {
            ...queuedEditDraftAtSubmit.placement,
            replaceTempId: queuedEditDraftAtSubmit.originalTempId,
          }
        : undefined;
      const result = await api.queueMessage(
        sessionId,
        outgoingText,
        permissionMode,
        currentAttachments.length > 0 ? currentAttachments : undefined,
        tempId,
        thinking,
        true, // deferred
        queuedEditPlacement,
        clientTimestamp,
        metadata,
      );
      const responseReceivedAtMs = Date.now();
      const timing = recordServerClockSample({
        clientRequestStartMs: requestSentAtMs,
        clientResponseEndMs: responseReceivedAtMs,
        serverTimestamp: result.serverTimestamp,
      });
      logSessionUiTrace("composer-deferred-result", {
        sessionId,
        tempId,
        deferred: result.deferred ?? null,
        promoted: result.promoted ?? null,
        position: result.position ?? null,
        deferredCount: result.deferredMessages?.length ?? null,
        clientTimestamp,
        serverTimestamp: result.serverTimestamp,
        uploadWaitMs: requestSentAtMs - actionAtMs,
        requestRttMs: timing?.roundTripMs ?? null,
        estimatedServerOffsetMs: timing?.serverOffsetMs ?? null,
        clientToServerLatencyMs: measureServerLatencyMs(
          clientTimestamp,
          result.serverTimestamp,
        ),
      });
      removePendingMessage(tempId);
      const localDeferredMessage = {
        tempId,
        content: outgoingText,
        timestamp: clientTimestampIso,
        clientOrder,
        ...(currentAttachments.length > 0
          ? {
              attachmentCount: currentAttachments.length,
              attachments: currentAttachments,
            }
          : {}),
        mode: permissionMode,
        metadata,
        deliveryState: "queued" as const,
      };
      if (result.deferred === false || result.promoted) {
        addDeferredMessage({
          ...localDeferredMessage,
          deliveryState: "sending" as const,
        });
        if (result.deferredMessages) {
          syncDeferredMessages(result.deferredMessages, {
            reason: "promoted",
            tempId,
            source: "rest",
          });
        }
        rememberSentSubmission(text, tempId);
        draftControlsRef.current?.clearDraft();
        setCorrectionDraft(null);
        setQueuedEditDraft(null);
        return;
      }
      const serverDeferredMessages = result.deferredMessages?.map((message) =>
        message.tempId === tempId
          ? {
              ...message,
              attachments: currentAttachments,
              mode: permissionMode,
              deliveryState: "queued" as const,
            }
          : message,
      );
      if (
        serverDeferredMessages?.some((message) => message.tempId === tempId)
      ) {
        syncDeferredMessages(serverDeferredMessages, {
          reason: "queued",
          tempId,
          source: "rest",
        });
      } else {
        addDeferredMessage(localDeferredMessage);
        if (serverDeferredMessages) {
          syncDeferredMessages(serverDeferredMessages, {
            reason: "queued",
            tempId,
            source: "rest",
          });
        }
      }
      if (text.trim()) {
        lastComposerSubmissionRef.current = {
          kind: "queued",
          text: text.trim(),
          tempId,
        };
      }
      draftControlsRef.current?.clearDraft();
      setCorrectionDraft(null);
      setQueuedEditDraft(null);
    } catch (err) {
      console.error("Failed to queue deferred message:", err);
      let finalError: unknown = err;
      logSessionUiTrace("composer-deferred-error", {
        sessionId,
        tempId,
        message: err instanceof Error ? err.message : String(err),
      });

      const isProcessUnavailable =
        err instanceof Error &&
        ((err as Error & { status?: number }).status === 404 ||
          (err as Error & { status?: number }).status === 410 ||
          err.message.includes("No active process") ||
          err.message.includes("Process terminated"));
      if (isProcessUnavailable) {
        try {
          const model = session?.model ?? getModelSetting();
          const result = await api.resumeSession(
            projectId,
            sessionId,
            outgoingText,
            {
              mode: permissionMode,
              model,
              thinking,
              provider: effectiveProvider,
              executor: session?.executor,
            },
            currentAttachments.length > 0 ? currentAttachments : undefined,
            tempId,
            clientTimestamp,
            metadata,
          );
          logSessionUiTrace("composer-deferred-retry-resume-success", {
            sessionId,
            tempId,
            processId: result.processId,
          });
          setStatus({ owner: "self", processId: result.processId });
          removePendingMessage(tempId);
          rememberSentSubmission(text, tempId);
          draftControlsRef.current?.clearDraft();
          setCorrectionDraft(null);
          setQueuedEditDraft(null);
          return;
        } catch (retryErr) {
          console.error("Failed to resume session:", retryErr);
          finalError = retryErr;
          logSessionUiTrace("composer-deferred-retry-resume-error", {
            sessionId,
            tempId,
            message:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
        }
      }

      removePendingMessage(tempId);
      draftControlsRef.current?.restoreFromStorage();
      setAttachments(currentAttachments);
      const errorMsg =
        finalError instanceof Error ? finalError.message : String(finalError);
      if (requiresHandoffAfterClaudeResumeError(finalError, effectiveProvider)) {
        setShowHandoffModal(true);
        showToast(
          errorMsg.includes("API error: 409")
            ? CLAUDE_HANDOFF_REQUIRED_MESSAGE
            : errorMsg,
          "error",
        );
      } else {
        showToast(t("sessionQueueFailed", { message: errorMsg }), "error");
      }
    }
  };

  const handleCancelDeferred = useCallback(
    async (tempId: string) => {
      const localMessage = deferredMessages.find(
        (message) => message.tempId === tempId,
      );
      const previousLastSubmission = lastComposerSubmissionRef.current;
      lastComposerSubmissionRef.current = getRecallSubmissionAfterQueuedCancel(
        lastComposerSubmissionRef.current,
        lastSentComposerSubmissionRef.current,
        deferredMessages,
        tempId,
      );
      removeDeferredMessage(tempId);
      if (localMessage?.deliveryState === "recovered") {
        return;
      }

      try {
        await api.cancelDeferredMessage(sessionId, tempId);
      } catch (err) {
        if (isMissingDeferredQueueEntryError(err)) {
          return;
        }
        if (localMessage) {
          addDeferredMessage(localMessage);
        }
        lastComposerSubmissionRef.current = previousLastSubmission;
        console.error("Failed to cancel deferred message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionDeferredCancelFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [
      addDeferredMessage,
      deferredMessages,
      removeDeferredMessage,
      sessionId,
      showToast,
      t,
    ],
  );

  const handleCancelLatestDeferred = useCallback(() => {
    const latest = [...deferredMessages]
      .reverse()
      .find((message) => message.tempId && message.deliveryState !== "sending");
    if (!latest?.tempId) {
      return false;
    }
    void handleCancelDeferred(latest.tempId);
    return true;
  }, [deferredMessages, handleCancelDeferred]);

  const handleEditDeferred = useCallback(
    async (tempId: string) => {
      const draftControls = draftControlsRef.current;
      if (!draftControls) {
        showToast(
          t("sessionDeferredEditFailed", {
            message: "Composer is not available",
          }),
          "error",
        );
        return;
      }

      const localMessage = deferredMessages.find(
        (message) => message.tempId === tempId,
      );
      const localPlacement = getDeferredEditPlacement(deferredMessages, tempId);
      if (localMessage?.deliveryState === "recovered") {
        const restoredAttachments = localMessage.attachments ?? [];
        draftControls.setDraft(localMessage.content);
        setAttachments(restoredAttachments);
        if (localMessage.mode) {
          setPermissionMode(localMessage.mode);
        }
        removeDeferredMessage(tempId);
        setQueuedEditDraft({
          originalTempId: tempId,
          placement: localPlacement,
        });
        if (
          (localMessage.attachmentCount ?? 0) > 0 &&
          restoredAttachments.length === 0
        ) {
          showToast(t("sessionDeferredEditMissingAttachments"), "error");
        }
        return;
      }

      try {
        const result = await api.editDeferredMessage(sessionId, tempId);
        const restoredAttachments =
          result.attachments ?? localMessage?.attachments ?? [];
        draftControls.setDraft(result.message);
        setAttachments(restoredAttachments);
        setQueuedEditDraft({
          originalTempId: result.tempId ?? tempId,
          placement: result.placement ?? localPlacement,
        });
        const restoredMode = result.mode ?? localMessage?.mode;
        if (restoredMode) {
          setPermissionMode(restoredMode);
        }
        removeDeferredMessage(tempId);
        if (
          (localMessage?.attachmentCount ?? 0) > 0 &&
          restoredAttachments.length === 0
        ) {
          showToast(t("sessionDeferredEditMissingAttachments"), "error");
        }
      } catch (err) {
        if (localMessage && isMissingDeferredQueueEntryError(err)) {
          const restoredAttachments = localMessage.attachments ?? [];
          draftControls.setDraft(localMessage.content);
          setAttachments(restoredAttachments);
          setQueuedEditDraft({
            originalTempId: tempId,
            placement: localPlacement,
          });
          if (localMessage.mode) {
            setPermissionMode(localMessage.mode);
          }
          removeDeferredMessage(tempId);
          showToast(t("sessionDeferredEditLocalOnly"), "info");
          if (
            (localMessage.attachmentCount ?? 0) > 0 &&
            restoredAttachments.length === 0
          ) {
            showToast(t("sessionDeferredEditMissingAttachments"), "error");
          }
          return;
        }

        console.error("Failed to edit deferred message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionDeferredEditFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [
      deferredMessages,
      removeDeferredMessage,
      sessionId,
      setPermissionMode,
      showToast,
      t,
    ],
  );

  const handleRecallLastSubmission = useCallback((): boolean => {
    const lastSubmission = lastComposerSubmissionRef.current;
    if (!lastSubmission?.text.trim()) {
      return false;
    }

    if (
      lastSubmission.kind === "queued" &&
      deferredMessages.some(
        (message) => message.tempId === lastSubmission.tempId,
      )
    ) {
      void handleEditDeferred(lastSubmission.tempId);
      return true;
    }

    const draftControls = draftControlsRef.current;
    if (!draftControls) {
      return false;
    }

    draftControls.setDraft(lastSubmission.text);
    setAttachments([]);
    setCorrectionDraft({
      messageId:
        lastSubmission.kind === "sent"
          ? lastSubmission.id
          : lastSubmission.tempId,
      originalText: lastSubmission.text,
    });
    return true;
  }, [deferredMessages, handleEditDeferred]);

  const handleModelChanged = useCallback(
    (next: {
      processId: string;
      model?: string;
      thinking?: { type: string };
      effort?: string;
    }) => {
      if (next.model) {
        setSessionModel(next.model);
        showToast(t("sessionSwitchedModel", { model: next.model }), "success");
      }
      if (next.thinking !== undefined || next.effort !== undefined) {
        setLiveModelConfig((prev) => ({
          model: next.model ?? prev?.model,
          thinking: next.thinking,
          effort: next.effort,
          promptSuggestionMode: prev?.promptSuggestionMode,
        }));
      } else if (next.model) {
        setLiveModelConfig((prev) =>
          prev ? { ...prev, model: next.model } : { model: next.model },
        );
      }
      if (status.owner === "self") {
        if (status.processId !== next.processId) {
          setStatus({ owner: "self", processId: next.processId });
          reconnectStream();
        }
      }
    },
    [reconnectStream, setSessionModel, showToast, status.owner, t],
  );

  const handleCompactSession = useCallback(async () => {
    if (status.owner !== "self" || !supportsManualCompact) return;
    try {
      await api.queueMessage(actualSessionId, "/compact", permissionMode);
      showToast(t("sessionCompactRequested"), "success");
    } catch (err) {
      console.error("Failed to request compaction:", err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(t("sessionCompactFailed", { message: errorMsg }), "error");
    }
  }, [
    actualSessionId,
    permissionMode,
    showToast,
    status.owner,
    supportsManualCompact,
    t,
  ]);

  const focusedBtwAside = focusedBtwAsideId
    ? (btwAsides.find((aside) => aside.id === focusedBtwAsideId) ?? null)
    : null;
  const requestedBtwSessionId = useMemo(() => {
    const value = new URLSearchParams(location.search).get("btw")?.trim();
    return value || null;
  }, [location.search]);
  const childSessionParentHref = session?.parentSessionId
    ? buildBtwAsideParentHref(
        basePath,
        projectId,
        session.parentSessionId,
        sessionId,
      )
    : null;

  useEffect(() => {
    btwAsidesRef.current = btwAsides;
  }, [btwAsides]);

  const updateBtwAside = useCallback(
    (id: string, updater: (aside: BtwAside) => BtwAside) => {
      setBtwAsides((current) =>
        current.map((aside) => (aside.id === id ? updater(aside) : aside)),
      );
    },
    [],
  );

  const materializeBtwAside = useCallback((asideId: string) => {
    const historyAt = new Date().toISOString();
    setBtwAsides((current) =>
      current.map((aside) =>
        aside.id === asideId && !aside.historyAt
          ? { ...aside, historyAt, updatedAt: historyAt }
          : aside,
      ),
    );
  }, []);

  const pollBtwAside = useCallback(
    (asideId: string, asideSessionId: string) => {
      let polls = 0;

      const poll = async () => {
        polls += 1;
        try {
          const result = await api.getSession(projectId, asideSessionId);
          const nextStatus: BtwAsideStatus =
            result.ownership.owner === "none" ? "complete" : "running";
          updateBtwAside(asideId, (aside) => {
            const turns = getBtwTranscriptTurns(
              result.messages,
              aside.baseMessageCount,
            );
            const responses = turns
              .filter((turn) => turn.role === "assistant")
              .map((turn) => turn.text);
            const preview =
              responses.length > 0
                ? truncateBtwPreview(responses[responses.length - 1] ?? "")
                : getLatestAssistantText(result.messages);
            return {
              ...aside,
              status: nextStatus,
              preview: preview ?? aside.preview,
              responses: responses.length > 0 ? responses : aside.responses,
              turns: turns.length > 0 ? turns : aside.turns,
              historyAt:
                nextStatus === "complete"
                  ? (aside.historyAt ?? new Date().toISOString())
                  : aside.historyAt,
              updatedAt: new Date().toISOString(),
            };
          });
          if (nextStatus === "complete" || polls >= BTW_ASIDE_MAX_POLLS) {
            return;
          }
        } catch (err) {
          if (polls >= BTW_ASIDE_MAX_POLLS) {
            updateBtwAside(asideId, (aside) => ({
              ...aside,
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
              historyAt: aside.historyAt ?? new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }));
            return;
          }
        }
        window.setTimeout(poll, BTW_ASIDE_POLL_MS);
      };

      window.setTimeout(poll, BTW_ASIDE_POLL_MS);
    },
    [projectId, updateBtwAside],
  );

  const runBtwAsideTurn = useCallback(
    async (sourceAside: BtwAside, prompt: string, isInitialTurn: boolean) => {
      const trimmed = prompt.trim();
      if (!trimmed) {
        return;
      }

      updateBtwAside(sourceAside.id, (aside) => ({
        ...aside,
        request: isInitialTurn && !aside.request ? trimmed : aside.request,
        followUps: isInitialTurn
          ? aside.followUps
          : [...aside.followUps, trimmed],
        turns: isInitialTurn
          ? aside.turns?.length
            ? aside.turns
            : [
                {
                  id: `${sourceAside.id}-request`,
                  role: "user",
                  text: trimmed,
                },
              ]
          : [
              ...(aside.turns ?? []),
              {
                id: `${sourceAside.id}-followup-${aside.followUps.length}`,
                role: "user",
                text: trimmed,
              },
            ],
        status: aside.sessionId ? "running" : "starting",
        error: undefined,
        updatedAt: new Date().toISOString(),
      }));

      try {
        const providerName = effectiveProvider;
        if (!providerSupportsBtwAsideFork(providerName)) {
          throw new Error(
            "/btw asides are available only for providers with a wired fork path",
          );
        }
        let asideSessionId = sourceAside.sessionId;
        if (!asideSessionId) {
          const titlePreview = truncateBtwPreview(trimmed).slice(0, 80);
          const clone = await api.cloneSession(
            projectId,
            actualSessionId,
            `/btw ${titlePreview}`,
            providerName,
            actualSessionId,
          );
          asideSessionId = clone.sessionId;
          updateBtwAside(sourceAside.id, (aside) => ({
            ...aside,
            sessionId: asideSessionId,
            baseMessageCount: clone.messageCount,
            status: "starting",
            updatedAt: new Date().toISOString(),
          }));
        }

        const clientTimestamp = getServerClockTimestamp(Date.now());
        const result = await api.resumeSession(
          projectId,
          asideSessionId,
          isInitialTurn
            ? buildBtwAsideInitialPrompt(trimmed)
            : buildBtwAsideFollowupPrompt(trimmed),
          {
            mode: permissionMode,
            model:
              liveModelConfig?.model ?? session?.model ?? getModelSetting(),
            thinking: getThinkingSetting(),
            provider: providerName,
            executor: session?.executor,
          },
          undefined,
          generateUUID(),
          clientTimestamp,
        );

        updateBtwAside(sourceAside.id, (aside) => ({
          ...aside,
          sessionId: asideSessionId,
          status: "running",
          processId: result.processId,
          updatedAt: new Date().toISOString(),
        }));
        pollBtwAside(sourceAside.id, asideSessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        updateBtwAside(sourceAside.id, (aside) => ({
          ...aside,
          status: "failed",
          error: message,
          historyAt: aside.historyAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
        showToast(`Failed to start /btw aside: ${message}`, "error");
      }
    },
    [
      actualSessionId,
      effectiveProvider,
      liveModelConfig?.model,
      permissionMode,
      pollBtwAside,
      projectId,
      session?.executor,
      session?.model,
      showToast,
      updateBtwAside,
    ],
  );

  const startBtwAside = useCallback(
    (text: string): boolean => {
      if (!supportsBtwAsides) {
        showToast(
          "/btw asides are available only for providers with a wired fork path.",
          "error",
        );
        return false;
      }

      const trimmed = text.trim();
      const now = new Date().toISOString();
      const asideId = generateUUID();
      const aside: BtwAside = {
        id: asideId,
        baseMessageCount: 0,
        request: trimmed,
        followUps: [],
        status: trimmed ? "starting" : "draft",
        responses: [],
        turns: trimmed
          ? [
              {
                id: `${asideId}-request`,
                role: "user",
                text: trimmed,
              },
            ]
          : [],
        createdAt: now,
        updatedAt: now,
        expanded: false,
      };

      setBtwAsides((current) => [...current, aside]);
      if (!trimmed) {
        setFocusedBtwAsideId(aside.id);
        return true;
      }

      void runBtwAsideTurn(aside, trimmed, true);
      return true;
    },
    [runBtwAsideTurn, showToast, supportsBtwAsides],
  );

  useEffect(() => {
    if (!requestedBtwSessionId || requestedBtwSessionId === sessionId) {
      return;
    }

    const existingAside = btwAsidesRef.current.find(
      (aside) => aside.sessionId === requestedBtwSessionId,
    );
    if (existingAside) {
      setFocusedBtwAsideId(existingAside.id);
      return;
    }

    if (hydratedBtwSessionIdsRef.current.has(requestedBtwSessionId)) {
      return;
    }
    hydratedBtwSessionIdsRef.current.add(requestedBtwSessionId);

    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getSession(projectId, requestedBtwSessionId);
        if (cancelled) {
          return;
        }

        const request =
          getBtwRequestFromMessages(result.messages) ??
          getBtwAsideSessionDisplayTitle(
            result.session.customTitle ?? result.session.title ?? "Aside",
          );
        const turns = getBtwTranscriptTurns(result.messages, 0);
        const responses = turns
          .filter((turn) => turn.role === "assistant")
          .map((turn) => turn.text);
        const preview =
          responses.length > 0
            ? truncateBtwPreview(responses[responses.length - 1] ?? "")
            : (getLatestAssistantText(result.messages) ?? undefined);
        const now = new Date().toISOString();
        const asideId = generateUUID();
        const hydratedAside: BtwAside = {
          id: asideId,
          sessionId: requestedBtwSessionId,
          baseMessageCount: 0,
          request,
          followUps: [],
          status: result.ownership.owner === "none" ? "complete" : "running",
          preview,
          responses,
          turns,
          processId:
            result.ownership.owner === "self"
              ? result.ownership.processId
              : undefined,
          createdAt: result.session.createdAt ?? now,
          updatedAt: result.session.updatedAt ?? now,
          expanded: true,
        };

        setBtwAsides((current) =>
          current.some((aside) => aside.sessionId === requestedBtwSessionId)
            ? current
            : [...current, hydratedAside],
        );
        setFocusedBtwAsideId(asideId);
      } catch (err) {
        hydratedBtwSessionIdsRef.current.delete(requestedBtwSessionId);
        const message = err instanceof Error ? err.message : String(err);
        showToast(`Failed to load /btw aside: ${message}`, "error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, requestedBtwSessionId, sessionId, showToast]);

  const handleFocusedBtwSend = useCallback(
    (text: string) => {
      if (!focusedBtwAside) {
        void handleSend(text);
        return;
      }
      void runBtwAsideTurn(
        focusedBtwAside,
        text,
        focusedBtwAside.status === "draft" && !focusedBtwAside.sessionId,
      );
    },
    [focusedBtwAside, handleSend, runBtwAsideTurn],
  );

  const hideBtwAside = useCallback(
    (asideId: string) => {
      materializeBtwAside(asideId);
      setFocusedBtwAsideId((current) => (current === asideId ? null : current));
    },
    [materializeBtwAside],
  );

  const toggleBtwAsideExpanded = useCallback(
    (asideId: string) => {
      updateBtwAside(asideId, (aside) => ({
        ...aside,
        expanded: !aside.expanded,
        updatedAt: new Date().toISOString(),
      }));
    },
    [updateBtwAside],
  );

  // Reset wide-screen split-pane collapse whenever the focus moves between
  // asides or back to Mother — explicit collapse only persists for one focus.
  // Also drop the in-pane composer draft so a stale half-typed turn does not
  // resurface under a different aside.
  useEffect(() => {
    setBtwSidePaneCollapsed(false);
    setAsideDraft("");
  }, [focusedBtwAsideId]);

  const handleStopBtwAside = useCallback(
    async (asideId: string) => {
      const aside = btwAsides.find((item) => item.id === asideId);
      if (!aside) return;
      if (!aside.processId) {
        hideBtwAside(asideId);
        return;
      }

      try {
        const result = await api.interruptProcess(aside.processId);
        if (!result.interrupted && !result.aborted) {
          await api.abortProcess(aside.processId);
        }
        const stoppedAt = new Date().toISOString();
        updateBtwAside(asideId, (current) => ({
          ...current,
          status: "stopped",
          historyAt: current.historyAt ?? stoppedAt,
          updatedAt: stoppedAt,
        }));
      } catch (err) {
        try {
          await api.abortProcess(aside.processId);
          const stoppedAt = new Date().toISOString();
          updateBtwAside(asideId, (current) => ({
            ...current,
            status: "stopped",
            historyAt: current.historyAt ?? stoppedAt,
            updatedAt: stoppedAt,
          }));
        } catch {
          const message = err instanceof Error ? err.message : String(err);
          updateBtwAside(asideId, (current) => ({
            ...current,
            status: "failed",
            error: message,
            historyAt: current.historyAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
        }
      }
      setFocusedBtwAsideId((current) => (current === asideId ? null : current));
    },
    [btwAsides, hideBtwAside, updateBtwAside],
  );

  const stickyBtwAsides = useMemo(
    () => btwAsides.filter((aside) => !aside.historyAt),
    [btwAsides],
  );
  // Wide-screen split-pane layout: focus and footer routing are separate. A
  // focused aside can own the pane composer while Mother's footer remains on
  // Mother; collapsed/narrow layouts route the footer into the aside.
  const hasFocusedBtwAside = !!focusedBtwAside;
  const {
    wantSplitLayout: wantBtwSplitLayout,
    showSidePane: showBtwSidePane,
    footerRoutesToAside: mainComposerForAside,
  } = getBtwSplitRouting({
    isWideScreen,
    hasFocusedAside: hasFocusedBtwAside,
    sidePaneCollapsed: btwSidePaneCollapsed,
  });
  const composerStickyBtwAsides = useMemo(() => {
    if (showBtwSidePane && focusedBtwAside) {
      return stickyBtwAsides.filter((aside) => aside.id !== focusedBtwAside.id);
    }
    return stickyBtwAsides;
  }, [stickyBtwAsides, showBtwSidePane, focusedBtwAside]);
  const btwToolbarMode = getBtwToolbarMode({
    hasChildParentHref: !!childSessionParentHref,
    hasFocusedAside: hasFocusedBtwAside,
    footerRoutesToAside: mainComposerForAside,
    paneComposerVisible: showBtwSidePane,
    hasAvailableAsides: stickyBtwAsides.length > 0,
  });
  const historyBtwAsides = useMemo(
    () =>
      btwAsides
        .filter((aside) => aside.historyAt)
        .map((aside) => ({
          ...aside,
          isFocused: focusedBtwAsideId === aside.id,
          canStop: aside.status === "starting" || aside.status === "running",
        })),
    [btwAsides, focusedBtwAsideId],
  );

  const applyMotherComposerTransfer = useCallback(
    (controls: DraftControls, text: string) => {
      const nextDraft = appendComposerTransferDraft(controls.getDraft(), text);
      controls.setDraft(nextDraft);
      showToast("Inserted /btw turn into Mother composer.", "info");
    },
    [showToast],
  );

  const flushPendingMotherComposerTransfer = useCallback(
    (controls = draftControlsRef.current) => {
      if (mainComposerForAside || !controls) {
        return;
      }
      const pendingText = pendingMotherComposerTransferRef.current;
      if (!pendingText) {
        return;
      }
      pendingMotherComposerTransferRef.current = null;
      applyMotherComposerTransfer(controls, pendingText);
    },
    [applyMotherComposerTransfer, mainComposerForAside],
  );

  const handleDraftControlsReady = useCallback(
    (controls: DraftControls) => {
      draftControlsRef.current = controls;
      flushPendingMotherComposerTransfer(controls);
    },
    [flushPendingMotherComposerTransfer],
  );

  useEffect(() => {
    flushPendingMotherComposerTransfer();
  }, [flushPendingMotherComposerTransfer]);

  const transferBtwTurnToMotherComposer = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      if (mainComposerForAside) {
        pendingMotherComposerTransferRef.current = trimmed;
        setFocusedBtwAsideId(null);
        return;
      }

      const controls = draftControlsRef.current;
      if (!controls) {
        pendingMotherComposerTransferRef.current = trimmed;
        return;
      }
      applyMotherComposerTransfer(controls, trimmed);
    },
    [applyMotherComposerTransfer, mainComposerForAside],
  );

  const handleCustomCommand = useCallback(
    (command: string, argument = "") => {
      if (command === "model") {
        setShowModelSwitchModal(true);
        return true;
      }
      if (command === "compact") {
        void handleCompactSession();
        return true;
      }
      if (command === "btw") {
        return startBtwAside(argument);
      }
      if (command === "done") {
        if (!focusedBtwAside) {
          showToast(
            "/done closes a focused /btw aside; no aside is focused.",
            "error",
          );
          return true;
        }
        hideBtwAside(focusedBtwAside.id);
        if (argument.trim()) {
          // Report-back drafting (/done <text>, /done summary, /done file ...)
          // is described in topics/provider-agnostic-btw-asides.md but is not
          // wired yet; close-only for now.
          showToast(
            "Aside closed. (Report-back drafting not yet implemented.)",
            "info",
          );
        }
        return true;
      }
      return false;
    },
    [
      focusedBtwAside,
      handleCompactSession,
      hideBtwAside,
      showToast,
      startBtwAside,
    ],
  );

  const handleToolbarSlashCommand = useCallback(
    (command: string) => {
      const bare = command.startsWith("/") ? command.slice(1) : command;
      handleCustomCommand(bare);
    },
    [handleCustomCommand],
  );

  const handleBtwShortcut = useCallback(
    (text: string): boolean => {
      if (childSessionParentHref) {
        navigate(childSessionParentHref);
        return false;
      }

      if (!supportsBtwAsides) {
        return false;
      }

      if (focusedBtwAside) {
        if (showBtwSidePane) {
          window.setTimeout(() => asideComposerRef.current?.focus(), 0);
          return false;
        }
        setFocusedBtwAsideId(null);
        return false;
      }

      if (!text.trim() && stickyBtwAsides.length > 0) {
        const latestAside = stickyBtwAsides[stickyBtwAsides.length - 1];
        setFocusedBtwAsideId(latestAside?.id ?? null);
        return false;
      }

      return startBtwAside(text);
    },
    [
      childSessionParentHref,
      focusedBtwAside,
      navigate,
      showBtwSidePane,
      startBtwAside,
      stickyBtwAsides,
      supportsBtwAsides,
    ],
  );

  const slashModelIndicatorTone =
    currentOwnedProcessId && liveModelConfig
      ? getIndicatorToneFromProcess(
          liveModelConfig.thinking,
          liveModelConfig.effort,
          effectiveProvider,
        )
      : undefined;
  const liveBadgeModel = liveModelConfig?.model ?? effectiveModel;
  // Keep the status title compact while preserving model state for non-status
  // states and avoid leaking verbose model suffixes.
  const stripBadgePrefix = (model: string) => {
    const compactCodexLabel = getModelIndicatorModelLabel(
      effectiveProvider,
      model,
    );
    const compactModel =
      effectiveProvider === "codex" || effectiveProvider === "codex-oss"
        ? compactCodexLabel || model
        : model;
    const claudeMatch = compactModel.match(/^claude-\w+-(.+)$/);
    return claudeMatch ? claudeMatch[1] : compactModel;
  };
  const slashModelIndicatorTitle = useMemo(() => {
    if (!currentOwnedProcessId) {
      return "Slash commands";
    }

    if (isCompacting) {
      return "Compacting";
    }

    if (processState === "in-turn") {
      return "Thinking";
    }

    if (processState === "waiting-input") {
      return "Waiting for input";
    }

    if (processState === "hold") {
      return "On hold";
    }

    return liveBadgeModel
      ? `${stripBadgePrefix(liveBadgeModel)} · ${
          liveModelConfig?.thinking?.type === "disabled" ||
          !liveModelConfig?.thinking
            ? "Thinking off"
            : liveModelConfig?.effort
              ? `Effort ${getEffortLevelLabel(
                  normalizeEffortLevelForProvider(
                    liveModelConfig.effort,
                    effectiveProvider,
                  ),
                  effectiveProvider,
                )}`
              : "Thinking auto"
        }`
      : "Slash commands";
  }, [
    currentOwnedProcessId,
    isCompacting,
    processState,
    liveBadgeModel,
    effectiveProvider,
    liveModelConfig?.effort,
    liveModelConfig?.thinking?.type,
  ]);

  const handleAbort = async () => {
    if (status.owner === "self" && status.processId) {
      // Try interrupt first (graceful stop), fall back to abort if not supported
      try {
        logSessionUiTrace("stop-request", {
          sessionId,
          processId: status.processId,
          processState,
        });
        const result = await api.interruptProcess(status.processId);
        logSessionUiTrace("stop-interrupt-result", {
          sessionId,
          processId: status.processId,
          interrupted: result.interrupted,
          aborted: result.aborted,
          supported: result.supported,
        });
        if (result.interrupted || result.aborted) {
          if (result.aborted) {
            setStatus({ owner: "none" });
            setProcessState("idle");
          }
          return;
        }
        // Interrupt not supported or failed, fall back to abort
      } catch {
        logSessionUiTrace("stop-interrupt-error", {
          sessionId,
          processId: status.processId,
        });
        // Interrupt endpoint failed (404 = old server, or other error)
      }
      // Fall back to abort (kills the process)
      await api.abortProcess(status.processId);
      logSessionUiTrace("stop-abort-fallback", {
        sessionId,
        processId: status.processId,
      });
    }
  };

  const syncPendingInputFromServer = useCallback(async () => {
    try {
      const result = await api.getPendingInputRequest(sessionId);
      setPendingInputRequest(result.request ?? null);
    } catch {
      // Best-effort stale approval cleanup; the stream will also reconcile.
    }
  }, [sessionId, setPendingInputRequest]);

  const handleInputResponseError = useCallback(
    async (err: unknown, fallbackMessage: string) => {
      const status = (err as { status?: number }).status;
      const msg = status ? `Error ${status}` : fallbackMessage;
      showToast(msg, "error");
      if (status === 400) {
        await syncPendingInputFromServer();
      }
    },
    [showToast, syncPendingInputFromServer],
  );

  const handleApprove = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        const result = await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "approve",
        );
        setPendingInputRequest(result.pendingInputRequest ?? null);
      } catch (err) {
        await handleInputResponseError(err, t("sessionApproveFailed"));
      }
    }
  }, [
    sessionId,
    pendingInputRequest,
    setPendingInputRequest,
    handleInputResponseError,
    t,
  ]);

  const handleApproveAcceptEdits = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        // Approve and switch to acceptEdits mode
        const result = await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "approve_accept_edits",
        );
        setPendingInputRequest(result.pendingInputRequest ?? null);
        // Update local permission mode
        setPermissionMode("acceptEdits");
      } catch (err) {
        await handleInputResponseError(err, t("sessionApproveFailed"));
      }
    }
  }, [
    sessionId,
    pendingInputRequest,
    setPendingInputRequest,
    setPermissionMode,
    handleInputResponseError,
    t,
  ]);

  const handleDeny = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        const result = await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "deny",
        );
        setPendingInputRequest(result.pendingInputRequest ?? null);
      } catch (err) {
        await handleInputResponseError(err, t("sessionDenyFailed"));
      }
    }
  }, [
    sessionId,
    pendingInputRequest,
    setPendingInputRequest,
    handleInputResponseError,
    t,
  ]);

  const handleDenyWithFeedback = useCallback(
    async (feedback: string) => {
      if (pendingInputRequest) {
        try {
          const result = await api.respondToInput(
            sessionId,
            pendingInputRequest.id,
            "deny",
            undefined,
            feedback,
          );
          setPendingInputRequest(result.pendingInputRequest ?? null);
        } catch (err) {
          await handleInputResponseError(err, t("sessionFeedbackFailed"));
        }
      }
    },
    [
      sessionId,
      pendingInputRequest,
      setPendingInputRequest,
      handleInputResponseError,
      t,
    ],
  );

  const handleQuestionSubmit = useCallback(
    async (answers: Record<string, string>) => {
      if (pendingInputRequest) {
        try {
          const result = await api.respondToInput(
            sessionId,
            pendingInputRequest.id,
            "approve",
            answers,
          );
          setPendingInputRequest(result.pendingInputRequest ?? null);
        } catch (err) {
          await handleInputResponseError(err, t("sessionAnswerFailed"));
        }
      }
    },
    [
      sessionId,
      pendingInputRequest,
      setPendingInputRequest,
      handleInputResponseError,
      t,
    ],
  );

  // Handle file attachment uploads
  // Each file uploads independently (parallel) and its promise is tracked
  // so handleSend can wait for in-flight uploads before sending
  const handleAttach = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const tempId = generateUUID();

        // Add to progress tracking
        setUploadProgress((prev) => [
          ...prev,
          {
            fileId: tempId,
            fileName: file.name,
            bytesUploaded: 0,
            totalBytes: file.size,
            percent: 0,
          },
        ]);

        // Start upload and track promise for handleSend to await
        const uploadPromise = (async () => {
          const preparedImage = file.type.startsWith("image/")
            ? await prepareImageUpload(
                file,
                getAttachmentUploadLongEdgePx(attachmentQuality),
              )
            : { file };
          const uploadFile = preparedImage.file;
          return connection.upload(projectId, sessionId, uploadFile, {
            onProgress: (bytesUploaded) => {
              setUploadProgress((prev) =>
                prev.map((p) =>
                  p.fileId === tempId
                    ? {
                        ...p,
                        bytesUploaded,
                        percent: Math.round(
                          (bytesUploaded / uploadFile.size) * 100,
                        ),
                      }
                    : p,
                ),
              );
            },
            ...(preparedImage.width !== undefined &&
            preparedImage.height !== undefined
              ? {
                  imageDimensions: {
                    width: preparedImage.width,
                    height: preparedImage.height,
                  },
                }
              : {}),
          });
        })()
          .then(
            (uploaded) => {
              if (uploaded.mimeType.startsWith("image/")) {
                void storeUploadedAttachmentPreview(uploaded, file).catch(
                  (err) => {
                    console.warn(
                      "[SessionPage] Failed to cache attachment preview:",
                      err,
                    );
                  },
                );
              }
              setAttachments((prev) => [...prev, uploaded]);
              return uploaded;
            },
            (err) => {
              console.error("Upload failed:", err);
              const errorMsg =
                err instanceof Error ? err.message : t("sessionShareFailed");
              showToast(
                t("sessionUploadFailed", {
                  file: file.name,
                  message: errorMsg,
                }),
                "error",
              );
              return null as UploadedFile | null;
            },
          )
          .finally(() => {
            setUploadProgress((prev) =>
              prev.filter((p) => p.fileId !== tempId),
            );
            pendingUploadsRef.current.delete(tempId);
          });

        pendingUploadsRef.current.set(tempId, uploadPromise);
      }
    },
    [projectId, sessionId, showToast, connection, t, attachmentQuality],
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Check if pending request is an AskUserQuestion
  const isAskUserQuestion = pendingInputRequest?.toolName === "AskUserQuestion";

  // Suppress current-turn orphan markers while owned process state says the
  // turn is active. Completed assistant text only settles stale fallback
  // evidence, such as old pending tool rows after the process goes idle.
  const activeToolApproval = sessionActivityUi.shouldSuppressCurrentTurnOrphans;

  // Detect if session has pending tool calls without results
  // This can happen when the session is unowned but was active in another process (VS Code, CLI)
  // that is waiting for user input (tool approval, question answer)
  const hasPendingToolCalls =
    status.owner === "none" && hasPendingRenderedToolCalls;
  const pendingElsewhereDismissKey = useMemo(
    () => `${PENDING_ELSEWHERE_DISMISS_KEY_PREFIX}${actualSessionId}`,
    [actualSessionId],
  );

  // Compute display title - priority:
  // 1. Local custom title (user renamed in this session)
  // 2. Session title from server
  // 3. Initial title from navigation state (optimistic, before server responds)
  // 4. "Untitled" as final fallback
  const sessionTitle = getSessionDisplayTitle(session);
  const displayTitle =
    localCustomTitle ??
    (sessionTitle !== "Untitled" ? sessionTitle : null) ??
    initialTitle ??
    t("sessionUntitled");
  const isArchived = localIsArchived ?? session?.isArchived ?? false;
  const isStarred = localIsStarred ?? session?.isStarred ?? false;
  const heartbeatTurnsEnabled =
    localHeartbeatTurnsEnabled ?? session?.heartbeatTurnsEnabled ?? false;
  const heartbeatTurnsAfterMinutes =
    localHeartbeatTurnsAfterMinutes ?? session?.heartbeatTurnsAfterMinutes;
  const heartbeatTurnText =
    localHeartbeatTurnText ?? session?.heartbeatTurnText;
  const heartbeatForceAfterMinutes =
    localHeartbeatForceAfterMinutes ?? session?.heartbeatForceAfterMinutes;

  useEffect(() => {
    if (typeof window === "undefined") return;
    setPendingElsewhereDismissed(
      window.localStorage.getItem(pendingElsewhereDismissKey) === "1",
    );
  }, [pendingElsewhereDismissKey]);

  const handleDismissPendingElsewhereWarning = useCallback(() => {
    setPendingElsewhereDismissed(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(pendingElsewhereDismissKey, "1");
    }
  }, [pendingElsewhereDismissKey]);

  const handleRestorePendingElsewhereWarning = useCallback(() => {
    setPendingElsewhereDismissed(false);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(pendingElsewhereDismissKey);
    }
  }, [pendingElsewhereDismissKey]);

  // Update browser tab title
  useDocumentTitle(project?.name, displayTitle);

  const handleStartEditingTitle = () => {
    setRenameValue(displayTitle);
    setIsEditingTitle(true);
    // Focus the input and select all text after it renders
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };

  const handleCancelEditingTitle = () => {
    // Don't cancel if we're in the middle of saving
    if (isSavingTitleRef.current) return;
    setIsEditingTitle(false);
    setRenameValue("");
  };

  // On blur, save if value changed (handles mobile keyboard dismiss on Enter)
  const handleTitleBlur = () => {
    // Don't interfere if we're already saving
    if (isSavingTitleRef.current) return;
    // If value is empty or unchanged, just cancel
    if (!renameValue.trim() || renameValue.trim() === displayTitle) {
      handleCancelEditingTitle();
      return;
    }
    // Otherwise save (handles mobile Enter which blurs before keydown fires)
    handleSaveTitle();
  };

  const handleSaveTitle = async () => {
    if (!renameValue.trim() || isRenaming) return;
    isSavingTitleRef.current = true;
    setIsRenaming(true);
    try {
      await api.updateSessionMetadata(sessionId, { title: renameValue.trim() });
      setLocalCustomTitle(renameValue.trim());
      setIsEditingTitle(false);
      showToast(t("sessionRenamed"), "success");
    } catch (err) {
      console.error("Failed to rename session:", err);
      showToast(t("sessionRenameFailed"), "error");
    } finally {
      setIsRenaming(false);
      isSavingTitleRef.current = false;
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEditingTitle();
    }
  };

  const handleToggleArchive = async () => {
    const newArchived = !isArchived;
    try {
      await api.updateSessionMetadata(sessionId, { archived: newArchived });
      setLocalIsArchived(newArchived);
      showToast(
        newArchived ? t("sessionArchived") : t("sessionUnarchived"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update archive status:", err);
      showToast(t("sessionArchiveFailed"), "error");
    }
  };

  const handleToggleStar = async () => {
    const newStarred = !isStarred;
    try {
      await api.updateSessionMetadata(sessionId, { starred: newStarred });
      setLocalIsStarred(newStarred);
      showToast(
        newStarred ? t("sessionStarred") : t("sessionUnstarred"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update star status:", err);
      showToast(t("sessionStarFailed"), "error");
    }
  };

  const hasUnread = localHasUnread ?? session?.hasUnread ?? false;

  const handleToggleRead = async () => {
    const newHasUnread = !hasUnread;
    setLocalHasUnread(newHasUnread);
    try {
      if (newHasUnread) {
        await api.markSessionUnread(sessionId);
      } else {
        await api.markSessionSeen(sessionId);
      }
      showToast(
        newHasUnread ? t("sessionMarkedUnread") : t("sessionMarkedRead"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update read status:", err);
      setLocalHasUnread(undefined); // Revert on error
      showToast(t("sessionReadFailed"), "error");
    }
  };

  const handleTerminate = async () => {
    if (status.owner === "self" && status.processId) {
      try {
        await api.abortProcess(status.processId);
        showToast(t("sessionTerminated"), "success");
      } catch (err) {
        console.error("Failed to terminate session:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(t("sessionTerminateFailed", { message: errorMsg }), "error");
      }
    }
  };

  const handleShare = useCallback(() => {
    setShareModalAnchor(null);
    setShowShareModal(true);
  }, []);

  const handleShareIndicatorClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setShareModalAnchor({
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      });
      setShowShareModal(true);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setPublicShareStatus(null);

    if (!showPublicShareControls) {
      return () => {
        cancelled = true;
      };
    }

    const refreshPublicShareStatus = async () => {
      try {
        const nextStatus = await api.getPublicSessionShareStatus(
          projectId,
          actualSessionId,
        );
        if (!cancelled) {
          setPublicShareStatus(nextStatus);
        }
      } catch {
        if (!cancelled) {
          setPublicShareStatus(null);
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(
            refreshPublicShareStatus,
            PUBLIC_SHARE_STATUS_POLL_MS,
          );
        }
      }
    };

    void refreshPublicShareStatus();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [actualSessionId, projectId, showPublicShareControls]);

  const handleToggleHeartbeat = useCallback(async () => {
    const previousEnabled = heartbeatTurnsEnabled;
    const nextEnabled = !previousEnabled;
    setLocalHeartbeatTurnsEnabled(nextEnabled);
    try {
      await api.updateSessionMetadata(actualSessionId, {
        heartbeatTurnsEnabled: nextEnabled,
      });
    } catch (err) {
      console.error("Failed to update heartbeat status:", err);
      setLocalHeartbeatTurnsEnabled(previousEnabled);
      const errorMsg =
        err instanceof Error ? err.message : t("sessionHeartbeatSaveFailed");
      showToast(errorMsg, "error");
    }
  }, [actualSessionId, heartbeatTurnsEnabled, showToast, t]);

  if (error) {
    const errorStatus =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status?: number }).status
        : undefined;
    const isNotFound =
      error.message?.includes("Session not found") ||
      error.message?.includes("not found") ||
      errorStatus === 404;

    if (isNotFound && actualSessionId) {
      return (
        <div className="error" style={{ maxWidth: 520, margin: "40px auto" }}>
          <h2 style={{ marginTop: 0 }}>Session not found</h2>
          <p style={{ color: "#666" }}>
            The backing data for this session on disk or in a live process is
            gone. This commonly happens for Grok sessions after a YA server
            restart or when native session directories were cleaned.
          </p>
          <div
            style={{
              display: "flex",
              gap: 12,
              marginTop: 16,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={async () => {
                try {
                  await api.updateSessionMetadata(actualSessionId, {
                    archived: true,
                  });
                  showToast("Archived and hidden from lists.", "success");
                  navigate(`${basePath}/sessions?project=${projectId}`, {
                    replace: true,
                  });
                } catch (err) {
                  const message =
                    err instanceof Error ? err.message : String(err);
                  showToast(`Failed to archive: ${message}`, "error");
                }
              }}
              style={{ padding: "8px 14px", cursor: "pointer" }}
            >
              Archive / Hide from all lists
            </button>
            <button
              type="button"
              onClick={() => window.history.back()}
              style={{ padding: "8px 14px", cursor: "pointer" }}
            >
              Go back
            </button>
          </div>
          <p style={{ fontSize: "12px", color: "#888", marginTop: 20 }}>
            Session ID: <code>{actualSessionId}</code>
            <br />
            Run <code>ya-clean</code> for bulk bad-state and duplicate cleanup.
          </p>
        </div>
      );
    }

    return (
      <div className="error">
        {t("sessionErrorPrefix")} {error.message}
      </div>
    );
  }

  // Sidebar icon component
  const SidebarIcon = () => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );

  return (
    <MainContent isWideScreen={isWideScreen}>
      <header className="session-header">
        <div className="session-header-inner">
          <div className="session-header-left">
            {/* Sidebar toggle - on mobile: opens sidebar, on desktop: collapses/expands */}
            {/* Hide on desktop when collapsed (sidebar has its own toggle) */}
            {!(isWideScreen && isSidebarCollapsed) && (
              <button
                type="button"
                className="sidebar-toggle"
                onClick={isWideScreen ? toggleSidebar : openSidebar}
                title={
                  isWideScreen
                    ? t("sessionToggleSidebar")
                    : t("sessionOpenSidebar")
                }
                aria-label={
                  isWideScreen
                    ? t("sessionToggleSidebar")
                    : t("sessionOpenSidebar")
                }
              >
                <SidebarIcon />
              </button>
            )}
            {/* Project breadcrumb */}
            {project?.name && (
              <Link
                to={`${basePath}/sessions?project=${projectId}`}
                className="project-breadcrumb"
                title={project.name}
                aria-label={project.name}
              >
                {project.name.length > 12
                  ? `${project.name.slice(0, 12)}...`
                  : project.name}
              </Link>
            )}
            <div className="session-title-row">
              {isStarred && (
                <svg
                  className="star-indicator-inline"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="currentColor"
                  strokeWidth="2"
                  role="img"
                  aria-label={t("sessionStarredLabel")}
                >
                  <title>{t("sessionStarredLabel")}</title>
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              )}
              {loading ? (
                <span className="session-title-skeleton" />
              ) : isEditingTitle ? (
                <input
                  ref={renameInputRef}
                  type="text"
                  className="session-title-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={handleTitleKeyDown}
                  onBlur={handleTitleBlur}
                  disabled={isRenaming}
                />
              ) : (
                <>
                  <button
                    ref={titleButtonRef}
                    type="button"
                    className="session-title session-title-dropdown-trigger"
                    onClick={() => setShowRecentSessions(!showRecentSessions)}
                    title={session?.fullTitle ?? displayTitle}
                  >
                    <span className="session-title-text">{displayTitle}</span>
                    <svg
                      className="session-title-chevron"
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
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <RecentSessionsDropdown
                    currentSessionId={sessionId}
                    isOpen={showRecentSessions}
                    onClose={() => setShowRecentSessions(false)}
                    onNavigate={() => setShowRecentSessions(false)}
                    triggerRef={titleButtonRef}
                    basePath={basePath}
                  />
                </>
              )}
              {!loading && isArchived && (
                <span className="archived-badge">
                  {t("sessionArchivedBadge")}
                </span>
              )}
              {!loading && (
                <SessionMenu
                  sessionId={sessionId}
                  projectId={projectId}
                  isStarred={isStarred}
                  isArchived={isArchived}
                  hasUnread={hasUnread}
                  provider={session?.provider}
                  processId={
                    status.owner === "self" ? status.processId : undefined
                  }
                  onToggleStar={handleToggleStar}
                  onToggleArchive={handleToggleArchive}
                  onToggleRead={handleToggleRead}
                  onRename={handleStartEditingTitle}
                  onConfigureHeartbeat={() => setShowHeartbeatModal(true)}
                  onConfigureRecaps={
                    status.owner === "self"
                      ? () => setShowRecapModal(true)
                      : undefined
                  }
                  warningRestoreAvailable={
                    hasPendingToolCalls && pendingElsewhereDismissed
                  }
                  onRestoreWarnings={handleRestorePendingElsewhereWarning}
                  onClone={(newSessionId) => {
                    navigate(
                      `${basePath}/projects/${projectId}/sessions/${newSessionId}`,
                    );
                  }}
                  onHandoff={
                    effectiveProvider
                      ? () => setShowHandoffModal(true)
                      : undefined
                  }
                  onCompact={
                    supportsManualCompact ? handleCompactSession : undefined
                  }
                  onTerminate={handleTerminate}
                  onReload={() => window.location.reload()}
                  onShare={showPublicShareControls ? handleShare : undefined}
                  useFixedPositioning
                  useEllipsisIcon
                />
              )}
            </div>
          </div>
          <div className="session-header-right">
            <ClientLogRecordingBadge inline />
            {showPublicShareControls && (
              <ViewerCountIndicator
                className="session-header-viewer-count"
                count={
                  publicShareStatus && publicShareStatus.liveCount > 0
                    ? publicShareStatus.activeViewerCount
                    : null
                }
                label={
                  publicShareStatus
                    ? t("sessionShareViewerSummary", {
                        active: publicShareStatus.activeViewerCount,
                        total: publicShareStatus.viewers.length,
                        live: publicShareStatus.liveCount,
                        frozen: publicShareStatus.frozenCount,
                      })
                    : t("sessionShareOpenTitle")
                }
                onClick={handleShareIndicatorClick}
              />
            )}
            {canStopOwnedProcess && (
              <ThinkingIndicator
                variant="pill"
                className="session-header-thinking"
              />
            )}
            {!loading && effectiveProvider && (
              <button
                type="button"
                className="provider-badge-button"
                onClick={() => setShowProcessInfoModal(true)}
                title={t("sessionViewInfo")}
              >
                <ProviderBadge
                  provider={effectiveProvider}
                  model={liveBadgeModel}
                  thinking={liveModelConfig?.thinking}
                  effort={liveModelConfig?.effort}
                  isThinking={canStopOwnedProcess}
                />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Process Info Modal */}
      {showProcessInfoModal && session && (
        <ProcessInfoModal
          sessionId={actualSessionId}
          provider={session.provider}
          model={session.model}
          status={status}
          processState={processState}
          contextUsage={session.contextUsage}
          originator={session.originator}
          cliVersion={session.cliVersion}
          sessionSource={session.source}
          approvalPolicy={session.approvalPolicy}
          sandboxPolicy={session.sandboxPolicy}
          createdAt={session.createdAt}
          sessionStreamConnected={sessionUpdatesConnected}
          lastSessionEventAt={lastStreamActivityAt}
          onClose={() => setShowProcessInfoModal(false)}
        />
      )}

      {showHeartbeatModal && (
        <SessionHeartbeatModal
          sessionId={actualSessionId}
          enabled={heartbeatTurnsEnabled}
          heartbeatTurnsAfterMinutes={heartbeatTurnsAfterMinutes}
          heartbeatTurnText={heartbeatTurnText}
          heartbeatForceAfterMinutes={heartbeatForceAfterMinutes}
          onClose={() => setShowHeartbeatModal(false)}
          onSaved={(next) => {
            setLocalHeartbeatTurnsEnabled(next.enabled);
            setLocalHeartbeatTurnsAfterMinutes(next.heartbeatTurnsAfterMinutes);
            setLocalHeartbeatTurnText(next.heartbeatTurnText);
            setLocalHeartbeatForceAfterMinutes(next.heartbeatForceAfterMinutes);
            showToast(t("sessionHeartbeatSaved"), "success");
          }}
        />
      )}

      {showRecapModal && status.owner === "self" && (
        <SessionRecapModal
          sessionId={actualSessionId}
          processId={status.processId}
          provider={effectiveProvider}
          currentModel={liveBadgeModel}
          onClose={() => setShowRecapModal(false)}
          onSaved={() => {
            showToast(t("sessionRecapSaved"), "success");
          }}
        />
      )}

      {showShareModal && (
        <SessionShareModal
          anchorRect={shareModalAnchor}
          projectId={projectId}
          sessionId={actualSessionId}
          initialPrompt={publicShareInitialPrompt}
          title={displayTitle}
          canCreateShares={showPublicShareControls}
          onStatusChange={setPublicShareStatus}
          onClose={() => {
            setShowShareModal(false);
            setShareModalAnchor(null);
          }}
        />
      )}

      {/* Model Switch Modal */}
      {showModelSwitchModal && status.owner === "self" && status.processId && (
        <ModelSwitchModal
          processId={status.processId}
          sessionId={actualSessionId}
          currentModel={session?.model}
          onModelChanged={handleModelChanged}
          onClose={() => setShowModelSwitchModal(false)}
        />
      )}

      {showHandoffModal && effectiveProvider && (
        <RestartSessionModal
          projectId={projectId}
          sessionId={actualSessionId}
          provider={effectiveProvider}
          providerDisplayName={currentProviderInfo?.displayName}
          providers={providers}
          models={currentProviderInfo?.models}
          currentModel={liveBadgeModel}
          mode={permissionMode}
          thinking={getThinkingSetting()}
          promptSuggestionMode={liveModelConfig?.promptSuggestionMode}
          executor={session?.executor}
          onRestarted={(result, options) => {
            setShowHandoffModal(false);
            showToast(t("sessionHandoffStarted"), "success");
            const handoffUrl = `${basePath}/projects/${projectId}/sessions/${result.sessionId}`;
            if (options?.targetWindow && !options.targetWindow.closed) {
              options.targetWindow.location.href = handoffUrl;
              return;
            }
            if (options?.openInNewWindow) {
              window.open(handoffUrl, "_blank", "noopener");
              return;
            }
            navigate(handoffUrl, {
              state: createSessionNavigationState({
                initialStatus: {
                  owner: "self",
                  processId: result.processId,
                },
                initialTitle: result.title,
                initialModel: result.model ?? liveBadgeModel,
                initialProvider: result.provider ?? effectiveProvider,
              }),
            });
          }}
          onClose={() => setShowHandoffModal(false)}
        />
      )}

      {status.owner === "external" && (
        <div className="external-session-warning">
          {t("sessionExternalWarning")}
        </div>
      )}

      {hasPendingToolCalls && !pendingElsewhereDismissed && (
        <div
          className="external-session-warning pending-tool-warning"
          role="status"
        >
          <div className="pending-tool-warning-copy">
            <svg
              className="pending-tool-warning-icon"
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
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
            <span>{t("sessionPendingElsewhereWarning")}</span>
          </div>
          <button
            type="button"
            className="pending-tool-warning-close"
            onClick={handleDismissPendingElsewhereWarning}
            aria-label={t("sessionPendingElsewhereDismiss")}
            title={t("sessionPendingElsewhereDismiss")}
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
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      )}

      <div
        className={`session-split${
          wantBtwSplitLayout ? " session-split-with-aside" : ""
        }${
          wantBtwSplitLayout && btwSidePaneCollapsed
            ? " session-split-aside-collapsed"
            : ""
        }`}
      >
        <main className="session-messages">
          {loading ? (
            <div className="loading">{t("sessionLoading")}</div>
          ) : (
            <SessionMetadataProvider
              projectId={projectId}
              projectPath={project?.path ?? null}
              sessionId={sessionId}
            >
              <AgentContentProvider
                agentContent={agentContent}
                setAgentContent={setAgentContent}
                toolUseToAgent={toolUseToAgent}
                projectId={projectId}
                sessionId={sessionId}
              >
                <MessageList
                  messages={messages}
                  provider={session?.provider}
                  isProcessing={sessionActivityUi.showProcessingIndicator}
                  isCompacting={isCompacting}
                  scrollTrigger={scrollTrigger}
                  pendingMessages={pendingMessages}
                  deferredMessages={deferredMessages}
                  btwAsides={historyBtwAsides}
                  onFocusBtwAside={setFocusedBtwAsideId}
                  onDoneBtwAside={() => setFocusedBtwAsideId(null)}
                  onStopBtwAside={(asideId) => void handleStopBtwAside(asideId)}
                  onToggleBtwAsideExpanded={toggleBtwAsideExpanded}
                  onTransferBtwAsideTurn={transferBtwTurnToMotherComposer}
                  onCancelDeferred={handleCancelDeferred}
                  onEditDeferred={handleEditDeferred}
                  onCorrectLatestUserMessage={handleCorrectLatestUserMessage}
                  onTrimBeforeUserMessage={trimClientFromUserMessage}
                  markdownAugments={markdownAugments}
                  activeToolApproval={activeToolApproval}
                  hasOlderMessages={pagination?.hasOlderMessages}
                  loadingOlder={loadingOlder}
                  onLoadOlderMessages={loadOlderMessages}
                  clientTailActive={clientTailActive}
                />
              </AgentContentProvider>
            </SessionMetadataProvider>
          )}
        </main>
        {showBtwSidePane && focusedBtwAside && (
          <BtwAsidePane
            aside={focusedBtwAside}
            draft={asideDraft}
            composerRef={asideComposerRef}
            onDraftChange={setAsideDraft}
            onSendFollowup={handleFocusedBtwSend}
            onHide={() => setBtwSidePaneCollapsed(true)}
            onDone={(argument) => handleCustomCommand("done", argument)}
            onStop={() => void handleStopBtwAside(focusedBtwAside.id)}
            onTransferToComposer={transferBtwTurnToMotherComposer}
          />
        )}
        {wantBtwSplitLayout && btwSidePaneCollapsed && (
          <button
            type="button"
            className="session-btw-pane-handle"
            onClick={() => setBtwSidePaneCollapsed(false)}
            title="Maximize /btw aside pane"
            aria-label="Maximize /btw aside pane"
          >
            /btw
          </button>
        )}

        <footer className="session-input">
          <div
            className={`session-connection-bar session-connection-${sessionConnectionStatus}`}
          />
          <div className="session-input-inner">
            {composerStickyBtwAsides.length > 0 && (
              <div
                className="btw-aside-stack"
                role="region"
                aria-label="/btw asides"
              >
                {composerStickyBtwAsides.map((aside) => {
                  const isFocused = focusedBtwAsideId === aside.id;
                  const canExpand = Boolean(
                    aside.request ||
                      aside.followUps.length > 0 ||
                      aside.responses.length > 0 ||
                      (aside.turns?.length ?? 0) > 0,
                  );
                  return (
                    <div
                      key={aside.id}
                      className={`btw-aside-card is-${aside.status} ${
                        isFocused ? "is-focused" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="btw-aside-main"
                        onClick={() => setFocusedBtwAsideId(aside.id)}
                      >
                        <span className="btw-aside-meta">
                          /btw {aside.status}
                        </span>
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
                          <span className="btw-aside-preview">
                            {aside.preview}
                          </span>
                        )}
                        {aside.error && (
                          <span className="btw-aside-error">{aside.error}</span>
                        )}
                      </button>
                      {aside.expanded && canExpand && (
                        <BtwAsideTranscript
                          aside={aside}
                          autoScrollLatest
                          onTransferToComposer={transferBtwTurnToMotherComposer}
                        />
                      )}
                      <div className="btw-aside-actions">
                        {canExpand && (
                          <button
                            type="button"
                            className="btw-aside-action"
                            onClick={() => toggleBtwAsideExpanded(aside.id)}
                          >
                            {aside.expanded ? "Less" : "Show"}
                          </button>
                        )}
                        {isFocused && (
                          <button
                            type="button"
                            className="btw-aside-action"
                            onClick={() => hideBtwAside(aside.id)}
                            title="Return the composer to the main session"
                          >
                            Done
                          </button>
                        )}
                        {(aside.status === "starting" ||
                          aside.status === "running") && (
                          <button
                            type="button"
                            className="btw-aside-action btw-aside-action-stop"
                            onClick={() => void handleStopBtwAside(aside.id)}
                            title={
                              isFocused
                                ? "Stop this /btw aside and return to the main session"
                                : "Stop this /btw aside"
                            }
                          >
                            Stop
                          </button>
                        )}
                        <button
                          type="button"
                          className="btw-aside-action"
                          onClick={() => hideBtwAside(aside.id)}
                          title="Move this aside into session history"
                        >
                          Hide
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* User question panel */}
            {pendingInputRequest &&
              pendingInputRequest.sessionId === actualSessionId &&
              isAskUserQuestion && (
                <QuestionAnswerPanel
                  request={pendingInputRequest}
                  sessionId={actualSessionId}
                  onSubmit={handleQuestionSubmit}
                  onDeny={handleDeny}
                />
              )}

            {/* Tool approval: show panel + always-visible toolbar */}
            {pendingInputRequest &&
              pendingInputRequest.sessionId === actualSessionId &&
              !isAskUserQuestion && (
                <>
                  <ToolApprovalPanel
                    request={pendingInputRequest}
                    sessionId={actualSessionId}
                    onApprove={handleApprove}
                    onDeny={handleDeny}
                    onApproveAcceptEdits={handleApproveAcceptEdits}
                    onDenyWithFeedback={handleDenyWithFeedback}
                    collapsed={approvalCollapsed}
                    onCollapsedChange={setApprovalCollapsed}
                  />
                  <MessageInputToolbar
                    mode={permissionMode}
                    onModeChange={setPermissionMode}
                    isHeld={holdModeEnabled ? isHeld : undefined}
                    onHoldChange={holdModeEnabled ? setHold : undefined}
                    supportsPermissionMode={supportsPermissionMode}
                    supportsThinkingToggle={supportsThinkingToggle}
                    slashCommands={
                      status.owner === "self" ? allSlashCommands : []
                    }
                    onSelectSlashCommand={handleToolbarSlashCommand}
                    modelIndicatorTone={slashModelIndicatorTone}
                    modelIndicatorProvider={effectiveProvider}
                    modelIndicatorModel={liveBadgeModel}
                    modelIndicatorTitle={slashModelIndicatorTitle}
                    heartbeatEnabled={heartbeatTurnsEnabled}
                    onToggleHeartbeat={handleToggleHeartbeat}
                    onConfigureHeartbeat={() => setShowHeartbeatModal(true)}
                    contextUsage={session?.contextUsage}
                    lastActivityAt={activityAt}
                    sessionLiveness={sessionLiveness}
                    isRunning={status.owner === "self"}
                    isThinking={canStopOwnedProcess}
                    onStop={handleAbort}
                    pendingApproval={
                      approvalCollapsed
                        ? {
                            type: "tool-approval",
                            onExpand: () => setApprovalCollapsed(false),
                          }
                        : undefined
                    }
                  />
                </>
              )}

            {/* No pending approval: show full message input */}
            {!(
              pendingInputRequest &&
              pendingInputRequest.sessionId === actualSessionId &&
              !isAskUserQuestion
            ) && (
              <MessageInput
                onSend={
                  mainComposerForAside
                    ? handleFocusedBtwSend
                    : primaryComposerAction === "steer"
                      ? handleSend
                      : shouldDeferMessages
                        ? handleQueue
                        : handleSend
                }
                onQueue={
                  !mainComposerForAside &&
                  shouldDeferMessages &&
                  generallySupportsSteering
                    ? handleQueue
                    : undefined
                }
                primaryActionKind={
                  mainComposerForAside ? "send" : primaryComposerAction
                }
                placeholder={
                  mainComposerForAside
                    ? "/btw follow-up"
                    : status.owner === "external"
                      ? t("sessionPlaceholderExternal")
                      : processState === "idle"
                        ? shouldDeferMessages
                          ? t("sessionPlaceholderQueue")
                          : t("sessionPlaceholderResume")
                        : t("sessionPlaceholderQueue")
                }
                mode={permissionMode}
                onModeChange={setPermissionMode}
                isHeld={holdModeEnabled ? isHeld : undefined}
                onHoldChange={holdModeEnabled ? setHold : undefined}
                supportsPermissionMode={supportsPermissionMode}
                supportsThinkingToggle={supportsThinkingToggle}
                supportsSteering={generallySupportsSteering}
                isRunning={status.owner === "self"}
                isThinking={canStopOwnedProcess}
                onStop={handleAbort}
                draftKey={
                  mainComposerForAside && focusedBtwAside
                    ? `draft-btw-${focusedBtwAside.sessionId ?? focusedBtwAside.id}`
                    : `draft-message-${sessionId}`
                }
                onDraftControlsReady={handleDraftControlsReady}
                correctionActive={
                  !mainComposerForAside && correctionDraft !== null
                }
                onCancelCorrection={
                  mainComposerForAside ? undefined : handleCancelCorrection
                }
                onRecallLastSubmission={handleRecallLastSubmission}
                onCancelLatestDeferred={handleCancelLatestDeferred}
                collapsed={
                  !!(
                    pendingInputRequest &&
                    pendingInputRequest.sessionId === actualSessionId
                  )
                }
                contextUsage={session?.contextUsage}
                lastActivityAt={activityAt}
                sessionLiveness={sessionLiveness}
                projectId={projectId}
                sessionId={sessionId}
                attachments={mainComposerForAside ? [] : attachments}
                onAttach={mainComposerForAside ? undefined : handleAttach}
                onRemoveAttachment={
                  mainComposerForAside ? undefined : handleRemoveAttachment
                }
                uploadProgress={mainComposerForAside ? [] : uploadProgress}
                slashCommands={status.owner === "self" ? allSlashCommands : []}
                onCustomCommand={handleCustomCommand}
                onBtwShortcut={
                  childSessionParentHref || supportsBtwAsides
                    ? handleBtwShortcut
                    : undefined
                }
                btwActive={!!mainComposerForAside || !!childSessionParentHref}
                btwHasAsides={
                  stickyBtwAsides.length > 0 || !!childSessionParentHref
                }
                btwToolbarMode={btwToolbarMode}
                modelIndicatorTone={slashModelIndicatorTone}
                modelIndicatorProvider={effectiveProvider}
                modelIndicatorModel={liveBadgeModel}
                modelIndicatorTitle={slashModelIndicatorTitle}
                heartbeatEnabled={heartbeatTurnsEnabled}
                onToggleHeartbeat={handleToggleHeartbeat}
                onConfigureHeartbeat={() => setShowHeartbeatModal(true)}
                promptSuggestion={
                  mainComposerForAside
                    ? undefined
                    : (promptSuggestion ?? undefined)
                }
                onDismissPromptSuggestion={
                  mainComposerForAside ? undefined : dismissPromptSuggestion
                }
              />
            )}
          </div>
        </footer>
      </div>
    </MainContent>
  );
}
