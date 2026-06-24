// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalSessionItem } from "../../api/client";
import { RecentSessionsDropdown } from "../RecentSessionsDropdown";

const { globalSessionsState } = vi.hoisted(() => ({
  globalSessionsState: {
    sessions: [] as GlobalSessionItem[],
  },
}));

vi.mock("../../hooks/useGlobalSessions", () => ({
  useGlobalSessions: () => ({
    sessions: globalSessionsState.sessions,
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

function session(
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id: "session-2",
    title: "Shortened title...",
    fullTitle:
      "Longer complete title text that should be visible in the recent sessions dropdown",
    createdAt: "2026-06-24T10:00:00.000Z",
    updatedAt: "2026-06-24T10:05:00.000Z",
    messageCount: 3,
    provider: "codex",
    projectId: "project-1",
    projectName: "yepanywhere",
    ownership: { owner: "none" },
    ...overrides,
  };
}

function triggerRef() {
  const element = document.createElement("button");
  element.getBoundingClientRect = () =>
    ({
      bottom: 48,
      height: 24,
      left: 120,
      right: 240,
      top: 24,
      width: 120,
      x: 120,
      y: 24,
      toJSON: () => ({}),
    }) as DOMRect;

  const ref = createRef<HTMLElement>();
  Object.defineProperty(ref, "current", {
    value: element,
  });
  return ref;
}

describe("RecentSessionsDropdown", () => {
  afterEach(() => {
    cleanup();
    globalSessionsState.sessions = [];
    document.body.replaceChildren();
  });

  it("renders the full title instead of the shortened list title", () => {
    globalSessionsState.sessions = [session()];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(
        "Longer complete title text that should be visible in the recent sessions dropdown",
      ),
    ).not.toBeNull();
    expect(screen.queryByText("Shortened title...")).toBeNull();
  });
});
