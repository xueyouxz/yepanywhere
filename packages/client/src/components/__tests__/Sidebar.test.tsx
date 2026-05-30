// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../Sidebar";

const {
  globalSessionsState,
  mockGlobalLoadMore,
  mockStarredLoadMore,
  mockToggleExpanded,
  mockWindowOpen,
  starredSessionsState,
} = vi.hoisted(() => ({
  globalSessionsState: {
    sessions: [] as Array<Record<string, unknown>>,
    loading: false,
    hasMore: false,
    loadMore: vi.fn(),
  },
  starredSessionsState: {
    sessions: [] as Array<Record<string, unknown>>,
    loading: false,
    hasMore: false,
    loadMore: vi.fn(),
  },
  mockGlobalLoadMore: vi.fn(),
  mockStarredLoadMore: vi.fn(),
  mockToggleExpanded: vi.fn(),
  mockWindowOpen: vi.fn(),
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => null,
}));

vi.mock("../../hooks/useDrafts", () => ({
  useDrafts: () => new Set<string>(),
}));

vi.mock("../../hooks/useGlobalSessions", () => ({
  useGlobalSessions: (options?: { starred?: boolean }) =>
    options?.starred ? starredSessionsState : globalSessionsState,
}));

vi.mock("../../hooks/useNeedsAttentionBadge", () => ({
  useNeedsAttentionBadge: () => 0,
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "/remote/test",
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: [],
    },
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      (
        {
          actionExpandSidebar: "Expand sidebar",
          actionCloseSidebar: "Close sidebar",
          sidebarNewSession: "New Session",
          sidebarInbox: "Inbox",
          sidebarAllSessions: "All Sessions",
          sidebarProjects: "Projects",
          sidebarSettings: "Settings",
          sidebarSectionStarred: "Starred",
          sidebarSectionLast24Hours: "Last 24 Hours",
          sidebarSectionOlder: "Older",
          sidebarSectionExpand: "Expand",
          sidebarSectionCollapse: "Collapse",
          sidebarEmpty: "No sessions yet",
        } as Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("../AgentsNavItem", () => ({
  AgentsNavItem: () => null,
}));

vi.mock("../SessionListItem", () => ({
  SessionListItem: ({ title }: { title: string }) => <li>{title}</li>,
}));

function makeSession(id: string, updatedAt: string) {
  return {
    id,
    projectId: "project-1",
    projectName: "Project",
    title: `Session ${id}`,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "claude",
    isArchived: false,
    isStarred: false,
  };
}

describe("Sidebar collapsed toggle", () => {
  beforeEach(() => {
    mockToggleExpanded.mockReset();
    mockWindowOpen.mockReset();
    mockGlobalLoadMore.mockReset();
    mockStarredLoadMore.mockReset();
    globalSessionsState.sessions = [];
    globalSessionsState.loading = false;
    globalSessionsState.hasMore = false;
    globalSessionsState.loadMore = mockGlobalLoadMore;
    starredSessionsState.sessions = [];
    starredSessionsState.loading = false;
    starredSessionsState.hasMore = false;
    starredSessionsState.loadMore = mockStarredLoadMore;
    vi.stubGlobal("open", mockWindowOpen);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderSidebar() {
    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={true}
          onToggleExpanded={mockToggleExpanded}
        />
      </MemoryRouter>,
    );
  }

  it("expands the sidebar on a normal click", () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));

    expect(mockToggleExpanded).toHaveBeenCalledTimes(1);
    expect(mockWindowOpen).not.toHaveBeenCalled();
  });

  it("opens a new-session window on middle click", () => {
    renderSidebar();

    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    fireEvent.mouseDown(toggle, { button: 1 });
    toggle.dispatchEvent(
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );

    expect(mockToggleExpanded).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/new-session?sidebar=expanded",
      "_blank",
      "noopener",
    );
  });

  it("renders loaded sidebar sessions without a show-more gate", () => {
    globalSessionsState.sessions = Array.from({ length: 13 }, (_, index) =>
      makeSession(
        String(index + 1),
        new Date(Date.now() - index * 60_000).toISOString(),
      ),
    );

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Session 13")).toBeDefined();
    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("collapses and expands the last-24-hours bucket", () => {
    globalSessionsState.sessions = [
      makeSession("recent", new Date().toISOString()),
    ];

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse: Last 24 Hours" }),
    );
    expect(screen.queryByText("Session recent")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand: Last 24 Hours" }),
    );
    expect(screen.getByText("Session recent")).toBeDefined();
  });

  it("predictively loads the next page near the sidebar scroll end", async () => {
    globalSessionsState.sessions = [
      makeSession("recent", new Date().toISOString()),
    ];
    globalSessionsState.hasMore = true;

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mockGlobalLoadMore).toHaveBeenCalledTimes(1);
    });
  });
});
