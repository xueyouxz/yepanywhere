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
import { UI_KEYS } from "../../lib/storageKeys";
import { Sidebar } from "../Sidebar";

const {
  globalSessionsState,
  mockGlobalLoadMore,
  mockRemoteConnectionState,
  mockStarredLoadMore,
  mockToggleExpanded,
  mockWindowOpen,
  newSessionDraftState,
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
  mockRemoteConnectionState: {
    value: null as null | { disconnect: ReturnType<typeof vi.fn> },
  },
  mockStarredLoadMore: vi.fn(),
  mockToggleExpanded: vi.fn(),
  mockWindowOpen: vi.fn(),
  newSessionDraftState: {
    hasDraft: false,
  },
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => mockRemoteConnectionState.value,
}));

vi.mock("../../contexts/InboxContext", () => ({
  useInboxContext: () => ({
    totalNeedsAttention: 0,
  }),
}));

vi.mock("../../hooks/useDrafts", () => ({
  useDrafts: () => new Set<string>(),
  useNewSessionDraft: () => newSessionDraftState.hasDraft,
}));

vi.mock("../../hooks/useGlobalSessions", () => ({
  useGlobalSessions: (options?: { starred?: boolean }) =>
    options?.starred ? starredSessionsState : globalSessionsState,
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "/remote/test",
}));

