// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composeTabTitle,
  stripTabTitlePrefixes,
  useNeedsAttentionBadge,
} from "../useNeedsAttentionBadge";

const { inboxState, preferenceState } = vi.hoisted(() => ({
  inboxState: {
    totalNeedsAttention: 0,
    totalActive: 0,
  },
  preferenceState: {
    tabTitleActivityEnabled: false,
    tabTitleActivityScope: "focused" as "focused" | "all",
  },
}));

vi.mock("../../contexts/InboxContext", () => ({
  useInboxContext: () => inboxState,
}));

vi.mock("../useTabTitleActivityPreference", () => ({
  useTabTitleActivityPreference: () => preferenceState,
}));

describe("tab title indicators", () => {
  beforeEach(() => {
    document.title = "Project - Session";
    inboxState.totalNeedsAttention = 0;
    inboxState.totalActive = 0;
    preferenceState.tabTitleActivityEnabled = false;
    preferenceState.tabTitleActivityScope = "focused";
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("composes attention and activity prefixes in stable order", () => {
    expect(composeTabTitle("Project", 2, "(*)")).toBe("(2) (*) Project");
  });

  it("strips known prefixes before recomposing", () => {
    expect(stripTabTitlePrefixes("(2) (*) Project")).toBe("Project");
    expect(stripTabTitlePrefixes("( ) (3) Project")).toBe("Project");
  });

  it("shows all-session activity when enabled and sessions are active", () => {
    inboxState.totalActive = 1;
    preferenceState.tabTitleActivityEnabled = true;
    preferenceState.tabTitleActivityScope = "all";

    renderHook(() => useNeedsAttentionBadge());

    expect(document.title).toBe("(*) Project - Session");
  });

  it("animates all-session activity every second", () => {
    vi.useFakeTimers();
    inboxState.totalActive = 1;
    preferenceState.tabTitleActivityEnabled = true;
    preferenceState.tabTitleActivityScope = "all";

    renderHook(() => useNeedsAttentionBadge());

    expect(document.title).toBe("(*) Project - Session");

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(document.title).toBe("( ) Project - Session");
  });

  it("does not show activity for focused scope yet", () => {
    inboxState.totalActive = 1;
    preferenceState.tabTitleActivityEnabled = true;
    preferenceState.tabTitleActivityScope = "focused";

    renderHook(() => useNeedsAttentionBadge());

    expect(document.title).toBe("Project - Session");
  });
});
