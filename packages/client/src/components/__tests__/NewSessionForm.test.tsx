// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewSessionForm } from "../NewSessionForm";

const {
  mockNavigate,
  mockUpdateSetting,
  mockStartSession,
  mockStartDetachedSession,
  mockAddProject,
  mockCycleThinkingMode,
  mockSetEffortLevel,
  draftKeys,
  modelSettingsState,
  providersState,
  serverSettingsState,
  filterDropdownState,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockUpdateSetting: vi.fn(),
  mockStartSession: vi.fn(),
  mockStartDetachedSession: vi.fn(),
  mockAddProject: vi.fn(),
  mockCycleThinkingMode: vi.fn(),
  mockSetEffortLevel: vi.fn(),
  draftKeys: [] as string[],
  modelSettingsState: {
    thinkingMode: "off" as "off" | "auto" | "on",
    effortLevel: "high" as "low" | "medium" | "high" | "max",
  },
  providersState: {
    providers: [] as Array<{
      name: string;
      displayName: string;
      installed: boolean;
      authenticated: boolean;
      enabled?: boolean;
      supportsPermissionMode?: boolean;
      supportsThinkingToggle?: boolean;
      supportsNativePromptSuggestions?: boolean;
      models?: Array<{ id: string; name: string; description?: string }>;
    }>,
    loading: false,
  },
  serverSettingsState: {
    settings: null as {
      newSessionDefaults?: {
        provider?: "claude" | "codex";
        model?: string;
        permissionMode?: "default";
        promptSuggestionMode?: "off" | "native";
      };
    } | null,
    isLoading: true,
  },
  filterDropdownState: {
    selected: [] as string[],
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
    addProject: mockAddProject,
    startSession: mockStartSession,
    startDetachedSession: mockStartDetachedSession,
    createDetachedSession: vi.fn(),
    createSession: vi.fn(),
    queueMessage: vi.fn(),
  },
}));

vi.mock("../../hooks/useConnection", () => ({
  useConnection: () => ({
    upload: vi.fn(),
  }),
}));

vi.mock("../../hooks/useDraftPersistence", () => ({
  useDraftPersistence: (key: string) => {
    draftKeys.push(key);
    const [value, setValue] = useState("");
    const getDraft = useCallback(() => value, [value]);
    const setDraft = useCallback((nextValue: string) => setValue(nextValue), []);
    const flushDraft = useCallback(() => {}, []);
    const clearInput = useCallback(() => setValue(""), []);
    const clearDraft = useCallback(() => setValue(""), []);
    const restoreFromStorage = useCallback(() => {}, []);

    const controls = useMemo(
      () => ({
        getDraft,
        setDraft,
        flushDraft,
        clearInput,
        clearDraft,
        restoreFromStorage,
      }),
      [
        clearDraft,
        clearInput,
        flushDraft,
        getDraft,
        restoreFromStorage,
        setDraft,
      ],
    );

    return [value, setValue, controls] as const;
  },
}));

vi.mock("../../hooks/useModelSettings", () => ({
  useModelSettings: () => ({
    effortLevel: modelSettingsState.effortLevel,
    setEffortLevel: mockSetEffortLevel,
    thinkingMode: modelSettingsState.thinkingMode,
    cycleThinkingMode: mockCycleThinkingMode,
    thinkingLevel: modelSettingsState.effortLevel,
  }),
  getThinkingSetting: () =>
    modelSettingsState.thinkingMode === "off"
      ? "off"
      : modelSettingsState.thinkingMode === "auto"
        ? "auto"
        : `on:${modelSettingsState.effortLevel}`,
  getModelSetting: () => "opus",
  EFFORT_LEVEL_OPTIONS: [
    { value: "low", label: "Low", description: "Fastest responses" },
    { value: "medium", label: "Medium", description: "Moderate thinking" },
    { value: "high", label: "High", description: "Deep reasoning" },
    { value: "max", label: "Max", description: "Maximum effort" },
  ],
}));

