// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import {
  getTabTitleActivityPreference,
  useTabTitleActivityPreference,
} from "../useTabTitleActivityPreference";

describe("useTabTitleActivityPreference", () => {
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

  it("defaults to disabled", () => {
    const { result } = renderHook(() => useTabTitleActivityPreference());

    expect(result.current.tabTitleActivityEnabled).toBe(false);
  });

  it("reads stored preference", () => {
    localStorage.setItem(UI_KEYS.tabTitleActivityEnabled, "true");

    const { result } = renderHook(() => useTabTitleActivityPreference());

    expect(result.current.tabTitleActivityEnabled).toBe(true);
    expect(getTabTitleActivityPreference()).toEqual({ enabled: true });
  });

  it("persists and publishes updates to mounted consumers", () => {
    const { result: first } = renderHook(() =>
      useTabTitleActivityPreference(),
    );
    const { result: second } = renderHook(() =>
      useTabTitleActivityPreference(),
    );

    act(() => {
      first.current.setTabTitleActivityEnabled(true);
    });

    expect(first.current.tabTitleActivityEnabled).toBe(true);
    expect(second.current.tabTitleActivityEnabled).toBe(true);
    expect(localStorage.getItem(UI_KEYS.tabTitleActivityEnabled)).toBe("true");
  });
});
