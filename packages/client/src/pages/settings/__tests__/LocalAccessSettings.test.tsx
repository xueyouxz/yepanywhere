// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileAccessInfo, ServerSettings } from "../../../api/client";
import { LocalAccessSettings } from "../LocalAccessSettings";

const {
  hookState,
  mockDisconnect,
  mockGetFileAccessInfo,
  mockSetRelayDebugEnabled,
  mockUpdateSettings,
  remoteState,
} = vi.hoisted(() => ({
  hookState: {
    settings: null as ServerSettings | null,
    isLoading: false,
    error: null as string | null,
  },
  mockDisconnect: vi.fn(),
  mockGetFileAccessInfo: vi.fn(),
  mockSetRelayDebugEnabled: vi.fn(),
  mockUpdateSettings: vi.fn(),
  remoteState: {
    connection: null as null | { disconnect: () => void },
  },
}));

vi.mock("../../../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../../../api/client")>(
      "../../../api/client",
    );
  return {
    ...actual,
    api: {
      ...actual.api,
      getFileAccessInfo: mockGetFileAccessInfo,
    },
  };
});

vi.mock("../../../contexts/AuthContext", () => ({
  useOptionalAuth: () => null,
}));

vi.mock("../../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => remoteState.connection,
}));

vi.mock("../../../hooks/useDeveloperMode", () => ({
  useDeveloperMode: () => ({
    relayDebugEnabled: false,
    setRelayDebugEnabled: mockSetRelayDebugEnabled,
  }),
}));

vi.mock("../../../hooks/useNetworkBinding", () => ({
  useNetworkBinding: () => ({
    binding: null,
    loading: false,
    applying: false,
    updateBinding: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useServerInfo", () => ({
  useServerInfo: () => ({
    serverInfo: null,
    loading: false,
  }),
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    ...hookState,
    updateSetting: vi.fn(),
    updateSettings: mockUpdateSettings,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const fileAccessInfo: FileAccessInfo = {
  envPinned: false,
  envPaths: [],
  tempPaths: ["/tmp"],
  uploadsDir: "/uploads",
  homeDir: "/home/alice",
};

const baseSettings: ServerSettings = {
  serviceWorkerEnabled: true,
  persistRemoteSessionsToDisk: false,
  fileAccess: {
    projects: true,
    uploads: true,
    temp: true,
    home: false,
    custom: [],
  },
};

function checkboxFor(labelKey: string): HTMLInputElement {
  const item = screen.getByText(labelKey).closest(".settings-item");
  const checkbox = item?.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!checkbox) {
    throw new Error(`Missing checkbox for ${labelKey}`);
  }
  return checkbox;
}

describe("LocalAccessSettings", () => {
  beforeEach(() => {
    hookState.settings = { ...baseSettings };
    hookState.isLoading = false;
    hookState.error = null;
    remoteState.connection = { disconnect: mockDisconnect };
    mockGetFileAccessInfo.mockResolvedValue(fileAccessInfo);
    mockUpdateSettings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    remoteState.connection = null;
  });

  it("shows file access controls in relay mode without direct port controls", async () => {
    render(<LocalAccessSettings />);

    expect(await screen.findByText("fileAccessTitle")).toBeTruthy();
    expect(screen.getByText("fileAccessHome")).toBeTruthy();
    expect(screen.getByText("localAccessRelayDebugTitle")).toBeTruthy();
    expect(screen.queryByText("localAccessListeningPortTitle")).toBeNull();
  });

  it("saves relay-mode file access changes through server settings", async () => {
    render(<LocalAccessSettings />);

    const saveButton = await screen.findByRole("button", {
      name: "localAccessApply",
    });
    expect(saveButton).toHaveProperty("disabled", true);

    fireEvent.click(checkboxFor("fileAccessHome"));

    expect(saveButton).toHaveProperty("disabled", false);
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        fileAccess: {
          projects: true,
          uploads: true,
          temp: true,
          home: true,
          custom: [],
        },
      }),
    );
  });
});