vi.mock("../../hooks/usePublicShareStatus", () => ({
  usePublicShareStatus: () => ({
    status: null,
  }),
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: {
      publicSharesEnabled: false,
    },
  }),
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
        ({
          actionExpandSidebar: "Expand sidebar",
          actionCloseSidebar: "Close sidebar",
          sidebarNewSession: "New Session",
          sidebarInbox: "Inbox",
          sidebarAllSessions: "All Sessions",
          sidebarProjects: "Projects",
          sidebarSettings: "Settings",
          sidebarSwitchHost: "Switch Host",
          sidebarSectionStarred: "Starred",
          sidebarSectionLast24Hours: "Last 24 Hours",
          sidebarSectionOlder: "Older",
          sidebarSectionExpand: "Expand",
          sidebarSectionCollapse: "Collapse",
          sidebarEmpty: "No sessions yet",
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("../AgentsNavItem", () => ({
  AgentsNavItem: () => null,
}));

vi.mock("../SessionListItem", () => ({
  SessionListItem: ({
    sessionId,
    title,
  }: {
    sessionId: string;
    title: string;
  }) => <li data-testid={`session-${sessionId}`}>{title}</li>,
}));

function makeSession(
  id: string,
  updatedAt: string,
  overrides: Record<string, unknown> = {},
) {
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
    ...overrides,
  };
}

/** Render order (top → bottom) of the rendered rows in the Last 24 Hours list. */
function last24HourIds(container: HTMLElement): string[] {
  const list = container.querySelector("#sidebar-last-24-hours-list");
  if (!list) return [];
  return Array.from(list.querySelectorAll("[data-testid^='session-']")).map(
    (el) => el.getAttribute("data-testid")?.replace("session-", "") ?? "",
  );
}

describe("Sidebar collapsed toggle", () => {
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
    mockToggleExpanded.mockReset();
    mockWindowOpen.mockReset();
    mockRemoteConnectionState.value = null;
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
    newSessionDraftState.hasDraft = false;
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

  it("renders the relay Switch Host with the standard nav-item representation", () => {
    mockRemoteConnectionState.value = { disconnect: vi.fn() };

    renderSidebar();

    // Switch Host must share the exact representation of standard nav items
    // (a `.sidebar-nav-item` with a `.sidebar-nav-text` label) so it inherits
    // the shared `.sidebar-collapsed .sidebar-nav-text { display: none }` rule
    // in the mini rail, rather than relying on a bespoke per-item guard. The
    // visual icon-only outcome is a CSS concern, verified at the browser level.
    const switchHost = screen.getByRole("button", { name: "Switch Host" });
    expect(switchHost.classList.contains("sidebar-nav-item")).toBe(true);
    const label = switchHost.querySelector(".sidebar-nav-text");
    expect(label?.textContent).toBe("Switch Host");
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

  it("keeps the highest-message duplicate session visible", () => {
    const sharedTitle = "Repeated session";
    const now = Date.now();
    globalSessionsState.sessions = [
      makeSession("thin", new Date(now).toISOString(), {
        title: sharedTitle,
        fullTitle: sharedTitle,
        messageCount: 1,
      }),
      makeSession("substantive", new Date(now - 60_000).toISOString(), {
        title: sharedTitle,
        fullTitle: sharedTitle,
        messageCount: 12,
      }),
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

    expect(screen.getByTestId("session-substantive")).toBeDefined();
    expect(screen.queryByTestId("session-thin")).toBeNull();
  });

  it("shows a draft badge on the new session action", () => {
    newSessionDraftState.hasDraft = true;

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

    expect(screen.getByRole("link", { name: /New Session/i })).toBeDefined();
    expect(screen.getByText("Draft")).toBeDefined();
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

  it("collapses and expands the starred bucket", () => {
    starredSessionsState.sessions = [
      makeSession("starred", new Date().toISOString()),
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

    fireEvent.click(screen.getByRole("button", { name: "Collapse: Starred" }));
    expect(screen.queryByText("Session starred")).toBeNull();
    expect(
      JSON.parse(
        window.localStorage.getItem(UI_KEYS.sidebarSectionExpansion) ?? "{}",
      ).starred,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Expand: Starred" }));
    expect(screen.getByText("Session starred")).toBeDefined();
    expect(
      JSON.parse(
        window.localStorage.getItem(UI_KEYS.sidebarSectionExpansion) ?? "{}",
      ).starred,
    ).toBe(true);
  });

  it("initializes sidebar section collapse state from localStorage", () => {
    const now = Date.now();
    starredSessionsState.sessions = [
      makeSession("starred", new Date(now).toISOString()),
    ];
    globalSessionsState.sessions = [
      makeSession("recent", new Date(now).toISOString()),
      makeSession("older", new Date(now - 48 * 60 * 60 * 1000).toISOString()),
    ];
    window.localStorage.setItem(
      UI_KEYS.sidebarSectionExpansion,
      JSON.stringify({ starred: false, recentDay: false, older: false }),
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

    expect(
      screen.getByRole("button", { name: "Expand: Starred" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Expand: Last 24 Hours" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Expand: Older" })).toBeDefined();
    expect(screen.queryByText("Session starred")).toBeNull();
    expect(screen.queryByText("Session recent")).toBeNull();
    expect(screen.queryByText("Session older")).toBeNull();
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

  // Active sessions (activity = in-turn / waiting-input) are pinned above idle
  // rows in a stable order, and never run through the recency sort or the
  // duplicate-title grouping. See topics/sidebar-session-ordering.md.
  describe("active session ordering", () => {
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms).toISOString();

    function renderExpanded() {
      return render(
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
    }

    it("pins active sessions above idle sessions", () => {
      globalSessionsState.sessions = [
        makeSession("idle-old", ago(3 * 60_000)),
        makeSession("active-1", ago(60_000), { activity: "in-turn" }),
        makeSession("idle-new", ago(30_000)),
      ];

      const { container } = renderExpanded();

      // active first, then idle sorted by recency (newest idle before oldest).
      expect(last24HourIds(container)).toEqual([
        "active-1",
        "idle-new",
        "idle-old",
      ]);
    });

    it("keeps active sessions in input order, not sorted by updatedAt", () => {
      // Input order [A, B] but B has the newer updatedAt. A recency sort would
      // flip them to [B, A]; the active group must preserve the stable input
      // order the data hook hands down.
      globalSessionsState.sessions = [
        makeSession("active-A", ago(10_000), { activity: "in-turn" }),
        makeSession("active-B", ago(5_000), { activity: "in-turn" }),
      ];

      const { container } = renderExpanded();

      expect(last24HourIds(container)).toEqual(["active-A", "active-B"]);
    });

    it("treats waiting-input as active and pins it above newer idle rows", () => {
      globalSessionsState.sessions = [
        makeSession("idle-new", ago(10_000)),
        makeSession("waiting", ago(5 * 60_000), { activity: "waiting-input" }),
      ];

      const { container } = renderExpanded();

      // 'waiting' has an older updatedAt but is active, so it sits on top.
      expect(last24HourIds(container)).toEqual(["waiting", "idle-new"]);
    });

    it("never hides active sessions that share a duplicate title", () => {
      const shared = "Repeated session";
      globalSessionsState.sessions = [
        makeSession("active-thin", ago(60_000), {
          activity: "in-turn",
          title: shared,
          fullTitle: shared,
          messageCount: 1,
        }),
        makeSession("active-fat", ago(120_000), {
          activity: "in-turn",
          title: shared,
          fullTitle: shared,
          messageCount: 20,
        }),
      ];

      renderExpanded();

      // Both remain visible — the dedup expander must not swallow live work.
      expect(screen.getByTestId("session-active-thin")).toBeDefined();
      expect(screen.getByTestId("session-active-fat")).toBeDefined();
    });

    it("renders the section for an active-only recent list", () => {
      globalSessionsState.sessions = [
        makeSession("active-only", ago(1_000), { activity: "in-turn" }),
      ];

      renderExpanded();

      expect(
        screen.getByRole("button", { name: "Collapse: Last 24 Hours" }),
      ).toBeDefined();
      expect(screen.getByTestId("session-active-only")).toBeDefined();
      // The empty-state copy must not appear when only active rows exist.
      expect(screen.queryByText("sidebarNoSessions")).toBeNull();
    });

    it("dedups idle duplicates while leaving active duplicates intact", () => {
      const activeTitle = "Active dup";
      const idleTitle = "Idle dup";
      globalSessionsState.sessions = [
        makeSession("active-dup-1", ago(1_000), {
          activity: "in-turn",
          title: activeTitle,
          fullTitle: activeTitle,
          messageCount: 1,
        }),
        makeSession("active-dup-2", ago(2_000), {
          activity: "in-turn",
          title: activeTitle,
          fullTitle: activeTitle,
          messageCount: 9,
        }),
        makeSession("idle-dup-keep", ago(3_000), {
          title: idleTitle,
          fullTitle: idleTitle,
          messageCount: 9,
        }),
        makeSession("idle-dup-hide", ago(4_000), {
          title: idleTitle,
          fullTitle: idleTitle,
          messageCount: 1,
        }),
      ];

      const { container } = renderExpanded();

      // Both active duplicates stay; only the lower-message idle duplicate is
      // hidden. Active rows render above the surviving idle row.
      expect(screen.getByTestId("session-active-dup-1")).toBeDefined();
      expect(screen.getByTestId("session-active-dup-2")).toBeDefined();
      expect(screen.getByTestId("session-idle-dup-keep")).toBeDefined();
      expect(screen.queryByTestId("session-idle-dup-hide")).toBeNull();
      expect(last24HourIds(container)).toEqual([
        "active-dup-1",
        "active-dup-2",
        "idle-dup-keep",
      ]);
    });
  });
});
