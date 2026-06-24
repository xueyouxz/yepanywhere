// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettings } from "../../../api/client";
import { LifecycleWebhooksSettings } from "../LifecycleWebhooksSettings";

const { mockUpdateSetting, mockUpdateSettings, hookState } = vi.hoisted(() => ({
  mockUpdateSetting: vi.fn(),
  mockUpdateSettings: vi.fn(),
  hookState: {
    settings: null as ServerSettings | null,
    isLoading: false,
    error: null as string | null,
  },
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    ...hookState,
    updateSetting: mockUpdateSetting,
    updateSettings: mockUpdateSettings,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const baseSettings: ServerSettings = {
  serviceWorkerEnabled: true,
  persistRemoteSessionsToDisk: false,
  lifecycleWebhooksEnabled: false,
  lifecycleWebhookDryRun: true,
};

describe("LifecycleWebhooksSettings", () => {
  beforeEach(() => {
    hookState.settings = {
      ...baseSettings,
      lifecycleWebhookUrl: "https://example.test/yep",
      lifecycleWebhookToken: "secret-token",
    };
    hookState.isLoading = false;
    hookState.error = null;
    mockUpdateSetting.mockResolvedValue(undefined);
    mockUpdateSettings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("saves cleared URL and token as one settings update", async () => {
    render(<LifecycleWebhooksSettings />);

    fireEvent.change(screen.getByLabelText("lifecycleWebhooksUrlTitle"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("lifecycleWebhooksTokenTitle"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "providersSave" }));

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        lifecycleWebhooksEnabled: false,
        lifecycleWebhookUrl: undefined,
        lifecycleWebhookToken: undefined,
        lifecycleWebhookDryRun: true,
      }),
    );
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });

  it("saves enable changes even when URL is empty", async () => {
    hookState.settings = {
      ...baseSettings,
      lifecycleWebhooksEnabled: true,
      lifecycleWebhookDryRun: false,
    };
    render(<LifecycleWebhooksSettings />);

    const saveButton = screen.getByRole("button", { name: "providersSave" });
    expect(saveButton).toHaveProperty("disabled", true);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /lifecycleWebhooksEnableTitle/,
      }),
    );

    expect(saveButton).toHaveProperty("disabled", false);
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        lifecycleWebhooksEnabled: false,
        lifecycleWebhookUrl: undefined,
        lifecycleWebhookToken: undefined,
        lifecycleWebhookDryRun: false,
      }),
    );
  });

  it("does not overwrite URL and token drafts when dry-run changes", () => {
    const view = render(<LifecycleWebhooksSettings />);

    const urlInput = screen.getByLabelText(
      "lifecycleWebhooksUrlTitle",
    ) as HTMLInputElement;
    const tokenInput = screen.getByLabelText(
      "lifecycleWebhooksTokenTitle",
    ) as HTMLInputElement;

    fireEvent.change(urlInput, { target: { value: "" } });
    fireEvent.change(tokenInput, { target: { value: "" } });

    hookState.settings = {
      ...hookState.settings,
      lifecycleWebhookDryRun: false,
    } as ServerSettings;
    view.rerender(<LifecycleWebhooksSettings />);

    expect(
      (screen.getByLabelText("lifecycleWebhooksUrlTitle") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(
      (screen.getByLabelText("lifecycleWebhooksTokenTitle") as HTMLInputElement)
        .value,
    ).toBe("");
  });
});
