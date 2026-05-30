// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSessionsPage } from "../GlobalSessionsPage";

const {
  mockNavigate,
  mockSetNewSessionPrefill,
  globalSessionsState,
  mockLoadMore,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockSetNewSessionPrefill: vi.fn(),
  mockLoadMore: vi.fn(),
  globalSessionsState: {
    sessions: [] as unknown[],
    stats: {
      totalCount: 0,
      unreadCount: 0,
      starredCount: 0,
      archivedCount: 0,
      providerCounts: {},
      executorCounts: {},
    },
    projects: [
      {
        id: "project-1",
        name: "Alpha",
        path: "/tmp/alpha",
        sessionCount: 3,
        lastActivity: "2026-04-21T00:00:00.000Z",
      },
    ],
    loading: false,
    error: null as Error | null,
    hasMore: false,
    loadMore: vi.fn(),
  },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );

  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("../../api/client", () => ({
  api: {
    updateSessionMetadata: vi.fn(),
    markSessionSeen: vi.fn(),
    markSessionUnread: vi.fn(),
  },
}));

vi.mock("../../components/BulkActionBar", () => ({
  BulkActionBar: () => null,
}));

vi.mock("../../components/FilterDropdown", () => ({
  FilterDropdown: () => <div data-testid="filter-dropdown" />,
}));

vi.mock("../../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("../../components/SessionListItem", () => ({
  SessionListItem: () => <div>session-item</div>,
}));

vi.mock("../../hooks/useDrafts", () => ({
  useDrafts: () => new Set<string>(),
}));

vi.mock("../../hooks/useGlobalSessions", () => ({
  useGlobalSessions: () => globalSessionsState,
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        sidebarNewSession: "New Session",
        globalSessionsTitle: "All Sessions",
        globalSessionsSearchPlaceholder: "Search sessions...",
        globalSessionsFilterAgePlaceholder: "Any age",
        globalSessionsClearFilters: "Clear filters",
        globalSessionsStatusAll: "All",
        globalSessionsFilterProjectPlaceholder: "All projects",
        globalSessionsFilterStatus: "Status",
        globalSessionsFilterProvider: "Provider",
        globalSessionsProviderAll: "All providers",
        globalSessionsFilterExecutor: "Machine",
        globalSessionsFilterAge: "Age",
        inboxFilterProject: "Project",
        globalSessionsFilterMachinePlaceholder: "All machines",
        globalSessionsAge3Days: "Older than 3 days",
        globalSessionsAge7Days: "Older than 7 days",
        globalSessionsAge14Days: "Older than 14 days",
        globalSessionsAge30Days: "Older than 30 days",
        globalSessionsProjectCtaHint: "Open session for",
        globalSessionsProjectCtaPromptLabel: "First prompt",
        globalSessionsNoResultsTitle: "No sessions found",
        globalSessionsNoResultsEmpty:
          "Sessions from all your projects will appear here.",
        globalSessionsNoResultsFiltered:
          "Try adjusting your filters or search query.",
        sidebarLoadingSessions: "Loading sessions...",
        projectsErrorPrefix: "Projects error:",
      };
      let text = messages[key] ?? key;
      if (!vars) return text;
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
      return text;
    },
  }),
}));

vi.mock("../../layouts", () => ({
  useNavigationLayout: () => ({
    openSidebar: vi.fn(),
    isWideScreen: true,
    toggleSidebar: vi.fn(),
    isSidebarCollapsed: false,
  }),
}));

vi.mock("../../lib/newSessionPrefill", () => ({
  setNewSessionPrefill: mockSetNewSessionPrefill,
}));

describe("GlobalSessionsPage", () => {
  beforeEach(() => {
    globalSessionsState.sessions = [];
    globalSessionsState.projects = [
      {
        id: "project-1",
        name: "Alpha",
        path: "/tmp/alpha",
        sessionCount: 3,
        lastActivity: "2026-04-21T00:00:00.000Z",
      },
    ];
    globalSessionsState.loading = false;
    globalSessionsState.error = null;
    globalSessionsState.hasMore = false;
    globalSessionsState.loadMore = mockLoadMore;
    mockNavigate.mockReset();
    mockSetNewSessionPrefill.mockReset();
    mockLoadMore.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function renderPage(initialEntry: string) {
    render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/sessions" element={<GlobalSessionsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("shows the project CTA when arriving from the projects list", () => {
    renderPage("/sessions?project=project-1&source=projects");

    expect(screen.getAllByText("New Session")[0]).toBeDefined();
    expect(screen.getAllByText("Alpha")).toHaveLength(2);
    expect(screen.getByText("Open session for")).toBeDefined();
    expect(screen.getByRole("button", { name: "New Session" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "New Session" }));

    expect(mockSetNewSessionPrefill).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith(
      "/new-session?projectId=project-1",
    );
  });

  it("shows the project CTA for project-filtered views without a source hint", () => {
    renderPage("/sessions?project=project-1");

    expect(screen.getAllByText("New Session")[0]).toBeDefined();
    expect(screen.getAllByText("Alpha")).toHaveLength(2);
    expect(screen.getByText("Open session for")).toBeDefined();
    expect(screen.getByRole("button", { name: "New Session" })).toBeDefined();
  });

  it("prefills the new session from the active project search query", () => {
    renderPage("/sessions?project=project-1&q=fix%20login%20flow");

    expect(screen.getByText("First prompt")).toBeDefined();
    expect(screen.getByText("fix login flow")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "New Session" }));

    expect(mockSetNewSessionPrefill).toHaveBeenCalledWith("fix login flow");
    expect(mockNavigate).toHaveBeenCalledWith(
      "/new-session?projectId=project-1",
    );
  });
});