vi.mock("../../hooks/useProviders", () => ({
  useProviders: () => providersState,
  getAvailableProviders: (providers: typeof providersState.providers) =>
    providers.filter((provider) => provider.installed && provider.authenticated),
  getDefaultProvider: (providers: typeof providersState.providers) =>
    providers.find((provider) => provider.name === "claude") ?? providers[0] ?? null,
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../hooks/useRemoteExecutors", () => ({
  useRemoteExecutors: () => ({
    executors: [],
    loading: false,
  }),
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: serverSettingsState.settings,
    isLoading: serverSettingsState.isLoading,
    error: null,
    updateSettings: vi.fn(),
    updateSetting: mockUpdateSetting,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../contexts/ToastContext", () => ({
  useToastContext: () => ({
    showToast: vi.fn(),
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../FilterDropdown", () => ({
  FilterDropdown: ({
    options,
    selected,
    onChange,
  }: {
    options: Array<{ value: string; label: string }>;
    selected: string[];
    onChange: (selected: string[]) => void;
  }) => {
    filterDropdownState.selected = selected;
    return (
      <div>
        <div data-testid="filter-selected">{selected[0] ?? ""}</div>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange([option.value])}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock("../../lib/newSessionPrefill", () => ({
  clearNewSessionPrefill: vi.fn(),
  getNewSessionPrefill: () => "",
}));

vi.mock("../VoiceInputButton", () => ({
  VoiceInputButton: () => <button type="button">voice</button>,
}));

const chooserProjects = [
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
] as const;

describe("NewSessionForm", () => {
  beforeEach(() => {
    providersState.providers = [
      {
        name: "claude",
        displayName: "Claude",
        installed: true,
        authenticated: true,
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsNativePromptSuggestions: true,
        models: [
          { id: "default", name: "Default" },
          { id: "opus", name: "Opus 4.8" },
        ],
      },
      {
        name: "codex",
        displayName: "Codex",
        installed: true,
        authenticated: true,
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsNativePromptSuggestions: false,
        models: [
          { id: "gpt-5.4", name: "GPT-5.4" },
          { id: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
        ],
      },
    ];
    providersState.loading = false;
    serverSettingsState.settings = null;
    serverSettingsState.isLoading = true;
    filterDropdownState.selected = [];
    modelSettingsState.thinkingMode = "off";
    modelSettingsState.effortLevel = "high";
    mockNavigate.mockReset();
    mockUpdateSetting.mockReset();
    mockStartSession.mockReset();
    mockStartDetachedSession.mockReset();
    mockAddProject.mockReset();
    mockCycleThinkingMode.mockReset();
    mockSetEffortLevel.mockReset();
    draftKeys.length = 0;
    mockStartSession.mockResolvedValue({
      sessionId: "session-1",
      processId: "process-1",
      projectId: "project-1",
      permissionMode: "default",
      modeVersion: 0,
    });
    mockStartDetachedSession.mockResolvedValue({
      sessionId: "session-detached",
      processId: "process-detached",
      projectId: "detached-project",
      permissionMode: "default",
      modeVersion: 0,
    });
    mockAddProject.mockResolvedValue({
      project: {
        id: "project-added",
        name: "added-project",
        path: "/tmp/added-project",
        sessionCount: 0,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps an explicit Claude selection when saved Codex defaults load later", async () => {
    const { rerender } = render(<NewSessionForm projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    expect(screen.getByRole("button", { name: "Claude" }).className).toContain(
      "selected",
    );
    expect(screen.getByTestId("filter-selected").textContent).toBe("opus");

    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "codex",
        model: "gpt-5.3-codex",
        permissionMode: "default",
      },
    };
    serverSettingsState.isLoading = false;

    rerender(<NewSessionForm projectId="project-1" />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Claude" }).className,
      ).toContain("selected");
      expect(screen.getByRole("button", { name: "Codex" }).className).not.toContain(
        "selected",
      );
      expect(screen.getByTestId("filter-selected").textContent).toBe("opus");
    });
  });

  it("does not reuse the Claude fallback model when switching to Codex", async () => {
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Codex" }).className).toContain(
        "selected",
      );
      expect(screen.getByTestId("filter-selected").textContent).toBe("gpt-5.4");
    });
  });

  it("submits the selected Claude provider and model to startSession", async () => {
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "codex",
        model: "gpt-5.3-codex",
        permissionMode: "default",
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Opus 4.8" }));
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "newSessionStartAction" }));

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledTimes(1);
    });

    expect(mockStartSession).toHaveBeenCalledWith(
      "project-1",
      "hello",
      expect.objectContaining({
        provider: "claude",
        model: "opus",
        promptSuggestionMode: "native",
      }),
      undefined,
      expect.any(Number),
    );
  });

  it("shows and updates the initial effort selector when thinking is on", () => {
    modelSettingsState.thinkingMode = "on";
    modelSettingsState.effortLevel = "medium";

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const medium = screen.getByRole("button", {
      name: "modelSettingsEffortTitle: Medium",
    });
    expect(medium.className).toContain("active");

    fireEvent.click(
      screen.getByRole("button", { name: "modelSettingsEffortTitle: Low" }),
    );

    expect(mockSetEffortLevel).toHaveBeenCalledWith("low");
  });

  it("shows detached and recent project choices in the default launcher", () => {
    render(<NewSessionForm projects={[...chooserProjects]} />);

    expect(
      screen.getByPlaceholderText("newSessionProjectPathPlaceholder"),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: /newSessionProjectDetached/i }),
    );

    expect(screen.getAllByText("newSessionProjectDetached")).toHaveLength(2);
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Beta").length).toBeGreaterThan(0);
  });

  it("uses visit recency and shows more than four project shortcuts", () => {
    const manyProjects = [
      ...chooserProjects,
      {
        id: "project-3",
        name: "Gamma",
        path: "/tmp/gamma",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2026-04-21T10:00:00.000Z",
      },
      {
        id: "project-4",
        name: "Delta",
        path: "/tmp/delta",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "project-5",
        name: "Epsilon",
        path: "/tmp/epsilon",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2026-04-19T10:00:00.000Z",
      },
      {
        id: "project-6",
        name: "Zeta",
        path: "/tmp/zeta",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2026-04-18T10:00:00.000Z",
      },
    ];

    const { container } = render(
      <NewSessionForm
        projects={manyProjects}
        recentProjectIds={["project-6", "project-5"]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /newSessionProjectDetached/i }),
    );

    const shortcutNames = Array.from(
      container.querySelectorAll(
        ".new-session-project-suggestions .new-session-project-option-name",
      ),
      (element) => element.textContent,
    );

    expect(shortcutNames).toEqual([
      "newSessionProjectDetached",
      "Zeta",
      "Epsilon",
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
    ]);
  });

  it("keeps attachment quality out of the bottom composer row", () => {
    render(<NewSessionForm projects={[...chooserProjects]} />);

    expect(screen.queryByRole("button", { name: "SD" })).toBeNull();
    expect(screen.queryByRole("button", { name: "HD" })).toBeNull();
  });

  it("keeps the drafted prompt when switching from detached to a project", async () => {
    const onProjectChange = vi.fn();

    render(
      <NewSessionForm
        projects={[...chooserProjects]}
        onProjectChange={onProjectChange}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "draft the migration plan" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /newSessionProjectDetached/i }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Alpha/i })[0]!);

    expect(onProjectChange).toHaveBeenCalledWith("project-1");
    expect(
      (
        screen.getByPlaceholderText(
          "newSessionPlaceholder",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("draft the migration plan");
  });

  it("keeps the same draft storage key when project selection changes", () => {
    const { rerender } = render(<NewSessionForm projects={[...chooserProjects]} />);

    rerender(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(new Set(draftKeys)).toEqual(new Set(["draft-new-session"]));
  });

  it("resolves a typed project path before starting the session", async () => {
    render(<NewSessionForm projects={[...chooserProjects]} />);

    fireEvent.change(
      screen.getByPlaceholderText("newSessionProjectPathPlaceholder"),
      {
        target: { value: "/tmp/added-project" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "newSessionStartAction" }));

    await waitFor(() => {
      expect(mockAddProject).toHaveBeenCalledWith("/tmp/added-project");
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-added",
        "hello",
        expect.any(Object),
        undefined,
        expect.any(Number),
      );
    });
  });

  it("starts a detached session when no project is selected", async () => {
    render(<NewSessionForm projects={[...chooserProjects]} />);

    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "newSessionStartAction" }));

    await waitFor(() => {
      expect(mockStartDetachedSession).toHaveBeenCalledWith(
        "hello",
        expect.any(Object),
        undefined,
        expect.any(Number),
      );
    });

    expect(mockStartSession).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith(
      "/projects/detached-project/sessions/session-detached",
      expect.any(Object),
    );
  });

  it("defaults prompt suggestions off when the provider lacks native support", async () => {
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    const nativeSuggestionButton = screen.getByRole("button", {
      name: /promptSuggestionModeNative/,
    });
    expect((nativeSuggestionButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "newSessionStartAction" }));

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-1",
        "hello",
        expect.objectContaining({
          provider: "codex",
          promptSuggestionMode: "off",
        }),
        undefined,
        expect.any(Number),
      );
    });
  });
});
