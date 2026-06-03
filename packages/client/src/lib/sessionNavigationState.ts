import {
  ALL_PERMISSION_MODES,
  ALL_PROVIDERS,
  type PermissionMode,
  type ProviderName,
} from "@yep-anywhere/shared";

export interface InitialSessionStatus {
  owner: "self";
  processId: string;
  permissionMode?: PermissionMode;
  modeVersion?: number;
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

function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (ALL_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

function normalizeModeVersion(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

export function normalizeInitialSessionStatus(
  value: unknown,
): InitialSessionStatus | undefined {
  if (!isRecord(value) || typeof value.processId !== "string") {
    return undefined;
  }

  if (value.owner !== "self" && value.state !== "owned") {
    return undefined;
  }

  const modeVersion = normalizeModeVersion(value.modeVersion);
  return {
    owner: "self",
    processId: value.processId,
    ...(isPermissionMode(value.permissionMode)
      ? { permissionMode: value.permissionMode }
      : {}),
    ...(modeVersion !== undefined ? { modeVersion } : {}),
  };
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
