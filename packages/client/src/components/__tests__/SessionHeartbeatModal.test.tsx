// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHeartbeatModal } from "../SessionHeartbeatModal";

const { mockUpdateSessionMetadata, serverSettingsState } = vi.hoisted(() => ({
  mockUpdateSessionMetadata: vi.fn(),
  serverSettingsState: {
    settings: null as {
      heartbeatTurnsAfterMinutes?: number;
      heartbeatTurnText?: string;
    } | null,
  },
}));

vi.mock("../../api/client", () => ({
  api: {
    updateSessionMetadata: mockUpdateSessionMetadata,
  },
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: serverSettingsState.settings,
    isLoading: false,
    error: null,
    updateSettings: vi.fn(),
    updateSetting: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === "modalClose") return "Close";
      if (key === "sessionHeartbeatAfterTitle") return "Idle Minutes Override";
      if (key === "sessionHeartbeatForceTitle") return "Nudge Force Delay";
      if (key === "sessionHeartbeatTextTitle") return "Nudge Text";
      if (params?.value !== undefined) return `${key}:${params.value}`;
      return key;
    },
  }),
}));

function renderModal(
  props: Partial<ComponentProps<typeof SessionHeartbeatModal>> = {},
) {
  return render(
    <SessionHeartbeatModal
      sessionId="sess-1"
      enabled={true}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      {...props}
    />,
  );
}

describe("SessionHeartbeatModal", () => {
  beforeEach(() => {
    serverSettingsState.settings = {
      heartbeatTurnsAfterMinutes: 20,
      heartbeatTurnText: "yepanywhere heartbeat",
    };
    mockUpdateSessionMetadata.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows default heartbeat text as an editable placeholder", () => {
    renderModal();

    const input = screen.getByPlaceholderText(
      "yepanywhere heartbeat",
    ) as HTMLInputElement;

    expect(input.value).toBe("");
  });

  it("saves custom text on Enter and closes", async () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    const input = screen.getByPlaceholderText("yepanywhere heartbeat");
    fireEvent.change(input, { target: { value: "checking in" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockUpdateSessionMetadata).toHaveBeenCalledWith("sess-1", {
        heartbeatTurnsEnabled: true,
        heartbeatTurnsAfterMinutes: null,
        heartbeatTurnText: "checking in",
        heartbeatForceAfterMinutes: null,
      });
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("commits inactivity preset clicks immediately", async () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    fireEvent.click(screen.getByRole("button", { name: "30m" }));

    await waitFor(() => {
      expect(mockUpdateSessionMetadata).toHaveBeenCalledWith("sess-1", {
        heartbeatTurnsEnabled: true,
        heartbeatTurnsAfterMinutes: 30,
        heartbeatTurnText: null,
        heartbeatForceAfterMinutes: null,
      });
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("commits force preset clicks and enables the default inactivity timer", async () => {
    const onClose = vi.fn();
    renderModal({ enabled: false, onClose });

    const forceGroup = screen.getByRole("group", {
      name: "Nudge Force Delay",
    });
    fireEvent.click(within(forceGroup).getByRole("button", { name: "5m" }));

    await waitFor(() => {
      expect(mockUpdateSessionMetadata).toHaveBeenCalledWith("sess-1", {
        heartbeatTurnsEnabled: true,
        heartbeatTurnsAfterMinutes: 20,
        heartbeatTurnText: null,
        heartbeatForceAfterMinutes: 5,
      });
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when selection starts inside and releases on the overlay", () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    const input = screen.getByPlaceholderText("yepanywhere heartbeat");
    const overlay = document.querySelector(".modal-overlay");

    expect(overlay).not.toBeNull();
    fireEvent.mouseDown(input);
    fireEvent.click(overlay as Element);

    expect(onClose).not.toHaveBeenCalled();
  });
});
