// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ProviderInfo } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestartSessionModal } from "../RestartSessionModal";

const { mockRestartSession, serverSettingsState } = vi.hoisted(() => ({
  mockRestartSession: vi.fn(),
  serverSettingsState: {
    settings: null as {
      newSessionDefaults?: {
        provider?: "claude" | "codex";
        model?: string;
        permissionMode?: "default";
        recapMode?: "off" | "native" | "side-session";
        recapAfterSeconds?: number;
        promptSuggestionMode?: "off" | "native";
        helperSideModel?: string;
      };
    } | null,
    isLoading: false,
  },
}));

vi.mock("../../api/client", () => ({
  api: {
    restartSession: mockRestartSession,
  },
}));

vi.mock("../../hooks/useModelSettings", () => ({
  getModelSetting: () => "default",
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: serverSettingsState.settings,
    isLoading: serverSettingsState.isLoading,
    error: null,
    updateSettings: vi.fn(),
    updateSetting: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params?.level ? `${key}:${params.level}` : key,
  }),
}));

const providerInfo = (
  provider: "claude" | "codex",
  models: ProviderInfo["models"],
): ProviderInfo => ({
  name: provider,
  displayName: provider === "claude" ? "Claude" : "Codex",
  installed: true,
  authenticated: true,
  enabled: true,
  models,
  supportsThinkingToggle: true,
  supportsNativePromptSuggestions: provider === "claude",
});

describe("RestartSessionModal", () => {
  beforeEach(() => {
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "codex",
        model: "gpt-5.5",
        permissionMode: "default",
      },
    };
    serverSettingsState.isLoading = false;
    mockRestartSession.mockResolvedValue({
      sessionId: "sess-new",
      processId: "proc-new",
      model: "gpt-5.5",
      oldProcessAborted: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("uses saved new-session model defaults for handoff", async () => {
    render(
      <RestartSessionModal
        projectId="proj-1"
        sessionId="sess-1"
        provider="codex"
        models={[
          { id: "gpt-5.4", name: "GPT-5.4" },
          { id: "gpt-5.5", name: "GPT-5.5" },
        ]}
        currentModel="gpt-5.4"
        mode="default"
        thinking="off"
        onRestarted={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "sessionRestartStart" }),
    );

    await waitFor(() => {
      expect(mockRestartSession).toHaveBeenCalledWith(
        "proj-1",
        "sess-1",
        expect.objectContaining({
          provider: "codex",
          model: "gpt-5.5",
          recapMode: "off",
          recapAfterSeconds: 300,
          promptSuggestionMode: "off",
          helperSideModel: "cheapest",
        }),
      );
    });
  });

  it("can hand off to a different provider", async () => {
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        model: "sonnet",
        permissionMode: "default",
      },
    };

    render(
      <RestartSessionModal
        projectId="proj-1"
        sessionId="sess-1"
        provider="claude"
        providerDisplayName="Claude"
        providers={[
          providerInfo("claude", [{ id: "sonnet", name: "Sonnet" }]),
          providerInfo("codex", [{ id: "gpt-5.5", name: "GPT-5.5" }]),
        ]}
        currentModel="sonnet"
        mode="default"
        thinking="off"
        onRestarted={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "sessionRestartStart" }),
    );

    await waitFor(() => {
      expect(mockRestartSession).toHaveBeenCalledWith(
        "proj-1",
        "sess-1",
        expect.objectContaining({
          provider: "codex",
          model: "gpt-5.5",
        }),
      );
    });
  });

  it("sends handoff recap helper selections", async () => {
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        model: "sonnet",
        permissionMode: "default",
        recapMode: "side-session",
        helperSideModel: "haiku",
      },
    };

    render(
      <RestartSessionModal
        projectId="proj-1"
        sessionId="sess-1"
        provider="claude"
        providers={[
          {
            ...providerInfo("claude", [
              { id: "sonnet", name: "Sonnet" },
              { id: "haiku", name: "Haiku" },
            ]),
            supportsRecaps: true,
          },
        ]}
        currentModel="sonnet"
        mode="default"
        thinking="off"
        onRestarted={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen
        .getAllByRole("button", { name: /Haiku/ })
        .some((button) => button.className.includes("active")),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "sessionRestartStart" }),
    );

    await waitFor(() => {
      expect(mockRestartSession).toHaveBeenCalledWith(
        "proj-1",
        "sess-1",
        expect.objectContaining({
          recapMode: "side-session",
          promptSuggestionMode: "off",
          helperSideModel: "haiku",
        }),
      );
    });
  });

  it("carries a disabled prompt suggestion mode through handoff", async () => {
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        model: "sonnet",
        permissionMode: "default",
        promptSuggestionMode: "native",
      },
    };

    render(
      <RestartSessionModal
        projectId="proj-1"
        sessionId="sess-1"
        provider="claude"
        providers={[providerInfo("claude", [{ id: "sonnet", name: "Sonnet" }])]}
        currentModel="sonnet"
        mode="default"
        thinking="off"
        promptSuggestionMode="off"
        onRestarted={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen
        .getAllByRole("button", { name: /promptSuggestionModeOff/ })
        .some((button) => button.className.includes("active")),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "sessionRestartStart" }),
    );

    await waitFor(() => {
      expect(mockRestartSession).toHaveBeenCalledWith(
        "proj-1",
        "sess-1",
        expect.objectContaining({
          provider: "claude",
          promptSuggestionMode: "off",
        }),
      );
    });
  });

  it("offers fork mode only when the source provider supports it", () => {
    render(
      <RestartSessionModal
        projectId="proj-1"
        sessionId="sess-1"
        provider="codex"
        providers={[
          providerInfo("codex", [{ id: "gpt-5.5", name: "GPT-5.5" }]),
        ]}
        currentModel="gpt-5.5"
        mode="default"
        thinking="off"
        onRestarted={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "sessionRestartModeFork" }),
    ).toBeNull();
  });

  it("sends a fork restart pinned to the source provider", async () => {
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        model: "sonnet",
        permissionMode: "default",
      },
    };

    render(
      <RestartSessionModal
        projectId="proj-1"
        sessionId="sess-1"
        provider="claude"
        providerDisplayName="Claude"
        providers={[
          {
            ...providerInfo("claude", [{ id: "sonnet", name: "Sonnet" }]),
            supportsForkSession: true,
          },
          providerInfo("codex", [{ id: "gpt-5.5", name: "GPT-5.5" }]),
        ]}
        currentModel="sonnet"
        mode="default"
        thinking="off"
        onRestarted={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Even after picking another provider, choosing fork pins back to source
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "sessionRestartModeFork" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "sessionRestartStartFork" }),
    );

    await waitFor(() => {
      expect(mockRestartSession).toHaveBeenCalledWith(
        "proj-1",
        "sess-1",
        expect.objectContaining({
          provider: "claude",
          restartMode: "fork",
          reason: undefined,
        }),
      );
    });
  });
});
