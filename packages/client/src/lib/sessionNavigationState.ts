import { ALL_PROVIDERS, type ProviderName } from "@yep-anywhere/shared";

export interface InitialSessionStatus {
  owner: "self";
  processId: string;
}

export interface SessionNavigationState {
  initialStatus?: InitialSessionStatus;
  initialTitle?: string;
  initialModel?: string;
  initialProvider?: ProviderName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isProviderName(value: unknown): value is ProviderName {
  return (
    typeof value === "string" &&
    (ALL_PROVIDERS as readonly string[]).includes(value)
  );
}

export function normalizeInitialSessionStatus(
  value: unknown,
): InitialSessionStatus | undefined {
  if (!isRecord(value) || typeof value.processId !== "string") {
    return undefined;
  }

  if (value.owner === "self") {
    return { owner: "self", processId: value.processId };
  }

  // Older navigation state used state:"owned"; browser history can preserve it.
  if (value.state === "owned") {
    return { owner: "self", processId: value.processId };
  }

  return undefined;
}

export function parseSessionNavigationState(
  value: unknown,
): SessionNavigationState {
  if (!isRecord(value)) {
    return {};
  }

  const initialStatus = normalizeInitialSessionStatus(value.initialStatus);
  return {
    ...(initialStatus ? { initialStatus } : {}),
    ...(typeof value.initialTitle === "string"
      ? { initialTitle: value.initialTitle }
      : {}),
    ...(typeof value.initialModel === "string"
      ? { initialModel: value.initialModel }
      : {}),
    ...(isProviderName(value.initialProvider)
      ? { initialProvider: value.initialProvider }
      : {}),
  };
}

export function createSessionNavigationState(
  state: SessionNavigationState,
): SessionNavigationState {
  return {
    ...(state.initialStatus ? { initialStatus: state.initialStatus } : {}),
    ...(state.initialTitle ? { initialTitle: state.initialTitle } : {}),
    ...(state.initialModel ? { initialModel: state.initialModel } : {}),
    ...(state.initialProvider ? { initialProvider: state.initialProvider } : {}),
  };
}
