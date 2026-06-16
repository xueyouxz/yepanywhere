import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_KEYS } from "../../lib/storageKeys";

const mocks = vi.hoisted(() => ({
  getServerSettings: vi.fn(async () => ({
    settings: {} as Record<string, unknown>,
  })),
  updateServerSettings: vi.fn(async () => ({ settings: {} })),
  isAuthenticated: true,
}));

vi.mock("../../api/client", () => ({
  api: {
    getServerSettings: mocks.getServerSettings,
    updateServerSettings: mocks.updateServerSettings,
  },
}));

vi.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ isAuthenticated: mocks.isAuthenticated }),
}));

const SEED_MARKER_KEY = "yep-anywhere-compact-threshold-seeded";

describe("useSeedCompactThreshold", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    mocks.isAuthenticated = true;
    mocks.getServerSettings.mockClear();
    mocks.getServerSettings.mockResolvedValue({ settings: {} });
    mocks.updateServerSettings.mockClear();
    vi.resetModules();
  });

  it("seeds 20% for a former bare-opus user", async () => {
    window.localStorage.setItem(LEGACY_KEYS.model, "opus");
    const { useSeedCompactThreshold } = await import(
      "../useSeedCompactThreshold"
    );
    renderHook(() => useSeedCompactThreshold());

    await waitFor(() =>
      expect(mocks.updateServerSettings).toHaveBeenCalledWith({
        clientDefaults: { compactAtContextPercent: { opus: 20 } },
      }),
    );
    expect(window.localStorage.getItem(SEED_MARKER_KEY)).toBe("1");
  });

  it("does not seed for the explicit 1M variant", async () => {
    window.localStorage.setItem(LEGACY_KEYS.model, "opus[1m]");
    const { useSeedCompactThreshold } = await import(
      "../useSeedCompactThreshold"
    );
    renderHook(() => useSeedCompactThreshold());

    await waitFor(() =>
      expect(window.localStorage.getItem(SEED_MARKER_KEY)).toBe("1"),
    );
    expect(mocks.getServerSettings).not.toHaveBeenCalled();
    expect(mocks.updateServerSettings).not.toHaveBeenCalled();
  });

  it("respects an existing per-model threshold", async () => {
    window.localStorage.setItem(LEGACY_KEYS.model, "sonnet");
    mocks.getServerSettings.mockResolvedValue({
      settings: { clientDefaults: { compactAtContextPercent: { sonnet: 50 } } },
    });
    const { useSeedCompactThreshold } = await import(
      "../useSeedCompactThreshold"
    );
    renderHook(() => useSeedCompactThreshold());

    await waitFor(() => expect(mocks.getServerSettings).toHaveBeenCalled());
    expect(mocks.updateServerSettings).not.toHaveBeenCalled();
  });

  it("does nothing when already seeded (marker present)", async () => {
    window.localStorage.setItem(SEED_MARKER_KEY, "1");
    window.localStorage.setItem(LEGACY_KEYS.model, "opus");
    const { useSeedCompactThreshold } = await import(
      "../useSeedCompactThreshold"
    );
    renderHook(() => useSeedCompactThreshold());

    await Promise.resolve();
    expect(mocks.getServerSettings).not.toHaveBeenCalled();
    expect(mocks.updateServerSettings).not.toHaveBeenCalled();
  });

  it("does not run on the login page (unauthenticated)", async () => {
    mocks.isAuthenticated = false;
    window.localStorage.setItem(LEGACY_KEYS.model, "opus");
    const { useSeedCompactThreshold } = await import(
      "../useSeedCompactThreshold"
    );
    renderHook(() => useSeedCompactThreshold());

    await Promise.resolve();
    expect(mocks.updateServerSettings).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(SEED_MARKER_KEY)).toBeNull();
  });
});
