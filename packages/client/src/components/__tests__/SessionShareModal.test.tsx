// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { SessionShareModal } from "../SessionShareModal";

describe("SessionShareModal", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    vi.spyOn(api, "getPublicSessionShareStatus").mockResolvedValue({
      activeCount: 0,
      frozenCount: 0,
      liveCount: 0,
      activeViewerCount: 0,
      viewers: [],
    });
    vi.spyOn(api, "createPublicSessionShare").mockResolvedValue({
      url: "https://ya.graehl.org/share/secret?h=test-host",
      mode: "frozen",
      createdAt: "2026-05-01T00:00:00.000Z",
      secretBits: 512,
    });
    vi.spyOn(api, "revokePublicSessionShares").mockResolvedValue({
      activeCount: 0,
      frozenCount: 0,
      liveCount: 0,
      activeViewerCount: 0,
      viewers: [],
      revokedCount: 2,
    });
    vi.spyOn(api, "freezePublicSessionLiveShares").mockResolvedValue({
      activeCount: 1,
      frozenCount: 1,
      liveCount: 0,
      activeViewerCount: 0,
      viewers: [],
      convertedCount: 1,
    });
    vi.spyOn(api, "freezePublicSessionViewerToken").mockResolvedValue({
      activeCount: 1,
      frozenCount: 0,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [
        {
          viewerId: "viewer-token-1",
          shortId: "viewer-t",
          firstSeenAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:01:00.000Z",
          accessCount: 2,
          active: false,
          disconnected: false,
          frozen: true,
        },
      ],
      viewerId: "viewer-token-1",
      convertedCount: 1,
    });
    vi.spyOn(api, "disconnectPublicSessionViewerToken").mockResolvedValue({
      activeCount: 1,
      frozenCount: 0,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [],
      viewerId: "viewer-token-1",
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    writeText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  });

  it("writes to the clipboard before the slow share request resolves", async () => {
    // Defer the create so we can observe that the clipboard write is initiated
    // from the click's user-activation rather than after the round-trip.
    let resolveCreate: (value: {
      url: string;
      mode: "frozen";
      createdAt: string;
      secretBits: number;
    }) => void = () => {};
    vi.mocked(api.createPublicSessionShare).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText },
    });
    class FakeClipboardItem {
      constructor(public items: Record<string, Promise<Blob>>) {}
    }
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: FakeClipboardItem,
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Copy Read-Only Snapshot Link/ }),
    );

    // The promise-valued write is dispatched before the share URL exists, so the
    // activation is captured even when the create is slow.
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(writeText).not.toHaveBeenCalled();

    resolveCreate({
      url: "https://ya.graehl.org/share/secret?h=test-host",
      mode: "frozen",
      createdAt: "2026-05-01T00:00:00.000Z",
      secretBits: 512,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Read-only link copied to clipboard."),
      ).toBeTruthy();
    });
  });

  it("creates and copies a frozen read-only public share in one click", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialPrompt="first prompt"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Copy Read-Only Snapshot Link/ }),
    );

    await waitFor(() => {
      expect(api.createPublicSessionShare).toHaveBeenCalledWith({
        projectId: "cHJvamVjdA",
        sessionId: "session-1",
        mode: "frozen",
        initialPrompt: "first prompt",
        title: "Build logs",
      });
    });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "https://ya.graehl.org/share/secret?h=test-host",
      );
      expect(
        screen.getByDisplayValue(
          "https://ya.graehl.org/share/secret?h=test-host",
        ),
      ).toBeTruthy();
      expect(
        screen.getByText("Read-only link copied to clipboard."),
      ).toBeTruthy();
    });
  });

  it("creates and copies a live read-only public share in one click", async () => {
    const onStatusChange = vi.fn();
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onStatusChange={onStatusChange}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Copy Read-Only Live Link/ }),
    );

    await waitFor(() => {
      expect(api.createPublicSessionShare).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "live" }),
      );
    });
    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({
          activeCount: 1,
          liveCount: 1,
        }),
      );
    });
  });

  it("shows manual copy guidance without legacy copy fallbacks", async () => {
    writeText.mockRejectedValueOnce(new Error("Document is not focused"));
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Copy Read-Only Snapshot Link/ }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Read-only link created. Clipboard access was blocked; select the link above to copy it manually.",
        ),
      ).toBeTruthy();
    });
    expect(execCommand).not.toHaveBeenCalled();
    expect(screen.queryByText("Document is not focused")).toBeNull();
    expect(
      screen.getByDisplayValue(
        "https://ya.graehl.org/share/secret?h=test-host",
      ),
    ).toBeTruthy();
  });

  it("tries async clipboard even when document focus is unreliable", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => true),
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Copy Read-Only Snapshot Link/ }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Read-only link copied to clipboard."),
      ).toBeTruthy();
    });
    expect(writeText).toHaveBeenCalledWith(
      "https://ya.graehl.org/share/secret?h=test-host",
    );
  });

  it("shows revoke all only when the session already has active shares", async () => {
    vi.mocked(api.getPublicSessionShareStatus).mockResolvedValue({
      activeCount: 2,
      frozenCount: 1,
      liveCount: 1,
      activeViewerCount: 3,
      viewers: [],
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    const revoke = await screen.findByRole("button", {
      name: "Revoke All Shared Links",
    });
    expect(
      screen.getByLabelText(
        "3 active viewer(s), 0 token(s), 1 live link(s), 1 snapshot link(s)",
      ),
    ).toBeTruthy();
    fireEvent.click(revoke);

    await waitFor(() => {
      expect(api.revokePublicSessionShares).toHaveBeenCalledWith(
        "cHJvamVjdA",
        "session-1",
      );
    });
    expect(screen.getByText("Revoked 2 shared link(s).")).toBeTruthy();
  });

  it("freezes all live public links", async () => {
    vi.mocked(api.getPublicSessionShareStatus).mockResolvedValue({
      activeCount: 1,
      frozenCount: 0,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [],
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Stop live updates",
      }),
    );

    await waitFor(() => {
      expect(api.freezePublicSessionLiveShares).toHaveBeenCalledWith(
        "cHJvamVjdA",
        "session-1",
      );
    });
    expect(
      screen.getByText(
        "Live updates stopped for 1 link(s); they now open as read-only snapshots.",
      ),
    ).toBeTruthy();
  });

  it("shows viewer tokens with freeze and disconnect controls", async () => {
    vi.mocked(api.getPublicSessionShareStatus).mockResolvedValue({
      activeCount: 1,
      frozenCount: 0,
      liveCount: 1,
      activeViewerCount: 1,
      viewers: [
        {
          viewerId: "viewer-token-1",
          shortId: "viewer-t",
          firstSeenAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:01:00.000Z",
          accessCount: 2,
          active: true,
          disconnected: false,
          frozen: false,
        },
      ],
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(await screen.findByText("viewer-t")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Snapshot this token viewer-t",
      }),
    );
    await waitFor(() => {
      expect(api.freezePublicSessionViewerToken).toHaveBeenCalledWith(
        "cHJvamVjdA",
        "session-1",
        "viewer-token-1",
      );
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Disconnect this token viewer-t",
      }),
    );
    await waitFor(() => {
      expect(api.disconnectPublicSessionViewerToken).toHaveBeenCalledWith(
        "cHJvamVjdA",
        "session-1",
        "viewer-token-1",
      );
    });
  });
});
