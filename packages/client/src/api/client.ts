import type {
  AgentActivity,
  AgentContextHints,
  BrowserProfilesResponse,
  ClientDefaults,
  ConnectionsResponse,
  CreatePublicSessionShareRequest,
  CreatePublicSessionShareResponse,
  DeviceInfo,
  EnrichedRecentEntry,
  FileContentResponse,
  FreezePublicSessionLiveSharesResponse,
  GitStatusInfo,
  HelperTargetConfig,
  ModelInfo,
  NewSessionDefaults,
  PendingInputType,
  PromptSuggestionMode,
  PromptCacheKeepaliveSettings,
  ProviderInfo,
  ProviderName,
  RecapMode,
  PublicSessionShareSessionStatusResponse,
  PublicSessionShareViewerActionResponse,
  RevokePublicSessionSharesResponse,
  SessionMetadataResponse,
  SessionLivenessSnapshot,
  ShowThinking,
  SlashCommand,
  ThinkingOption,
  TranscriptDisplayObject,
  UploadedFile,
  UserQuestionAnswers,
  UserMessageMetadata,
} from "@yep-anywhere/shared";
import { authEvents } from "../lib/authEvents";
import { getGlobalConnection, isRemoteClient } from "../lib/connection";
import type {
  AgentSession,
  InputRequest,
  Message,
  PermissionMode,
  Project,
  SessionMetadata,
  SessionStatus,
} from "../types";

/** Pagination metadata for compact-boundary-based session loading */
export interface PaginationInfo {
  hasOlderMessages: boolean;
  totalMessageCount: number;
  returnedMessageCount: number;
  truncatedBeforeMessageId?: string;
  totalCompactions: number;
  totalUserTurns?: number;
  truncatedBy?: "compact_boundary" | "user_turn";
}

/**
 * An item in the inbox representing a session that may need attention.
 */
export interface InboxItem {
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle: string | null;
  updatedAt: string;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
}

/**
 * Inbox response with sessions categorized into priority tiers.
 */
export interface InboxResponse {
  needsAttention: InboxItem[];
  active: InboxItem[];
  recentActivity: InboxItem[];
  unread8h: InboxItem[];
  unread24h: InboxItem[];
}

/**
 * An item in the global sessions list.
 */
export interface GlobalSessionItem {
  id: string;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  provider: ProviderName;
  /** Last active model for this session (from JSONL), for list/badge display. */
  model?: string;
  projectId: string;
  projectName: string;
  ownership: SessionStatus;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  /** Parent session when this item is a YA-owned /btw aside. */
  parentSessionId?: string;
  /** Initial prompt text accepted by YA for new-session recovery/copy. */
  initialPrompt?: string;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Capped excerpt of the most recent regular agent turn (hover card). */
  lastAgentText?: string;
}

/** Stats about all sessions (computed during full scan on server) */
export interface GlobalSessionStats {
  totalCount: number;
  unreadCount: number;
  starredCount: number;
  archivedCount: number;
  /** Counts per provider (non-archived only) */
  providerCounts: Partial<Record<ProviderName, number>>;
  /** Counts per executor host (non-archived only, "local" key for sessions without executor) */
  executorCounts: Record<string, number>;
}

export interface DeferredQueueMessage {
  tempId?: string;
  content: string;
  timestamp: string;
  metadata?: UserMessageMetadata;
  attachmentCount?: number;
}

/** Minimal project info for filter dropdowns */
export interface ProjectOption {
  id: string;
  name: string;
}

/**
 * Response from the global sessions API.
 */
export interface GlobalSessionsResponse {
  sessions: GlobalSessionItem[];
  hasMore: boolean;
  /** Global stats computed from all sessions (not just paginated results) */
  stats: GlobalSessionStats;
  /** All projects for filter dropdown */
  projects: ProjectOption[];
}

export interface SessionOptions {
  mode?: PermissionMode;
  /** Model ID (e.g., "sonnet", "opus", "qwen2.5-coder:0.5b") */
  model?: string;
  /** Provider-visible service tier. Omit for provider/default behavior. */
  serviceTier?: string;
  thinking?: ThinkingOption;
  /** Display preference for thinking rows (default/on/off). */
  showThinking?: ShowThinking;
  provider?: ProviderName;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Recap behavior for future away-return triggers in this session. */
  recapMode?: RecapMode;
  /** Prompt suggestion behavior for this session. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** Existing-session resume strategy. */
  resumeMode?: "full" | "compact-first";
}

export type { UploadedFile } from "@yep-anywhere/shared";

const API_BASE = "/api";

/**
 * Desktop auth token read from URL query parameter (?desktop_token=...).
 * When present, sent as X-Desktop-Token header on every API request.
 * The Tauri desktop app passes this token to authenticate the iframe
 * without cookies or sessions — the token is valid for the server's lifetime.
 */
let desktopAuthToken: string | null = null;
if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("desktop_token");
  if (token) {
    desktopAuthToken = token;
    // Strip token from URL to keep it out of history/bookmarks
    params.delete("desktop_token");
    const cleanUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}${window.location.hash}`
      : `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, "", cleanUrl);
  }
}

/** Get the desktop auth token (if running inside Tauri iframe). */
export function getDesktopAuthToken(): string | null {
  return desktopAuthToken;
}

export interface AuthStatus {
  /** Whether auth is enabled in settings */
  enabled: boolean;
  /** Whether user has a valid session (or auth is disabled) */
  authenticated: boolean;
  /** Whether initial account setup is needed */
  setupRequired: boolean;
  /** Whether auth is bypassed by --auth-disable flag (for recovery) */
  disabledByEnv: boolean;
  /** Path to auth.json file (for recovery instructions) */
  authFilePath: string;
  /** Whether the server has a desktop auth token (Tauri app) */
  hasDesktopToken: boolean;
  /** Whether unauthenticated localhost access is allowed */
  localhostOpen: boolean;
}

