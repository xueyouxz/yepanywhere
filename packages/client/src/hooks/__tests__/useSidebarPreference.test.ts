// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import { useSidebarPreference } from "../useSidebarPreference";

describe("useSidebarPreference", () => {
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
    vi.unstubAllGlobals();
  });

  it("forces the initial state open without overwriting the saved preference", () => {
    localStorage.setItem(UI_KEYS.sidebarExpanded, "false");

    const { result } = renderHook(() => useSidebarPreference(true));

    expect(result.current.isExpanded).toBe(true);
    expect(localStorage.getItem(UI_KEYS.sidebarExpanded)).toBe("false");
  });
});
