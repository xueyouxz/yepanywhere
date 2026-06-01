// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettings } from "../../api/client";
import { RemoteAccessSetup } from "../RemoteAccessSetup";

const {
  mockUpdateSetting,
  mockUpdateRelayConfig,
  remoteAccessState,
  serverSettingsState,
} = vi.hoisted(() => ({
  mockUpdateSetting: vi.fn(),
  mockUpdateRelayConfig: vi.fn(),
  remoteAccessState: {
    relayUrl: "wss://relay.graehl.org/ws",
    username: "ygraehl",
  },
  serverSettingsState: {
    settings: {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      publicSharesEnabled: false,
      yaClientBaseUrl: "https://ya.graehl.org",
    } as ServerSettings,
  },
}));

vi.mock("../../hooks/useRemoteAccess", () => ({
  useRemoteAccess: () => ({
    config: { enabled: true, username: remoteAccessState.username },
    relayConfig: {
      url: remoteAccessState.relayUrl,
      username: remoteAccessState.username,
    },
    relayStatus: { status: "waiting", error: null, reconnectAttempts: 0 },
    sessions: [],
    loading: false,
    error: null,
    configure: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    updateRelayConfig: mockUpdateRelayConfig,
    revokeSession: vi.fn(),
    revokeAllSessions: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: serverSettingsState.settings,
    isLoading: false,
    error: null,
    updateSetting: mockUpdateSetting,
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      let text = key;
      if (!values) return text;
      for (const [name, value] of Object.entries(values)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
      return text;
    },
  }),
}));

describe("RemoteAccessSetup YA client URL", () => {
  beforeEach(() => {
    mockUpdateSetting.mockReset();
    mockUpdateRelayConfig.mockReset();
    remoteAccessState.relayUrl = "wss://relay.graehl.org/ws";
    remoteAccessState.username = "ygraehl";
    serverSettingsState.settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      publicSharesEnabled: false,
      yaClientBaseUrl: "https://ya.graehl.org",
    } as ServerSettings;
  });

  afterEach(() => {
    cleanup();
  });

  it("builds the Connect from URL from the configured YA host", async () => {
    render(<RemoteAccessSetup />);

    await waitFor(() => {
      expect(screen.getByText(/^https:\/\/ya\.graehl\.org/).textContent).toBe(
        "https://ya.graehl.org/login/relay?u=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws",
      );
    });
  });

  it("normalizes bare custom YA hosts before saving", async () => {
    serverSettingsState.settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      publicSharesEnabled: false,
    } as ServerSettings;
    render(<RemoteAccessSetup />);

    fireEvent.change(screen.getByLabelText("remoteSetupYaClient"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("remoteSetupCustomYaClientUrl"), {
      target: { value: "ya.graehl.org" },
    });
    const saveButton = screen.getByRole("button", {
      name: "remoteSetupSave",
    }) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveButton.disabled).toBe(false);
    });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "yaClientBaseUrl",
        "https://ya.graehl.org",
      );
    });
    expect(mockUpdateRelayConfig).not.toHaveBeenCalled();
  });
});
