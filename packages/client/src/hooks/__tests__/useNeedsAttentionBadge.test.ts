// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTabTitleActivityFrame,
  composeTabTitle,
  stripTabTitlePrefixes,
  TAB_TITLE_ACTIVITY_CADENCE_MS,
  useNeedsAttentionBadge,
} from "../useNeedsAttentionBadge";

const { inboxState, preferenceState } = vi.hoisted(() => ({
  inboxState: {
    totalNeedsAttention: 0,
    totalActive: 0,
  },
  preferenceState: {
    tabTitleActivityEnabled: false,
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
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("composes attention and activity prefixes in stable order", () => {
    expect(composeTabTitle("Project", 2, "(●)")).toBe("(2) (●) Project");
  });

  it("strips known prefixes before recomposing", () => {
    expect(stripTabTitlePrefixes("(2) (●) Project")).toBe("Project");
    expect(stripTabTitlePrefixes("(○) (3) Project")).toBe("Project");
    expect(stripTabTitlePrefixes("(2) (*) Project")).toBe("Project");
    expect(stripTabTitlePrefixes("( ) (3) Project")).toBe("Project");
  });

  it("derives activity frames from the configured cadence", () => {
    expect(getTabTitleActivityFrame(1000, 1000)).toBe("(●)");
    expect(
      getTabTitleActivityFrame(1000, 1000 + TAB_TITLE_ACTIVITY_CADENCE_MS),
    ).toBe("(○)");
    expect(
      getTabTitleActivityFrame(1000, 1000 + TAB_TITLE_ACTIVITY_CADENCE_MS * 2),
    ).toBe("(●)");
  });

  it("shows all-session activity when enabled and sessions are active", () => {
    inboxState.totalActive = 1;
    preferenceState.tabTitleActivityEnabled = true;

    renderHook(() => useNeedsAttentionBadge());

    expect(document.title).toBe("(●) Project - Session");
  });

  it("animates all-session activity on the configured cadence", () => {
    vi.useFakeTimers();
    inboxState.totalActive = 1;
    preferenceState.tabTitleActivityEnabled = true;

    renderHook(() => useNeedsAttentionBadge());

    expect(document.title).toBe("(●) Project - Session");

    act(() => {
      vi.advanceTimersByTime(TAB_TITLE_ACTIVITY_CADENCE_MS);
    });

    expect(document.title).toBe("(○) Project - Session");
  });

  it("does not show activity while disabled", () => {
    inboxState.totalActive = 1;
    preferenceState.tabTitleActivityEnabled = false;

    renderHook(() => useNeedsAttentionBadge());

    expect(document.title).toBe("Project - Session");
  });
});
