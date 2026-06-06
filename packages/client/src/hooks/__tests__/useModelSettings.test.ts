import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_KEYS } from "../../lib/storageKeys";

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

describe("useModelSettings speech defaults", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    mocks.version = null;
    mocks.updateServerSettings.mockClear();
    vi.resetModules();
  });

  it("uses server speech defaults while local settings are unset", async () => {
    mocks.version = {
      clientDefaults: {
        speech: {
          voiceInputEnabled: false,
          speechMethod: "ya-grok",
        },
      },
    };
    const { useModelSettings } = await import("../useModelSettings");

    const { result } = renderHook(() => useModelSettings());

    expect(result.current.voiceInputEnabled).toBe(false);
    expect(result.current.speechMethod).toBe("ya-grok");
    expect(result.current.hasStoredSpeechMethod).toBe(true);
  });

  it("keeps local explicit speech choices over server defaults", async () => {
    window.localStorage.setItem(LEGACY_KEYS.speechMethod, "browser-native");
    mocks.version = {
      clientDefaults: {
        speech: {
          speechMethod: "ya-grok",
        },
      },
    };
    const { useModelSettings } = await import("../useModelSettings");

    const { result } = renderHook(() => useModelSettings());

    expect(result.current.speechMethod).toBe("browser-native");
    expect(result.current.hasStoredSpeechMethod).toBe(true);
  });

  it("stores speech selections as local choices and server defaults", async () => {
    const { useModelSettings } = await import("../useModelSettings");
    const { result } = renderHook(() => useModelSettings());

    act(() => result.current.setSpeechMethod("ya-grok"));

    expect(window.localStorage.getItem(LEGACY_KEYS.speechMethod)).toBe(
      "ya-grok",
    );
    expect(mocks.updateServerSettings).toHaveBeenCalledWith({
      clientDefaults: {
        speech: {
          speechMethod: "ya-grok",
        },
      },
    });
  });
});
