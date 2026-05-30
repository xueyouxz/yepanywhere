import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getCodexUpdateStatus = vi.fn();
const installCodexUpdate = vi.fn();

vi.mock("../../api/client", () => ({
  api: {
    getCodexUpdateStatus: (...args: unknown[]) =>
      getCodexUpdateStatus(...args),
    installCodexUpdate: (...args: unknown[]) => installCodexUpdate(...args),
  },
}));

const baseStatus = {
  installed: "0.4.2",
  installedPath: "/usr/local/bin/codex",
  installedPackage: "@openai/codex",
  updateMethod: "npm" as const,
  manualInstallCommand: "npm install -g @openai/codex@latest",
  latest: "0.4.3",
  releaseUrl: "https://example.test/release",
  updateAvailable: true,
  lastCheckedAt: 1,
  error: null,
};

describe("useCodexUpdateStatus", () => {
  beforeEach(() => {
    getCodexUpdateStatus.mockReset();
    installCodexUpdate.mockReset();
  });

  it("fetches status on mount", async () => {
    getCodexUpdateStatus.mockResolvedValueOnce({ status: baseStatus });
    const { useCodexUpdateStatus } = await import("../useCodexUpdateStatus");

    const { result } = renderHook(() => useCodexUpdateStatus());

    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.status?.latest).toBe("0.4.3");
    expect(getCodexUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it("install() surfaces success and refreshes status", async () => {
    getCodexUpdateStatus.mockResolvedValue({ status: baseStatus });
    installCodexUpdate.mockResolvedValueOnce({
      success: true,
      output: "installed",
      status: { ...baseStatus, installed: "0.4.3", updateAvailable: false },
    });
    const { useCodexUpdateStatus } = await import("../useCodexUpdateStatus");

    const { result } = renderHook(() => useCodexUpdateStatus());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    let ok = false;
    await act(async () => {
      ok = await result.current.install();
    });
    expect(ok).toBe(true);
    expect(result.current.status?.installed).toBe("0.4.3");
    expect(result.current.installOutput).toBe("installed");
    expect(result.current.error).toBeNull();
  });

  it("install() surfaces failure error", async () => {
    getCodexUpdateStatus.mockResolvedValue({ status: baseStatus });
    installCodexUpdate.mockResolvedValueOnce({
      success: false,
      output: "",
      status: baseStatus,
      error: "permission denied",
    });
    const { useCodexUpdateStatus } = await import("../useCodexUpdateStatus");

    const { result } = renderHook(() => useCodexUpdateStatus());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    let ok = true;
    await act(async () => {
      ok = await result.current.install();
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe("permission denied");
  });
});
