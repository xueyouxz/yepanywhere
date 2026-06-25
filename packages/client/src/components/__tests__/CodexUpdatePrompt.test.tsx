// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexUpdatePrompt } from "../CodexUpdatePrompt";

const {
  mockInstall,
  mockUpdateSetting,
  mockUseCodexUpdateStatus,
  mockUseServerSettings,
} = vi.hoisted(() => ({
  mockInstall: vi.fn(),
  mockUpdateSetting: vi.fn(),
  mockUseCodexUpdateStatus: vi.fn(),
  mockUseServerSettings: vi.fn(),
}));

vi.mock("../../hooks/useCodexUpdateStatus", () => ({
  useCodexUpdateStatus: (...args: unknown[]) =>
    mockUseCodexUpdateStatus(...args),
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => mockUseServerSettings(),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        codexUpdateAutoFutureVersions: "Update next versions too",
        codexUpdateDone: "Done",
        codexUpdateManualInstallHint:
          "This Codex install was not installed with npm.",
        codexUpdateWillRunCommand: "Yep Anywhere will run:",
        modalClose: "Close dialog",
      })[key] ?? key,
  }),
}));

interface TestCodexUpdateStatus {
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

const baseStatus: TestCodexUpdateStatus = {
  installed: "0.4.2",
  installedPath: "/usr/local/bin/codex",
  installedPackage: "@openai/codex",
  updateMethod: "npm",
  manualInstallCommand: "npm install -g @openai/codex@latest",
  latest: "0.4.3",
  releaseUrl: "https://example.test/release",
  updateAvailable: true,
  lastCheckedAt: 1,
  error: null,
};

describe("CodexUpdatePrompt", () => {
  let hookState: {
    status: TestCodexUpdateStatus;
    isChecking: boolean;
    isInstalling: boolean;
    error: string | null;
    installOutput: string | null;
    refresh: ReturnType<typeof vi.fn>;
    install: typeof mockInstall;
  };

  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          store.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          store.delete(key);
        }),
        clear: vi.fn(() => {
          store.clear();
        }),
      },
    });
    mockInstall.mockReset();
    mockUpdateSetting.mockReset();

    hookState = {
      status: baseStatus,
      isChecking: false,
      isInstalling: false,
      error: null,
      installOutput: null,
      refresh: vi.fn(),
      install: mockInstall,
    };

    mockUseCodexUpdateStatus.mockImplementation(() => hookState);
    mockUseServerSettings.mockImplementation(() => ({
      settings: { codexUpdatePolicy: "notify" as const },
      updateSetting: mockUpdateSetting,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("defaults future updates on and keeps the dialog open to show raw output", async () => {
    mockUpdateSetting.mockResolvedValue(undefined);
    mockInstall.mockImplementation(async () => {
      hookState = {
        ...hookState,
        status: {
          ...baseStatus,
          installed: "0.4.3",
          updateAvailable: false,
        },
        installOutput: "added 1 package in 2s",
      };
      return true;
    });

    const view = render(<CodexUpdatePrompt />);

    const checkbox = screen.getByRole("checkbox", {
      name: /update next versions too/i,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() =>
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "codexUpdatePolicy",
        "auto",
      ),
    );
    await waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(1));

    view.rerender(<CodexUpdatePrompt />);

    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(screen.queryByText("Raw output")).not.toBeNull();
    expect(screen.queryByText(/added 1 package in 2s/i)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(window.localStorage.getItem("codex-update-seen-tag")).toBe("0.4.3");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows failure output without marking the release as seen", async () => {
    mockUpdateSetting.mockResolvedValue(undefined);
    mockInstall.mockImplementation(async () => {
      hookState = {
        ...hookState,
        error: "permission denied",
        installOutput: "EACCES",
      };
      return false;
    });

    const view = render(<CodexUpdatePrompt />);

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(1));

    view.rerender(<CodexUpdatePrompt />);

    expect(screen.queryByText(/permission denied/i)).not.toBeNull();
    expect(screen.queryByText(/EACCES/i)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(window.localStorage.getItem("codex-update-seen-tag")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("prompts for manual installs without offering auto-update", () => {
    hookState = {
      ...hookState,
      status: {
        ...baseStatus,
        installedPackage: null,
        updateMethod: "manual",
        manualInstallCommand: null,
      },
    };

    render(<CodexUpdatePrompt />);

    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(
      screen.queryByText("This Codex install was not installed with npm."),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Update now" }),
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", {
        name: /update next versions too/i,
      }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(mockInstall).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("codex-update-seen-tag")).toBe("0.4.3");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not check or prompt when update policy is off", () => {
    mockUseServerSettings.mockImplementation(() => ({
      settings: { codexUpdatePolicy: "off" as const },
      updateSetting: mockUpdateSetting,
    }));

    render(<CodexUpdatePrompt />);

    expect(mockUseCodexUpdateStatus).toHaveBeenCalledWith({ enabled: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
