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
import { MessageDeliverySettings } from "../MessageDeliverySettings";
import {
  SettingsUndoProvider,
  type SettingsUndoRegistration,
} from "../SettingsUndoContext";

const { mockUpdateSettings, hookState } = vi.hoisted(() => ({
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

const baseSettings: ServerSettings = {
  serviceWorkerEnabled: true,
  persistRemoteSessionsToDisk: false,
  deferredJoinWindowSeconds: 0,
  composeAnchorsEnabled: false,
};

describe("MessageDeliverySettings", () => {
  beforeEach(() => {
    hookState.settings = { ...baseSettings };
    hookState.isLoading = false;
    hookState.error = null;
    mockUpdateSettings.mockReset();
    mockUpdateSettings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("applies the anchors toggle immediately, with no Save button", () => {
    render(<MessageDeliverySettings />);

    expect(screen.queryByText("providersSave")).toBeNull();

    fireEvent.click(
      screen.getByLabelText("messageDeliveryComposeAnchorsTitle"),
    );
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      composeAnchorsEnabled: true,
    });
  });

  it("debounce-saves the join window from the numeric input", () => {
    vi.useFakeTimers();
    render(<MessageDeliverySettings />);

    fireEvent.change(screen.getByLabelText("messageDeliveryJoinWindowTitle"), {
      target: { value: "30" },
    });
    expect(mockUpdateSettings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      deferredJoinWindowSeconds: 30,
    });
  });

  it("registers a header undo that reverts to the open-time snapshot", async () => {
    const holder: { registration: SettingsUndoRegistration | null } = {
      registration: null,
    };
    hookState.settings = {
      ...baseSettings,
      deferredJoinWindowSeconds: 20,
      composeAnchorsEnabled: true,
    };

    render(
      <SettingsUndoProvider
        value={(next) => {
          holder.registration = next;
        }}
      >
        <MessageDeliverySettings />
      </SettingsUndoProvider>,
    );

    // Untouched pane registers no undo.
    expect(holder.registration).toBeNull();

    fireEvent.click(
      screen.getByLabelText("messageDeliveryComposeAnchorsTitle"),
    );
    await waitFor(() => expect(holder.registration?.canUndo).toBe(true));

    await holder.registration?.undo();
    expect(mockUpdateSettings).toHaveBeenLastCalledWith({
      deferredJoinWindowSeconds: 20,
      composeAnchorsEnabled: true,
      clientDefaults: { steerNowDefault: false },
    });
  });
});