export async function fetchJSON<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  // Route through global connection in remote mode (SecureConnection)
  const globalConn = getGlobalConnection();
  if (globalConn) {
    return globalConn.fetch<T>(path, options);
  }

  // In remote client mode, we MUST have a SecureConnection
  // If we reach this point, it means authentication hasn't completed yet
  if (isRemoteClient()) {
    throw new Error(
      "Remote client requires SecureConnection - not authenticated",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Yep-Anywhere": "true",
  };
  if (desktopAuthToken) {
    headers["X-Desktop-Token"] = desktopAuthToken;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...headers,
      ...options?.headers,
    },
  });

  if (!res.ok) {
    // Signal login required for 401 errors (but not for auth endpoints themselves)
    if (res.status === 401 && !path.startsWith("/auth/")) {
      console.log("[API] 401 response, signaling login required");
      authEvents.signalLoginRequired();
    }

    // Try to parse error message from response body
    let errorMessage = `API error: ${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) {
        errorMessage = body.error;
      } else if (body.message) {
        errorMessage = body.message;
      }
    } catch {
      // Response body wasn't JSON, use default message
    }

    // Include setup required info in error for auth handling
    const setupRequired = res.headers.get("X-Setup-Required") === "true";
    const error = new Error(errorMessage) as Error & {
      status: number;
      setupRequired?: boolean;
    };
    error.status = res.status;
    if (setupRequired) error.setupRequired = true;
    throw error;
  }

  return res.json();
}

// Re-export upload functions
export {
  buildUploadUrl,
  fileToChunks,
  UploadError,
  uploadChunks,
  uploadFile,
  type UploadOptions,
} from "./upload";

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Best-effort install source for update guidance. Undefined on older servers. */
  installSource?: "npm-global" | "source" | "release-package" | "unknown";
  /** Session resume protocol version supported by server (undefined on older servers). */
  resumeProtocolVersion?: number;
  /** Feature capabilities supported by the server. Undefined on older servers. */
  capabilities?: string[];
  /** Server-routed speech backend ids validated by the server. */
  voiceBackends?: string[];
  /** Configured server-routed speech backends, including validation state. */
  voiceBackendStatuses?: Array<{
    id: string;
    label: string;
    enabled: boolean;
    validationStatus: "pending" | "enabled" | "disabled";
    capabilities?: { streaming?: boolean; smartTurn?: boolean };
    disabledReason?: string;
  }>;
  /** Capability map keyed by server-routed speech backend id. */
  voiceBackendCapabilities?: Record<
    string,
    { streaming?: boolean; smartTurn?: boolean }
  >;
  /** Device bridge availability and update state. Undefined on older servers. */
  deviceBridgeState?:
    | "available"
    | "downloadable"
    | "update-available"
    | "unavailable";
  /** Installed managed bridge binary version when known. */
  deviceBridgeVersion?: string | null;
  /** Latest bridge release version when known. */
  latestDeviceBridgeVersion?: string | null;
  /** Server-learned browser defaults used when local storage has no explicit value. */
  clientDefaults?: ClientDefaults;
}

export interface ServerInfo {
  /** The host/interface the server is bound to (e.g., "127.0.0.1" or "0.0.0.0") */
  host: string;
  /** The port the server is listening on */
  port: number;
  /** Whether the server is bound to all interfaces (0.0.0.0) */
  boundToAllInterfaces: boolean;
  /** Whether the server is localhost-only */
  localhostOnly: boolean;
}

/**
 * One documented startup env var. For set secrets, `value` is a redacted
 * preview produced server-side; the raw secret is never sent to the client.
 */
export interface EnvSettingEntry {
  name: string;
  group: string;
  description: string;
  secret: boolean;
  set: boolean;
  value?: string;
  /** Dynamic, runtime-computed caption (e.g. HOST's active listen addresses). */
  note?: string;
}

export interface EnvSettingsReport {
  entries: EnvSettingEntry[];
}

export interface NetworkInterface {
  /** Interface name (e.g., "eth0", "wlan0") */
  name: string;
  /** IP address */
  address: string;
  /** IPv4 or IPv6 */
  family: "IPv4" | "IPv6";
  /** Whether this is a loopback/internal interface */
  internal: boolean;
  /** Human-readable display name */
  displayName: string;
}

export interface NetworkBindingState {
  localhost: { port: number; overriddenByCli: boolean };
  network: {
    enabled: boolean;
    host: string | null;
    port: number | null;
    overriddenByCli: boolean;
  };
  interfaces: NetworkInterface[];
}

export interface UpdateBindingRequest {
  localhostPort?: number;
  network?: {
    enabled: boolean;
    host?: string;
    port?: number;
  };
}

export interface UpdateBindingResponse {
  success: boolean;
  error?: string;
  redirectUrl?: string;
}

export interface GetVersionOptions {
  /** Bypass the server's routine version cache and refresh from the update service. */
  fresh?: boolean;
}

export const api = {
  // Version API
  getVersion: (options?: GetVersionOptions) =>
    fetchJSON<VersionInfo>(options?.fresh ? "/version?fresh=1" : "/version"),

  // Server info API (host/port binding for Local Access settings)
  getServerInfo: () => fetchJSON<ServerInfo>("/server-info"),

  // Documented startup env vars (read-only; secrets redacted server-side)
  getEnvSettings: () => fetchJSON<EnvSettingsReport>("/env-settings"),

  // Network binding API (runtime port/interface configuration)
  getNetworkBinding: () => fetchJSON<NetworkBindingState>("/network-binding"),

  setNetworkBinding: (request: UpdateBindingRequest) =>
    fetchJSON<UpdateBindingResponse>("/network-binding", {
      method: "PUT",
      body: JSON.stringify(request),
    }),

  disableNetworkBinding: () =>
    fetchJSON<UpdateBindingResponse>("/network-binding", {
      method: "DELETE",
    }),

  // Server admin API
  restartServer: () =>
    fetchJSON<{ ok: boolean; message: string }>("/server/restart", {
      method: "POST",
    }),

  // Provider API
  getProviders: (options?: { refresh?: boolean }) =>
    fetchJSON<{ providers: ProviderInfo[] }>(
      options?.refresh ? "/providers?refresh=1" : "/providers",
      options?.refresh
        ? { headers: { "Cache-Control": "no-cache" } }
        : undefined,
    ),

  getProjects: () => fetchJSON<{ projects: Project[] }>("/projects"),

  /**
   * Add a project by file path.
   * Validates the path exists on disk and returns project info.
   * Supports ~ for home directory and normalizes trailing slashes.
   */
  addProject: (path: string) =>
    fetchJSON<{ project: Project }>("/projects", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  getProject: (projectId: string) =>
    fetchJSON<{ project: Project }>(`/projects/${projectId}`),

  deleteProject: (projectId: string) =>
    fetchJSON<{ removed: boolean; projectId: string; path: string }>(
      `/projects/${projectId}`,
      {
        method: "DELETE",
      },
    ),

  getSession: (
    projectId: string,
    sessionId: string,
    afterMessageId?: string,
    options?: {
      tailCompactions?: number;
      beforeMessageId?: string;
      tailTurns?: number;
      tailFrom?: string;
    },
  ) => {
    const params = new URLSearchParams();
    if (afterMessageId) params.set("afterMessageId", afterMessageId);
    if (options?.tailCompactions !== undefined)
      params.set("tailCompactions", String(options.tailCompactions));
    if (options?.beforeMessageId)
      params.set("beforeMessageId", options.beforeMessageId);
    if (options?.tailTurns !== undefined)
      params.set("tailTurns", String(options.tailTurns));
    if (options?.tailFrom) params.set("tailFrom", options.tailFrom);
    const qs = params.toString();
    return fetchJSON<{
      session: SessionMetadata;
      messages: Message[];
      ownership: SessionStatus;
      pendingInputRequest?: InputRequest | null;
      slashCommands?: SlashCommand[] | null;
      pagination?: PaginationInfo;
    }>(`/projects/${projectId}/sessions/${sessionId}${qs ? `?${qs}` : ""}`);
  },

  /**
   * Get session metadata only (no messages).
   * Lightweight endpoint for refreshing title, status, etc. without re-fetching all messages.
   */
  getSessionMetadata: (projectId: string, sessionId: string) =>
    fetchJSON<SessionMetadataResponse>(
      `/projects/${projectId}/sessions/${sessionId}/metadata`,
    ),

  /**
   * Recompute the hover-card recent-activity excerpt for a non-running session
   * and push it to lists/hovers via a session-updated event. Fire-and-update:
   * the refreshed value arrives through the activity stream, not this response.
   */
  refreshSessionPreview: (projectId: string, sessionId: string) =>
    fetchJSON<{ lastAgentText: string | null }>(
      `/projects/${projectId}/sessions/${sessionId}/refresh-preview`,
      { method: "POST" },
    ),

  /**
   * Get agent session content for lazy-loading completed Tasks.
   * Used to fetch subagent messages on demand when expanding a Task.
   */
  getAgentSession: (projectId: string, sessionId: string, agentId: string) =>
    fetchJSON<AgentSession>(
      `/projects/${projectId}/sessions/${sessionId}/agents/${agentId}`,
    ),

  /**
   * Get mappings of toolUseId → agentId for all agent files.
   * Used to find agent sessions for pending Tasks on page reload.
   */
  getAgentMappings: (projectId: string, sessionId: string) =>
    fetchJSON<{ mappings: Array<{ toolUseId: string; agentId: string }> }>(
      `/projects/${projectId}/sessions/${sessionId}/agents`,
    ),

  startSession: (
    projectId: string,
    message: string,
    options?: SessionOptions,
    attachments?: UploadedFile[],
    clientTimestamp?: number,
    messageMetadata?: UserMessageMetadata,
  ) =>
    fetchJSON<{
      sessionId: string;
      processId: string;
      projectId: string;
      provider?: ProviderName;
      model?: string;
      permissionMode: PermissionMode;
      modeVersion: number;
      serverTimestamp: number;
    }>(`/projects/${projectId}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        message,
        mode: options?.mode,
        model: options?.model,
        serviceTier: options?.serviceTier,
        thinking: options?.thinking,
        showThinking: options?.showThinking,
        provider: options?.provider,
        executor: options?.executor,
        recapMode: options?.recapMode,
        promptSuggestionMode: options?.promptSuggestionMode,
        helperSideModel: options?.helperSideModel,
        attachments,
        clientTimestamp,
        messageMetadata,
      }),
    }),

  /**
   * Create a session without sending an initial message.
   * Use this for two-phase flow: create session, upload files, then send message.
   */
  createSession: (projectId: string, options?: SessionOptions) =>
    fetchJSON<{
      sessionId: string;
      processId: string;
      projectId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
      serverTimestamp: number;
    }>(`/projects/${projectId}/sessions/create`, {
      method: "POST",
      body: JSON.stringify({
        mode: options?.mode,
        model: options?.model,
        serviceTier: options?.serviceTier,
        thinking: options?.thinking,
        showThinking: options?.showThinking,
        provider: options?.provider,
        executor: options?.executor,
        recapMode: options?.recapMode,
        promptSuggestionMode: options?.promptSuggestionMode,
        helperSideModel: options?.helperSideModel,
      }),
    }),

  startDetachedSession: (
    message: string,
    options?: SessionOptions,
    attachments?: UploadedFile[],
    clientTimestamp?: number,
    messageMetadata?: UserMessageMetadata,
  ) =>
    fetchJSON<{
      sessionId: string;
      processId: string;
      projectId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
      serverTimestamp: number;
    }>(`/sessions`, {
      method: "POST",
      body: JSON.stringify({
        message,
        mode: options?.mode,
        model: options?.model,
        serviceTier: options?.serviceTier,
        thinking: options?.thinking,
        showThinking: options?.showThinking,
        provider: options?.provider,
        executor: options?.executor,
        recapMode: options?.recapMode,
        promptSuggestionMode: options?.promptSuggestionMode,
        helperSideModel: options?.helperSideModel,
        attachments,
        clientTimestamp,
        messageMetadata,
      }),
    }),

  createDetachedSession: (options?: SessionOptions) =>
    fetchJSON<{
      sessionId: string;
      processId: string;
      projectId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
      serverTimestamp: number;
    }>(`/sessions/create`, {
      method: "POST",
      body: JSON.stringify({
        mode: options?.mode,
        model: options?.model,
        serviceTier: options?.serviceTier,
        thinking: options?.thinking,
        showThinking: options?.showThinking,
        provider: options?.provider,
        executor: options?.executor,
        recapMode: options?.recapMode,
        promptSuggestionMode: options?.promptSuggestionMode,
        helperSideModel: options?.helperSideModel,
      }),
    }),

  resumeSession: (
    projectId: string,
    sessionId: string,
    message: string,
    options?: SessionOptions,
    attachments?: UploadedFile[],
    tempId?: string,
    clientTimestamp?: number,
    messageMetadata?: UserMessageMetadata,
  ) =>
    fetchJSON<{
      processId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
      serverTimestamp: number;
      resume?: {
        requestedMode: "full" | "compact-first";
        provider?: ProviderName;
        outcome?: "queued" | "started";
        compaction?: { status: string; [key: string]: unknown };
      };
    }>(`/projects/${projectId}/sessions/${sessionId}/resume`, {
      method: "POST",
      body: JSON.stringify({
        message,
        mode: options?.mode,
        model: options?.model,
        serviceTier: options?.serviceTier,
        thinking: options?.thinking,
        showThinking: options?.showThinking,
        provider: options?.provider,
        executor: options?.executor,
        recapMode: options?.recapMode,
        promptSuggestionMode: options?.promptSuggestionMode,
        helperSideModel: options?.helperSideModel,
        resumeMode: options?.resumeMode,
        attachments,
        tempId,
        clientTimestamp,
        messageMetadata,
      }),
    }),

  /**
   * Bring a reaped session's process back live WITHOUT sending a turn, so the
   * client can read live process state (model options) before messaging.
   * With no options the server resumes using the session's persisted
   * provider/model. Idempotent if the session is already owned.
   */
  reactivateSession: (
    projectId: string,
    sessionId: string,
    options?: {
      mode?: PermissionMode;
      model?: string;
      provider?: ProviderName;
      executor?: string;
    },
  ) =>
    fetchJSON<{
      processId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
      serverTimestamp: number;
    }>(`/projects/${projectId}/sessions/${sessionId}/reactivate`, {
      method: "POST",
      body: JSON.stringify({
        mode: options?.mode,
        model: options?.model,
        provider: options?.provider,
        executor: options?.executor,
      }),
    }),

  restartSession: (
    projectId: string,
    sessionId: string,
    options?: SessionOptions & {
      reason?: string;
      /** "handoff" (default) or "fork" (real transcript fork, Claude only). */
      restartMode?: "handoff" | "fork";
      /** Fork slice point (transcript message UUID, inclusive). */
      forkUpToMessageId?: string;
    },
  ) =>
    fetchJSON<{
      sessionId: string;
      processId: string;
      projectId: string;
      provider?: ProviderName;
      title?: string;
      permissionMode: PermissionMode;
      modeVersion: number;
      restartedFrom: string;
      forkUpToMessageId?: string;
      oldProcessId?: string;
      oldProcessInterrupted: boolean;
      oldProcessAbortDeferred: boolean;
      oldProcessAborted: boolean;
    }>(`/projects/${projectId}/sessions/${sessionId}/restart`, {
      method: "POST",
      body: JSON.stringify({
        mode: options?.mode,
        model: options?.model,
        serviceTier: options?.serviceTier,
        thinking: options?.thinking,
        showThinking: options?.showThinking,
        provider: options?.provider,
        executor: options?.executor,
        recapMode: options?.recapMode,
        promptSuggestionMode: options?.promptSuggestionMode,
        helperSideModel: options?.helperSideModel,
        reason: options?.reason,
        restartMode: options?.restartMode,
        forkUpToMessageId: options?.forkUpToMessageId,
      }),
    }),

  /**
   * Fork the provider transcript into a new session without starting a
   * process or sending a message ("fork from here"). The fork opens cold;
   * the next send resumes it normally.
   */
  forkSession: (
    projectId: string,
    sessionId: string,
    options?: { upToMessageId?: string },
  ) =>
    fetchJSON<{
      sessionId: string;
      projectId: string;
      provider?: ProviderName;
      title?: string;
      forkedFrom: string;
      upToMessageId?: string;
    }>(`/projects/${projectId}/sessions/${sessionId}/fork`, {
      method: "POST",
      body: JSON.stringify({ upToMessageId: options?.upToMessageId }),
    }),

  forkSessionWithSummary: (
    projectId: string,
    sessionId: string,
    options: {
      sourceMessageId: string;
      instructions?: string;
      mode?: PermissionMode;
      autoOpenWhenReady?: boolean;
    },
  ) =>
    fetchJSON<{
      displayObject: TranscriptDisplayObject;
    }>(`/projects/${projectId}/sessions/${sessionId}/fork-summary`, {
      method: "POST",
      body: JSON.stringify({
        sourceMessageId: options.sourceMessageId,
        instructions: options.instructions,
        mode: options.mode,
        autoOpenWhenReady: options.autoOpenWhenReady,
      }),
    }),

  proposeSessionRetitle: (
    projectId: string,
    sessionId: string,
    options?: { currentTitle?: string; lengthTarget?: number },
  ) =>
    fetchJSON<{ title: string; generatorSessionId: string }>(
      `/projects/${projectId}/sessions/${sessionId}/retitle`,
      {
        method: "POST",
        body: JSON.stringify({
          currentTitle: options?.currentTitle,
          lengthTarget: options?.lengthTarget,
        }),
      },
    ),

  cancelForkSessionWithSummary: (
    projectId: string,
    sessionId: string,
    objectId: string,
  ) =>
    fetchJSON<{
      transcriptDisplayObjects: TranscriptDisplayObject[];
    }>(
      `/projects/${projectId}/sessions/${sessionId}/fork-summary/${objectId}/cancel`,
      { method: "POST" },
    ),

  updateForkSummaryDisplayObject: (
    projectId: string,
    sessionId: string,
    objectId: string,
    updates: {
      autoOpenWhenReady?: boolean;
      action?: "opened" | "clicked";
    },
  ) =>
    fetchJSON<{
      displayObject: TranscriptDisplayObject;
      transcriptDisplayObjects: TranscriptDisplayObject[];
    }>(
      `/projects/${projectId}/sessions/${sessionId}/fork-summary/${objectId}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
    ),

  queueMessage: (
    sessionId: string,
    message: string,
    mode?: PermissionMode,
    attachments?: UploadedFile[],
    tempId?: string,
    thinking?: ThinkingOption,
    deferred?: boolean,
    clientTimestamp?: number,
    messageMetadata?: UserMessageMetadata,
    serviceTier?: string,
    showThinking?: ShowThinking,
  ) =>
    fetchJSON<{
      queued: boolean;
      compactQueued?: boolean;
      restarted?: boolean;
      processId?: string;
      deferred?: boolean;
      promoted?: boolean;
      position?: number;
      deferredMessages?: DeferredQueueMessage[];
      serverTimestamp: number;
    }>(`/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message,
        mode,
        attachments,
        tempId,
        thinking,
        showThinking,
        serviceTier,
        deferred,
        clientTimestamp,
        messageMetadata,
      }),
    }),

  cancelDeferredMessage: (sessionId: string, tempId: string) =>
    fetchJSON<{ cancelled: boolean }>(
      `/sessions/${sessionId}/deferred/${encodeURIComponent(tempId)}`,
      { method: "DELETE" },
    ),

  abortProcess: (processId: string) =>
    fetchJSON<{ aborted: boolean }>(`/processes/${processId}/abort`, {
      method: "POST",
    }),

  interruptProcess: (processId: string) =>
    fetchJSON<{ interrupted: boolean; supported: boolean; aborted?: boolean }>(
      `/processes/${processId}/interrupt`,
      { method: "POST" },
    ),

  requestRecap: (processId: string, hiddenSinceMs?: number) =>
    fetchJSON<{ supported: boolean; emitted: boolean; reason?: string }>(
      `/processes/${processId}/recap`,
      {
        method: "POST",
        ...(hiddenSinceMs === undefined
          ? {}
          : { body: JSON.stringify({ hiddenSinceMs }) }),
      },
    ),

  setProcessRecapConfig: (
    processId: string,
    config: { recapMode?: RecapMode; helperSideModel?: string },
  ) =>
    fetchJSON<{
      success: boolean;
      processId: string;
      recapMode: RecapMode;
      helperSideModel: string;
    }>(`/processes/${processId}/recap-config`, {
      method: "POST",
      body: JSON.stringify(config),
    }),

  getProcessModels: (processId: string) =>
    fetchJSON<{
      models: ModelInfo[];
    }>(`/processes/${processId}/models`),

  setProcessModel: (processId: string, model?: string) =>
    fetchJSON<{ success: boolean; processId: string; model?: string }>(
      `/processes/${processId}/model`,
      { method: "POST", body: JSON.stringify({ model }) },
    ),

  setProcessConfig: (
    processId: string,
    config: {
      model?: string;
      thinking?: ThinkingOption;
      showThinking?: ShowThinking;
    },
  ) =>
    fetchJSON<{
      success: boolean;
      processId: string;
      model?: string;
      thinking?: { type: string };
      effort?: string;
    }>(`/processes/${processId}/config`, {
      method: "POST",
      body: JSON.stringify(config),
    }),

  respondToInput: (
    sessionId: string,
    requestId: string,
    response: "approve" | "approve_accept_edits" | "deny",
    answers?: UserQuestionAnswers,
    feedback?: string,
  ) =>
    fetchJSON<{ accepted: boolean; pendingInputRequest?: InputRequest | null }>(
      `/sessions/${sessionId}/input`,
      {
        method: "POST",
        body: JSON.stringify({ requestId, response, answers, feedback }),
      },
    ),

  getPendingInputRequest: (sessionId: string) =>
    fetchJSON<{ request: InputRequest | null }>(
      `/sessions/${sessionId}/pending-input`,
    ),

  setPermissionMode: (sessionId: string, mode: PermissionMode) =>
    fetchJSON<{ permissionMode: PermissionMode; modeVersion: number }>(
      `/sessions/${sessionId}/mode`,
      { method: "PUT", body: JSON.stringify({ mode }) },
    ),

  getProcessInfo: (sessionId: string) =>
    fetchJSON<{
      process: {
        id: string;
        sessionId: string;
        projectId: string;
        projectPath: string;
        projectName: string;
        sessionTitle: string | null;
        state: string;
        startedAt: string;
        queueDepth: number;
        idleSince?: string;
        terminationReason?: string;
        terminatedAt?: string;
        provider: ProviderName;
        thinking?: { type: string };
        effort?: string;
        model?: string;
        /** YA model id (launch alias) for keying per-model settings. */
        requestedModel?: string;
        liveness?: SessionLivenessSnapshot;
        recapMode?: RecapMode;
        promptSuggestionMode?: PromptSuggestionMode;
        helperSideModel?: string;
      } | null;
    }>(`/sessions/${sessionId}/process`),

  markSessionSeen: (
    sessionId: string,
    timestamp?: string,
    messageId?: string,
  ) =>
    fetchJSON<{ marked: boolean }>(`/sessions/${sessionId}/mark-seen`, {
      method: "POST",
      body: JSON.stringify({ timestamp, messageId }),
    }),

  markSessionUnread: (sessionId: string) =>
    fetchJSON<{ marked: boolean }>(`/sessions/${sessionId}/mark-seen`, {
      method: "DELETE",
    }),

  getLastSeen: () =>
    fetchJSON<{
      lastSeen: Record<string, { timestamp: string; messageId?: string }>;
    }>("/notifications/last-seen"),

  updateSessionMetadata: (
    sessionId: string,
    updates: {
      title?: string;
      archived?: boolean;
      starred?: boolean;
      parentSessionId?: string | null;
      heartbeatTurnsEnabled?: boolean;
      heartbeatTurnsAfterMinutes?: number | null;
      heartbeatTurnText?: string | null;
      heartbeatForceAfterMinutes?: number | null;
      promptSuggestionMode?: PromptSuggestionMode | null;
    },
  ) =>
    fetchJSON<{ updated: boolean }>(`/sessions/${sessionId}/metadata`, {
      method: "PUT",
      body: JSON.stringify(updates),
    }),

  /**
   * Clone a session, creating a new session with the same conversation history.
   * Supported for Claude and Codex sessions.
   */
  cloneSession: (
    projectId: string,
    sessionId: string,
    title?: string,
    provider?: string,
    parentSessionId?: string,
  ) =>
    fetchJSON<{
      sessionId: string;
      messageCount: number;
      clonedFrom: string;
      provider: string;
    }>(`/projects/${projectId}/sessions/${sessionId}/clone`, {
      method: "POST",
      body: JSON.stringify({ title, provider, parentSessionId }),
    }),

  // Push notification API
  getPushPublicKey: () =>
    fetchJSON<{ publicKey: string }>("/push/vapid-public-key"),

  subscribePush: (
    browserProfileId: string,
    subscription: PushSubscriptionJSON,
    deviceName?: string,
  ) =>
    fetchJSON<{ success: boolean; browserProfileId: string }>(
      "/push/subscribe",
      {
        method: "POST",
        body: JSON.stringify({ browserProfileId, subscription, deviceName }),
      },
    ),

  unsubscribePush: (browserProfileId: string) =>
    fetchJSON<{ success: boolean; browserProfileId: string }>(
      "/push/unsubscribe",
      {
        method: "POST",
        body: JSON.stringify({ browserProfileId }),
      },
    ),

  getPushSubscriptions: () =>
    fetchJSON<{
      count: number;
      subscriptions: Array<{
        browserProfileId: string;
        createdAt: string;
        deviceName?: string;
        endpointDomain: string;
        deviceType: "android" | "ios" | "mobile" | "desktop" | "unknown";
      }>;
    }>("/push/subscriptions"),

  testPush: (
    browserProfileId: string,
    message?: string,
    urgency?: "normal" | "persistent" | "silent",
    deliveryUrgency?: "very-low" | "low" | "normal" | "high",
  ) =>
    fetchJSON<{ success: boolean }>("/push/test", {
      method: "POST",
      body: JSON.stringify({
        browserProfileId,
        message,
        urgency,
        deliveryUrgency,
      }),
    }),

  deletePushSubscription: (browserProfileId: string) =>
    fetchJSON<{ success: boolean }>(
      `/push/subscriptions/${encodeURIComponent(browserProfileId)}`,
      { method: "DELETE" },
    ),

  // Connected devices API
  getConnections: () => fetchJSON<ConnectionsResponse>("/connections"),

  getNotificationSettings: () =>
    fetchJSON<{
      settings: {
        toolApproval: boolean;
        userQuestion: boolean;
        sessionHalted: boolean;
      };
    }>("/push/settings"),

  updateNotificationSettings: (
    settings: Partial<{
      toolApproval: boolean;
      userQuestion: boolean;
      sessionHalted: boolean;
    }>,
  ) =>
    fetchJSON<{
      settings: {
        toolApproval: boolean;
        userQuestion: boolean;
        sessionHalted: boolean;
      };
    }>("/push/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),

  // File API
  getFile: (
    projectId: string,
    path: string,
    highlight = false,
    lineNumber?: number,
    lineEnd?: number,
    viewMode?: "full" | "range",
  ) => {
    const params = new URLSearchParams({ path });
    if (highlight) params.set("highlight", "true");
    if (lineNumber !== undefined) params.set("line", String(lineNumber));
    if (lineEnd !== undefined) params.set("lineEnd", String(lineEnd));
    if (viewMode === "range") params.set("view", "range");
    return fetchJSON<FileContentResponse>(
      `/projects/${projectId}/files?${params.toString()}`,
    );
  },

  getFileRawUrl: (projectId: string, path: string, download = false) => {
    const params = new URLSearchParams({ path });
    if (download) params.set("download", "true");
    return `/api/projects/${projectId}/files/raw?${params.toString()}`;
  },

  /**
   * Expand diff context to show full file.
   * Returns syntax-highlighted diff with the entire file as context.
   * Uses originalFile from SDK Edit result (never truncated, verified up to 150KB+).
   */
  expandDiffContext: (
    projectId: string,
    filePath: string,
    oldString: string,
    newString: string,
    originalFile: string,
  ) =>
    fetchJSON<{
      structuredPatch: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
      }>;
      diffHtml: string;
    }>(`/projects/${projectId}/diff/expand`, {
      method: "POST",
      body: JSON.stringify({ filePath, oldString, newString, originalFile }),
    }),

  // Git status API
  getGitStatus: (projectId: string) =>
    fetchJSON<GitStatusInfo>(`/projects/${projectId}/git`),

  getGitDiff: (
    projectId: string,
    params: {
      path: string;
      staged: boolean;
      status: string;
      fullContext?: boolean;
    },
  ) =>
    fetchJSON<{
      diffHtml: string;
      structuredPatch: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
      }>;
      markdownHtml?: string;
    }>(`/projects/${projectId}/git/diff`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  // Inbox API
  getInbox: (projectId?: string) =>
    fetchJSON<InboxResponse>(
      projectId
        ? `/inbox?projectId=${encodeURIComponent(projectId)}`
        : "/inbox",
    ),

  // Global Sessions API
  getGlobalSessions: (params?: {
    project?: string;
    q?: string;
    after?: string;
    limit?: number;
    includeArchived?: boolean;
    starred?: boolean;
    includeStats?: boolean;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.project) searchParams.set("project", params.project);
    if (params?.q) searchParams.set("q", params.q);
    if (params?.after) searchParams.set("after", params.after);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.includeArchived) searchParams.set("includeArchived", "true");
    if (params?.starred) searchParams.set("starred", "true");
    if (params?.includeStats) searchParams.set("includeStats", "true");
    const query = searchParams.toString();
    return fetchJSON<GlobalSessionsResponse>(
      query ? `/sessions?${query}` : "/sessions",
    );
  },
  getGlobalSessionStats: () =>
    fetchJSON<{
      stats: GlobalSessionStats;
    }>("/sessions/stats"),

  // Auth API
  getAuthStatus: () => fetchJSON<AuthStatus>("/auth/status"),

  /** Enable auth with a password (fresh setup while auth is currently disabled) */
  enableAuth: (password: string) =>
    fetchJSON<{ success: boolean }>("/auth/enable", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  /** Disable auth (requires authenticated session) */
  disableAuth: () =>
    fetchJSON<{ success: boolean }>("/auth/disable", {
      method: "POST",
    }),

  /** @deprecated Use enableAuth instead */
  setupAccount: (password: string) =>
    fetchJSON<{ success: boolean }>("/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  login: (password: string) =>
    fetchJSON<{ success: boolean }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  logout: () =>
    fetchJSON<{ success: boolean }>("/auth/logout", {
      method: "POST",
    }),

  changePassword: (newPassword: string) =>
    fetchJSON<{ success: boolean }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    }),

  /** Toggle unauthenticated localhost access (desktop token floor bypass) */
  setLocalhostAccess: (open: boolean) =>
    fetchJSON<{ success: boolean; localhostOpen: boolean }>(
      "/auth/localhost-access",
      {
        method: "POST",
        body: JSON.stringify({ open }),
      },
    ),

  // Recents API
  getRecents: (limit?: number) =>
    fetchJSON<{
      recents: Array<EnrichedRecentEntry>;
    }>(limit ? `/recents?limit=${limit}` : "/recents"),

  recordVisit: (sessionId: string, projectId: string) =>
    fetchJSON<{ recorded: boolean }>("/recents/visit", {
      method: "POST",
      body: JSON.stringify({ sessionId, projectId }),
    }),

  clearRecents: () =>
    fetchJSON<{ cleared: boolean }>("/recents", {
      method: "DELETE",
    }),

  // Onboarding API (first-run wizard state)
  getOnboardingStatus: () => fetchJSON<{ complete: boolean }>("/onboarding"),

  completeOnboarding: () =>
    fetchJSON<{ success: boolean }>("/onboarding/complete", {
      method: "POST",
    }),

  resetOnboarding: () =>
    fetchJSON<{ success: boolean }>("/onboarding/reset", {
      method: "POST",
    }),

  // Browser profiles API (device origin tracking)
  getBrowserProfiles: () =>
    fetchJSON<BrowserProfilesResponse>("/browser-profiles"),

  deleteBrowserProfile: (browserProfileId: string) =>
    fetchJSON<{ deleted: boolean }>(
      `/browser-profiles/${encodeURIComponent(browserProfileId)}`,
      { method: "DELETE" },
    ),

  // Server settings API (persistent server configuration)
  getServerSettings: () => fetchJSON<{ settings: ServerSettings }>("/settings"),

  updateServerSettings: (settings: Partial<ServerSettings>) =>
    fetchJSON<{ settings: ServerSettings }>("/settings", {
      method: "PUT",
      body: JSON.stringify(
        settings,
        // Preserve explicit clears for optional settings. The server treats null
        // and empty string as "clear this value", but plain JSON drops undefined keys.
        (_key, value) => (value === undefined ? null : value),
      ),
    }),

  // Read-only file-access info (env-pin state + resolved hint paths)
  getFileAccessInfo: () => fetchJSON<FileAccessInfo>("/settings/file-access"),

  discoverHelperTargetModels: (baseUrl: string) =>
    fetchJSON<{ baseUrl: string; models: ModelInfo[] }>(
      "/settings/helper-targets/models",
      {
        method: "POST",
        body: JSON.stringify({ baseUrl }),
      },
    ),

  // Codex CLI update checker
  getCodexUpdateStatus: (force?: boolean) =>
    fetchJSON<{ status: CodexUpdateStatus }>(
      `/codex/updates${force ? "?force=true" : ""}`,
    ),

  installCodexUpdate: () =>
    fetchJSON<{
      success: boolean;
      output: string;
      status: CodexUpdateStatus;
      error?: string;
    }>("/codex/updates/install", { method: "POST" }),

  // Remote executors API
  getRemoteExecutors: () =>
    fetchJSON<{ executors: string[] }>("/settings/remote-executors"),

  updateRemoteExecutors: (executors: string[]) =>
    fetchJSON<{ executors: string[] }>("/settings/remote-executors", {
      method: "PUT",
      body: JSON.stringify({ executors }),
    }),

  testRemoteExecutor: (host: string) =>
    fetchJSON<RemoteExecutorTestResult>(
      `/settings/remote-executors/${encodeURIComponent(host)}/test`,
      { method: "POST" },
    ),

  // Sharing API
  getSharingStatus: () => fetchJSON<{ configured: boolean }>("/sharing/status"),

  shareSession: (html: string, title?: string) =>
    fetchJSON<{ url: string }>("/sharing/upload", {
      method: "POST",
      body: JSON.stringify({ html, title }),
    }),

  getPublicShareStatus: () =>
    fetchJSON<PublicShareStatusResponse>("/public-shares/status"),

  getPublicSessionShareStatus: (projectId: string, sessionId: string) =>
    fetchJSON<PublicSessionShareSessionStatusResponse>(
      `/public-shares/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`,
    ),

  createPublicSessionShare: (body: CreatePublicSessionShareRequest) =>
    fetchJSON<CreatePublicSessionShareResponse>("/public-shares", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  revokePublicSessionShares: (projectId: string, sessionId: string) =>
    fetchJSON<RevokePublicSessionSharesResponse>(
      `/public-shares/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),

  freezePublicSessionLiveShares: (projectId: string, sessionId: string) =>
    fetchJSON<FreezePublicSessionLiveSharesResponse>(
      `/public-shares/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/freeze-live`,
      { method: "POST" },
    ),

  freezePublicSessionViewerToken: (
    projectId: string,
    sessionId: string,
    viewerId: string,
  ) =>
    fetchJSON<PublicSessionShareViewerActionResponse>(
      `/public-shares/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/viewers/${encodeURIComponent(viewerId)}/freeze`,
      { method: "POST" },
    ),

  disconnectPublicSessionViewerToken: (
    projectId: string,
    sessionId: string,
    viewerId: string,
  ) =>
    fetchJSON<PublicSessionShareViewerActionResponse>(
      `/public-shares/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/viewers/${encodeURIComponent(viewerId)}`,
      { method: "DELETE" },
    ),

  // Device bridge API
  getDevices: () => fetchJSON<DeviceInfo[]>("/devices"),

  startDevice: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/start`, {
      method: "POST",
    }),

  stopDevice: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/stop`, {
      method: "POST",
    }),

  downloadDeviceBridge: () =>
    fetchJSON<{
      ok: boolean;
      path?: string;
      binaryPath?: string;
      apkPath?: string;
      error?: string;
    }>("/devices/bridge/download", { method: "POST" }),

  // Legacy aliases (kept while UI naming is still emulator-centric)
  getEmulators: () => fetchJSON<DeviceInfo[]>("/devices"),

  startEmulator: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/start`, {
      method: "POST",
    }),

  stopEmulator: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/stop`, {
      method: "POST",
    }),

  downloadEmulatorBridge: () =>
    fetchJSON<{
      ok: boolean;
      path?: string;
      binaryPath?: string;
      apkPath?: string;
      error?: string;
    }>("/devices/bridge/download", { method: "POST" }),
};

/** Result of testing an SSH connection to a remote executor */
export interface RemoteExecutorTestResult {
  success: boolean;
  error?: string;
  /** SSH host that was tested */
  host?: string;
  /** Remote home directory */
  homeDir?: string;
  /** Whether Claude CLI is available on remote */
  claudeAvailable?: boolean;
  /** Claude CLI version on remote (e.g. "1.0.12") */
  claudeVersion?: string;
}

/**
 * Which local path prefixes the HTTP file doors (media + project-files routes)
 * may read. See docs/tactical/018-file-access-scoping.md.
 */
export interface FileAccessSettings {
  /** All scanned project paths. */
  projects: boolean;
  /** The managed uploads directory. */
  uploads: boolean;
  /** Per-OS temp prefixes. */
  temp: boolean;
  /** The home directory. */
  home: boolean;
  /** Literal absolute prefixes, one per entry (`~` expanded server-side). */
  custom: string[];
}

/** Read-only file-access info from the server (for UI hints + env-pin state). */
export interface FileAccessInfo {
  /** True when ALLOWED_FILE_PATHS/ALLOWED_IMAGE_PATHS pins the set (UI read-only). */
  envPinned: boolean;
  /** The env-pinned prefixes (only meaningful when envPinned). */
  envPaths: string[];
  /** Resolved temp prefixes the "Temp folders" toggle expands to. */
  tempPaths: string[];
  /** Managed uploads directory. */
  uploadsDir: string;
  /** Home directory. */
  homeDir: string;
}

/** Default file-access settings (secure-by-default; mirrors the server). */
export const DEFAULT_FILE_ACCESS: FileAccessSettings = {
  projects: true,
  uploads: true,
  temp: true,
  home: false,
  custom: [],
};

/** Server-wide settings that persist across restarts */
export interface ServerSettings {
  /** Whether clients should register the service worker */
  serviceWorkerEnabled: boolean;
  /** Whether remote SRP resume sessions should be persisted to disk */
  persistRemoteSessionsToDisk: boolean;
  /** Whether the server is requesting browser clients to upload diagnostic logs */
  clientLogCollectionRequested?: boolean;
  /** Whether users may create public read-only share links */
  publicSharesEnabled?: boolean;
  /** Base URL for the hosted YA client */
  yaClientBaseUrl?: string | null;
  /** @deprecated Use yaClientBaseUrl. */
  publicShareViewerBaseUrl?: string | null;
  /** SSH host aliases for remote executors */
  remoteExecutors?: string[];
  /** SSH host aliases for ChromeOS device bridge targets */
  chromeOsHosts?: string[];
  /** Allowed hostnames for host/origin validation. "*" = allow all, comma-separated = specific hosts. */
  allowedHosts?: string;
  /** Which local path prefixes the HTTP file doors may read. Undefined = secure defaults. */
  fileAccess?: FileAccessSettings;
  /** Free-form instructions appended to the system prompt for all sessions */
  globalInstructions?: string;
  /** Optional additive context hints composed with global instructions */
  agentContextHints?: AgentContextHints;
  /** Default idle minutes before an opted-in session queues a heartbeat turn */
  heartbeatTurnsAfterMinutes?: number;
  /** Default text queued as the synthetic heartbeat user turn */
  heartbeatTurnText?: string;
  /** Ollama server URL for claude-ollama provider */
  ollamaUrl?: string;
  /** Custom system prompt for Ollama provider */
  ollamaSystemPrompt?: string;
  /** Whether to use the full Claude system prompt for Ollama */
  ollamaUseFullSystemPrompt?: boolean;
  /** Whether Grok Build may receive the server's XAI_API_KEY */
  grokBuildUseXaiApiKey?: boolean;
  /** Whether the device bridge (emulator/device streaming) feature is enabled */
  deviceBridgeEnabled?: boolean;
  /** Defaults applied when opening the new session form */
  newSessionDefaults?: NewSessionDefaults;
  /** Provider-scoped prompt-cache keepalive settings */
  promptCacheKeepalive?: PromptCacheKeepaliveSettings;
  /** Browser-client defaults used when local storage has no explicit value */
  clientDefaults?: ClientDefaults;
  /** Server-routed speech audio retention policy */
  speechAudioRetention?: {
    enabled: boolean;
    maxAgeDays: number;
    maxBytes: number;
  };
  /** OpenAI-compatible helper endpoints for side-session helper work */
  helperTargets?: HelperTargetConfig[];
  /** Whether lifecycle webhook delivery is enabled */
  lifecycleWebhooksEnabled?: boolean;
  /** External webhook URL that receives lifecycle events */
  lifecycleWebhookUrl?: string;
  /** Optional bearer token used for lifecycle webhook delivery */
  lifecycleWebhookToken?: string;
  /** When true, include dryRun=true in lifecycle webhook payloads */
  lifecycleWebhookDryRun?: boolean;
  /** How the server handles Codex CLI updates */
  codexUpdatePolicy?: "auto" | "notify" | "off";
  /** Max seconds between consecutive queued turns to join at delivery. */
  deferredJoinWindowSeconds?: number;
  /** Whether delivered queued turns receive compose-time staleness anchors. */
  composeAnchorsEnabled?: boolean;
}

export type RelayClientStatus =
  | "disconnected"
  | "connecting"
  | "registering"
  | "waiting"
  | "rejected";

export interface PublicShareStatusResponse {
  enabled: boolean;
  configured: boolean;
  requiresRelay: boolean;
  remoteAccessEnabled: boolean;
  relayStatus: RelayClientStatus | null;
  relayUrl?: string | null;
  relayUsername?: string | null;
  canCreate: boolean;
  yaClientBaseUrl: string | null;
  defaultYaClientBaseUrl: string;
  yaClientBaseUrlError?: string;
  viewerBaseUrl: string | null;
  defaultViewerBaseUrl: string;
  viewerBaseUrlError?: string;
}

/** Status from the server's Codex CLI update checker */
export interface CodexUpdateStatus {
  installed: string | null;
  installedPath: string | null;
  installedPackage: string | null;
  updateMethod: "npm" | "manual";
  manualInstallCommand: string | null;
  latest: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  lastCheckedAt: number | null;
  error: string | null;
}
