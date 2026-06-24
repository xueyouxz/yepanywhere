// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_SCOPED_KEYS,
  serverKey,
  setCurrentInstallId,
} from "../../lib/storageKeys";
import { NewSessionPage } from "../NewSessionPage";

const { projectsState, recentSessionsState } = vi.hoisted(() => ({
  projectsState: {
    projects: [
      {
        id: "project-1",
        name: "Alpha",
        path: "/tmp/alpha",
        sessionCount: 3,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2026-04-23T10:00:00.000Z",
      },
      {
        id: "project-2",
        name: "Beta",
        path: "/tmp/beta",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2026-04-22T10:00:00.000Z",
      },
    ],
    loading: false,
    error: null as Error | null,
  },
  recentSessionsState: {
    recentSessions: [] as Array<{ projectId: string }>,
    isLoading: false,
    error: null as Error | null,
  },
}));

vi.mock("../../components/NewSessionForm", () => ({
  NewSessionForm: ({
    projectId,
    selectedProject,
    onProjectChange,
  }: {
    projectId?: string;
    selectedProject?: { name: string } | null;
    onProjectChange?: (projectId: string | null) => void;
  }) => (
    <div>
      <div data-testid="form-project-id">{projectId ?? "none"}</div>
      <div data-testid="form-project-name">
        {selectedProject?.name ?? "none"}
      </div>
      <button type="button" onClick={() => onProjectChange?.("project-2")}>
        Select Beta
      </button>
      <button type="button" onClick={() => onProjectChange?.(null)}>
        Select No Project
      </button>
    </div>
  ),
}));

vi.mock("../../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("../../hooks/useDocumentTitle", () => ({
  useDocumentTitle: vi.fn(),
}));

vi.mock("../../hooks/useProjects", () => ({
  useProjects: () => projectsState,
  useProject: (projectId: string | undefined) => {
    const project =
      projectsState.projects.find((candidate) => candidate.id === projectId) ??
      null;
    return {
      project,
      loading: Boolean(projectId) && !project,
      error: projectId && !project ? new Error("not found") : null,
    };
  },
}));

vi.mock("../../hooks/useRecentSessions", () => ({
  useRecentSessions: () => ({
    ...recentSessionsState,
    recordVisit: vi.fn(),
    clearRecents: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../layouts", () => ({
  MainContent: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  useNavigationLayout: () => ({
    openSidebar: vi.fn(),
    isWideScreen: true,
    toggleSidebar: vi.fn(),
    isSidebarCollapsed: false,
  }),
}));

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderPage(initialEntry: string) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/new-session"
          element={
            <>
              <NewSessionPage />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("NewSessionPage", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    const localStorageMock = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: localStorageMock,
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageMock,
    });
    setCurrentInstallId("test-install");
    window.localStorage.clear();
    projectsState.loading = false;
    recentSessionsState.recentSessions = [];
    recentSessionsState.isLoading = false;
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("uses the stored recent project when opened without a project", async () => {
    window.localStorage.setItem(
      serverKey("test-install", SERVER_SCOPED_KEYS.recentProject),
      "project-2",
    );

    renderPage("/new-session");

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/new-session?projectId=project-2",
      );
    });
    expect(screen.getByTestId("form-project-name").textContent).toBe("Beta");
  });

  it("records an explicit query project as the recent project", async () => {
    renderPage("/new-session?projectId=project-1");

    await waitFor(() => {
      expect(
        window.localStorage.getItem(
          serverKey("test-install", SERVER_SCOPED_KEYS.recentProject),
        ),
      ).toBe("project-1");
    });
  });

  it("stores dropdown project changes and updates the URL", async () => {
    renderPage("/new-session?detached=1");

    fireEvent.click(screen.getByRole("button", { name: "Select Beta" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/new-session?projectId=project-2",
    );
    expect(
      window.localStorage.getItem(
        serverKey("test-install", SERVER_SCOPED_KEYS.recentProject),
      ),
    ).toBe("project-2");
  });

  it("keeps an explicit detached selection instead of restoring recents", async () => {
    window.localStorage.setItem(
      serverKey("test-install", SERVER_SCOPED_KEYS.recentProject),
      "project-1",
    );
    renderPage("/new-session?projectId=project-1");

    fireEvent.click(screen.getByRole("button", { name: "Select No Project" }));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/new-session?detached=1",
      );
    });
    expect(screen.getByTestId("form-project-id").textContent).toBe("none");
  });
});
