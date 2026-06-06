import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_STORAGE_DEFAULT } from "../../lib/defaultedStorage";
import { UI_KEYS } from "../../lib/storageKeys";

const mocks = vi.hoisted(() => ({
  updateServerSettings: vi.fn(async () => ({ settings: {} })),
  version: null as unknown,
}));

vi.mock("../../api/client", () => ({
  api: {
    updateServerSettings: mocks.updateServerSettings,
  },
}));

vi.mock("../useVersion", () => ({
  useVersion: () => ({
    version: mocks.version,
  }),
}));

function stubToolbarLayout(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe("useSessionToolbarVisibility", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    mocks.version = null;
    mocks.updateServerSettings.mockClear();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("ignores persisted model indicator visibility from old settings", async () => {
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarVisibility,
      JSON.stringify({
        modelIndicator: true,
        slashMenu: false,
      }),
    );
    const { DEFAULT_SESSION_TOOLBAR_VISIBILITY, useSessionToolbarVisibility } =
      await import("../useSessionToolbarVisibility");

    expect(DEFAULT_SESSION_TOOLBAR_VISIBILITY).not.toHaveProperty(
      "modelIndicator",
    );

    const { result } = renderHook(() => useSessionToolbarVisibility());

    expect(result.current.visibility).not.toHaveProperty("modelIndicator");
    expect(result.current.visibility.slashMenu).toBe(false);
  });

  it("keeps legacy boolean values as explicit choices", async () => {
    stubToolbarLayout(false);
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarVisibility,
      JSON.stringify({ microphone: false }),
    );
    const { useSessionToolbarVisibility } = await import(
      "../useSessionToolbarVisibility"
    );

    const { result } = renderHook(() => useSessionToolbarVisibility());

    expect(result.current.visibility.microphone).toBe(false);
  });

  it("resolves missing and defaulted controls from current defaults", async () => {
    stubToolbarLayout(true);
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarVisibility,
      JSON.stringify({
        slashMenu: false,
        microphone: CLIENT_STORAGE_DEFAULT,
      }),
    );
    const { useSessionToolbarVisibility } = await import(
      "../useSessionToolbarVisibility"
    );

    const { result } = renderHook(() => useSessionToolbarVisibility());

    expect(result.current.visibility.slashMenu).toBe(false);
    expect(result.current.visibility.microphone).toBe(true);
    expect(result.current.visibility.queueControls).toBe(true);
    expect(result.current.visibility.contextUsage).toBe(true);
  });

  it("resolves locally defaulted controls from server client defaults", async () => {
    stubToolbarLayout(false);
    mocks.version = {
      clientDefaults: {
        sessionToolbarVisibility: {
          renderMode: true,
          slashMenu: false,
        },
      },
    };
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarVisibility,
      JSON.stringify({ slashMenu: CLIENT_STORAGE_DEFAULT }),
    );
    const { useSessionToolbarVisibility } = await import(
      "../useSessionToolbarVisibility"
    );

    const { result } = renderHook(() => useSessionToolbarVisibility());

    await waitFor(() => {
      expect(result.current.visibility.renderMode).toBe(true);
      expect(result.current.visibility.slashMenu).toBe(false);
    });
  });

  it("keeps local explicit choices over server client defaults", async () => {
    stubToolbarLayout(false);
    mocks.version = {
      clientDefaults: {
        sessionToolbarVisibility: {
          slashMenu: false,
        },
      },
    };
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarVisibility,
      JSON.stringify({ slashMenu: true }),
    );
    const { useSessionToolbarVisibility } = await import(
      "../useSessionToolbarVisibility"
    );

    const { result } = renderHook(() => useSessionToolbarVisibility());

    await waitFor(() => {
      expect(result.current.visibility.slashMenu).toBe(true);
    });
  });

  it("defaults mic and queue controls visible on mobile", async () => {
    stubToolbarLayout(true);
    const { useSessionToolbarVisibility } = await import(
      "../useSessionToolbarVisibility"
    );

    const { result } = renderHook(() => useSessionToolbarVisibility());

    expect(result.current.visibility.microphone).toBe(true);
    expect(result.current.visibility.queueControls).toBe(true);
  });

  it("stores only explicit toolbar choices and reset returns to default", async () => {
    stubToolbarLayout(false);
    const { useSessionToolbarVisibility } = await import(
      "../useSessionToolbarVisibility"
    );
    const { result } = renderHook(() => useSessionToolbarVisibility());

    act(() => result.current.setControlVisible("slashMenu", false));

    expect(
      JSON.parse(
        window.localStorage.getItem(UI_KEYS.sessionToolbarVisibility) ?? "{}",
      ),
    ).toEqual({ slashMenu: false });
    expect(mocks.updateServerSettings).toHaveBeenCalledWith({
      clientDefaults: {
        sessionToolbarVisibility: { slashMenu: false },
      },
    });

    act(() => result.current.resetVisibility());

    expect(window.localStorage.getItem(UI_KEYS.sessionToolbarVisibility)).toBe(
      null,
    );
    expect(result.current.visibility.slashMenu).toBe(true);
  });
});
