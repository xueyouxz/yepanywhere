import type { SessionLivenessSnapshot } from "@yep-anywhere/shared";
import type { RenderItem } from "../types/renderItems";

export type SessionActivityOwner = "self" | "external" | "none";
export type SessionActivityProcessState = "idle" | "in-turn" | "waiting-input";

interface SessionActivityUiInput {
  owner: SessionActivityOwner;
  processState: SessionActivityProcessState;
  items: RenderItem[];
  sessionLiveness?: SessionLivenessSnapshot | null;
  hasSessionUpdateStream?: boolean;
  sessionUpdatesConnected?: boolean;
}

export interface SessionActivityUiState {
  hasPendingToolCalls: boolean;
  hasPendingToolCallsInLatestTurn: boolean;
  /** Tip-most pending tool_use in the latest turn (id, name, input), if any. */
  pendingToolCallInLatestTurn: {
    id: string;
    toolName: string;
    toolInput: unknown;
  } | null;
  latestTurnSettled: boolean;
  canStopOwnedProcess: boolean;
  shouldDeferMessages: boolean;
  showProcessingIndicator: boolean;
  shouldSuppressCurrentTurnOrphans: boolean;
}

function latestTurnStartIndex(items: RenderItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "user_prompt" || item?.type === "session_setup") {
      return index;
    }
  }
  return -1;
}

function latestSubstantiveItem(items: RenderItem[]): RenderItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    if (item.type === "system" && item.subtype === "config_ack") {
      continue;
    }
    return item;
  }
  return undefined;
}

function isTerminalAssistantItem(item: RenderItem | undefined): boolean {
  if (!item) {
    return false;
  }
  if (item.type === "text") {
    return item.isStreaming !== true;
  }
  if (item.type === "system") {
    return item.subtype === "turn_aborted" || item.subtype === "error";
  }
  return false;
}

export function getSessionActivityUiState({
  owner,
  processState,
  items,
  sessionLiveness = null,
  hasSessionUpdateStream = false,
  sessionUpdatesConnected = true,
}: SessionActivityUiInput): SessionActivityUiState {
  const turnStartIndex = latestTurnStartIndex(items);
  const latestTurnItems =
    turnStartIndex >= 0 ? items.slice(turnStartIndex + 1) : items;
  const hasPendingToolCalls = items.some(
    (item) => item.type === "tool_call" && item.status === "pending",
  );
  const hasPendingToolCallsInLatestTurn = latestTurnItems.some(
    (item) => item.type === "tool_call" && item.status === "pending",
  );
  // The dangling tool call the "waiting elsewhere" banner is about: the
  // tip-most pending tool_use in the latest turn. Used to name the tool and to
  // re-arm a per-tool dismissal when a *different* call goes pending.
  let pendingToolCallInLatestTurn: SessionActivityUiState["pendingToolCallInLatestTurn"] =
    null;
  for (let index = latestTurnItems.length - 1; index >= 0; index -= 1) {
    const item = latestTurnItems[index];
    if (item?.type === "tool_call" && item.status === "pending") {
      pendingToolCallInLatestTurn = {
        id: item.id,
        toolName: item.toolName,
        toolInput: item.toolInput,
      };
      break;
    }
  }
  const latestTurnSettled = isTerminalAssistantItem(
    latestSubstantiveItem(latestTurnItems),
  );

  const ownsTurn = owner === "self";
  const providerRetained =
    sessionLiveness?.derivedStatus === "verified-waiting-provider";
  const staleStreamMayHideCurrentTurn =
    hasSessionUpdateStream && !sessionUpdatesConnected;
  const processStateIsActive = processState !== "idle" || providerRetained;
  const latestTurnFallbackActive =
    !latestTurnSettled &&
    (hasPendingToolCallsInLatestTurn || staleStreamMayHideCurrentTurn);
  const latestTurnMayStillBeActive =
    ownsTurn && (processStateIsActive || latestTurnFallbackActive);
  const canStopOwnedProcess =
    ownsTurn &&
    (processState === "in-turn" ||
      providerRetained ||
      (!latestTurnSettled && hasPendingToolCallsInLatestTurn));

  return {
    hasPendingToolCalls,
    hasPendingToolCallsInLatestTurn,
    pendingToolCallInLatestTurn,
    latestTurnSettled,
    canStopOwnedProcess,
    shouldDeferMessages: latestTurnMayStillBeActive,
    showProcessingIndicator: canStopOwnedProcess,
    shouldSuppressCurrentTurnOrphans:
      latestTurnMayStillBeActive &&
      (processState === "in-turn" ||
        processState === "waiting-input" ||
        providerRetained ||
        latestTurnFallbackActive),
  };
}
