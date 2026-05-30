import type { RenderItem } from "../types/renderItems";

export type SessionActivityOwner = "self" | "external" | "none";
export type SessionActivityProcessState =
  | "idle"
  | "in-turn"
  | "waiting-input"
  | "hold";

interface SessionActivityUiInput {
  owner: SessionActivityOwner;
  processState: SessionActivityProcessState;
  items: RenderItem[];
  hasSessionUpdateStream?: boolean;
  sessionUpdatesConnected?: boolean;
}

export interface SessionActivityUiState {
  hasPendingToolCalls: boolean;
  hasPendingToolCallsInLatestTurn: boolean;
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
  const latestTurnSettled = isTerminalAssistantItem(
    latestSubstantiveItem(latestTurnItems),
  );

  const ownsTurn = owner === "self";
  const staleStreamMayHideCurrentTurn =
    hasSessionUpdateStream && !sessionUpdatesConnected;
  const latestTurnMayStillBeActive =
    ownsTurn &&
    !latestTurnSettled &&
    (processState !== "idle" ||
      hasPendingToolCallsInLatestTurn ||
      staleStreamMayHideCurrentTurn);
  const canStopOwnedProcess =
    ownsTurn &&
    !latestTurnSettled &&
    (processState === "in-turn" || hasPendingToolCallsInLatestTurn);

  return {
    hasPendingToolCalls,
    hasPendingToolCallsInLatestTurn,
    latestTurnSettled,
    canStopOwnedProcess,
    shouldDeferMessages: latestTurnMayStillBeActive,
    showProcessingIndicator: canStopOwnedProcess,
    shouldSuppressCurrentTurnOrphans:
      latestTurnMayStillBeActive &&
      (processState === "in-turn" ||
        processState === "waiting-input" ||
        hasPendingToolCallsInLatestTurn ||
        staleStreamMayHideCurrentTurn),
  };
}
