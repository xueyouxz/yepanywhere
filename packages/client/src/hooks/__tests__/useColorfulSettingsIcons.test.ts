// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import {
  getColorfulSettingsIcons,
  useColorfulSettingsIcons,
} from "../useColorfulSettingsIcons";

describe("useColorfulSettingsIcons", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("defaults to colorful icons", () => {
    const { result } = renderHook(() => useColorfulSettingsIcons());

    expect(result.current.colorfulSettingsIcons).toBe(true);
    expect(getColorfulSettingsIcons()).toBe(true);
  });

  it("reads stored monochrome preference", () => {
    localStorage.setItem(UI_KEYS.colorfulSettingsIcons, "false");

    const { result } = renderHook(() => useColorfulSettingsIcons());

    expect(result.current.colorfulSettingsIcons).toBe(false);
    expect(getColorfulSettingsIcons()).toBe(false);
  });

  it("persists and publishes updates", () => {
    const { result: first } = renderHook(() => useColorfulSettingsIcons());
    const { result: second } = renderHook(() => useColorfulSettingsIcons());

    act(() => {
      first.current.setColorfulSettingsIcons(false);
    });

    expect(first.current.colorfulSettingsIcons).toBe(false);
    expect(second.current.colorfulSettingsIcons).toBe(false);
    expect(localStorage.getItem(UI_KEYS.colorfulSettingsIcons)).toBe("false");
  });
});
