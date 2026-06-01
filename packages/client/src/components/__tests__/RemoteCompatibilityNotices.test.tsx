// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionInfo } from "../../api/client";
import { restoreRemoteCompatibilityNoticeDismissals } from "../../hooks/useRemoteCompatibilityNoticeDismissals";
import { getRemoteCompatibilityNotices } from "../../lib/remoteCompatibilityNotices";
import { RemoteCompatibilityNotices } from "../RemoteCompatibilityNotices";

function version(overrides: Partial<VersionInfo> = {}): VersionInfo {
  return {
    current: "0.4.29",
    latest: "0.4.29",
    updateAvailable: false,
    resumeProtocolVersion: 2,
    capabilities: [],
    ...overrides,
  };
}

describe("RemoteCompatibilityNotices", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    writeText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("renders and dismisses the relay resume security notice", () => {
    render(
      <RemoteCompatibilityNotices
        relayUsername="dev-box"
        versionInfo={version({ resumeProtocolVersion: 1 })}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Server update recommended",
    );
    expect(screen.getByText(/session-resume hardening/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByTestId("remote-compatibility-notice")).toBeNull();
    const keys = Array.from(
      { length: window.localStorage.length },
      (_value, index) => window.localStorage.key(index) ?? "",
    );
    expect(keys.some((key) => key.includes("relay-resume-security"))).toBe(
      true,
    );
  });

  it("copies the update command for stable release installs", async () => {
    render(
      <RemoteCompatibilityNotices
        relayUsername="dev-box"
        versionInfo={version({
          current: "0.4.28",
          latest: "0.4.29",
          updateAvailable: true,
          installSource: "npm-global",
        })}
      />,
    );

    expect(
      screen.getByText("Server v0.4.28; recommended v0.4.29"),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Copy npm command text") as HTMLInputElement)
        .value,
    ).toBe("npm update -g yepanywhere");

    fireEvent.click(screen.getByRole("button", { name: "Copy npm command" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("npm update -g yepanywhere"),
    );
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("exposes source checkout steps for git-describe versions", async () => {
    render(
      <RemoteCompatibilityNotices
        relayUsername="dev-box"
        versionInfo={version({
          current: "0.4.28-3-gabcdef",
          latest: "0.4.29",
          updateAvailable: true,
        })}
      />,
    );

    expect(screen.getByText("Update recommended")).toBeTruthy();
    expect(screen.getByText(/Source checkout detected/i)).toBeTruthy();
    expect(
      (screen.getByLabelText("Copy source steps text") as HTMLTextAreaElement)
        .value,
    ).toBe("git fetch origin\ngit merge origin/main\npnpm install\npnpm build");

    fireEvent.click(screen.getByRole("button", { name: "Copy source steps" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "git fetch origin\ngit merge origin/main\npnpm install\npnpm build",
      ),
    );
  });

  it("stays hidden after remount when the same notice was dismissed", () => {
    const props = {
      relayUsername: "dev-box",
      versionInfo: version({
        current: "0.4.28",
        latest: "0.4.29",
        updateAvailable: true,
      }),
    };
    const view = render(<RemoteCompatibilityNotices {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("remote-compatibility-notice")).toBeNull();

    view.unmount();
    render(<RemoteCompatibilityNotices {...props} />);

    expect(screen.queryByTestId("remote-compatibility-notice")).toBeNull();
  });

  it("reappears when another surface restores the dismissed notice", async () => {
    const props = {
      relayUsername: "dev-box",
      versionInfo: version({
        current: "0.4.28",
        latest: "0.4.29",
        updateAvailable: true,
      }),
    };
    render(<RemoteCompatibilityNotices {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("remote-compatibility-notice")).toBeNull();

    act(() => {
      restoreRemoteCompatibilityNoticeDismissals(
        getRemoteCompatibilityNotices({
          currentVersion: props.versionInfo.current,
          latestVersion: props.versionInfo.latest,
          updateAvailable: props.versionInfo.updateAvailable,
          resumeProtocolVersion: props.versionInfo.resumeProtocolVersion,
          capabilities: props.versionInfo.capabilities,
          relayUsername: props.relayUsername,
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("remote-compatibility-notice")).toBeTruthy(),
    );
  });
});
