// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  YA_GROK_BATCH_SPEECH_METHOD,
  XAI_DIRECT_STREAMING_SPEECH_METHOD,
} from "../../lib/speechProviders/methods";
import { NewSessionForm } from "../NewSessionForm";

const {
  mockNavigate,
  mockUpdateSetting,
  mockStartSession,
  mockStartDetachedSession,
  mockAddProject,
  mockCycleThinkingMode,
  mockSetEffortLevel,
  mockSetSpeechMethod,
  mockSetSpeechSmartTurnSettings,
  mockSetGrokSpeechAudioSettings,
  mockVoiceToggle,
  mockVoiceCancelProcessing,
  voicePropsState,
  draftKeys,
  modelSettingsState,
  providersState,
  serverSettingsState,
  versionState,
  remoteBasePathState,
  filterDropdownState,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockUpdateSetting: vi.fn(),
  mockStartSession: vi.fn(),
  mockStartDetachedSession: vi.fn(),
  mockAddProject: vi.fn(),
  mockCycleThinkingMode: vi.fn(),
  mockSetEffortLevel: vi.fn(),
  mockSetSpeechMethod: vi.fn(),
  mockSetSpeechSmartTurnSettings: vi.fn(),
  mockSetGrokSpeechAudioSettings: vi.fn(),
  mockVoiceToggle: vi.fn(),
  mockVoiceCancelProcessing: vi.fn(),
  voicePropsState: {
    current: null as null | {
      onPendingSpeechChange?: (
        kind: "listening" | "transcribing" | "finalizing" | null,
      ) => void;
      onInterimTranscript?: (text: string) => void;
    },
  },
  draftKeys: [] as string[],
  modelSettingsState: {
    thinkingMode: "off" as "off" | "auto" | "on",
    effortLevel: "high" as "low" | "medium" | "high" | "max",
    voiceInputEnabled: true,
    speechMethod: "browser-native",
    hasStoredSpeechMethod: false,
    speechSmartTurnSettings: {
      enabled: false,
      threshold: 0.95,
      timeoutMs: 3000,
    },
    grokSpeechAudioSettings: {
      uplinkMode: "pcm16" as "pcm16" | "browser-compressed",
    },
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
      supportsRecaps?: boolean;
      supportsNativeRecaps?: boolean;
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
        recapMode?: "off" | "native" | "side-session";
        promptSuggestionMode?: "off" | "native";
        helperSideModel?: string;
      };
      helperTargets?: Array<{
        id: string;
        name: string;
        kind: "openai-compatible";
        baseUrl: string;
        model?: string;
      }>;
    } | null,
    isLoading: true,
  },
  versionState: {
    version: null as {
      voiceBackends?: string[];
      voiceBackendCapabilities?: Record<
        string,
        { streaming?: boolean; smartTurn?: boolean }
      >;
    } | null,
  },
  remoteBasePathState: {
    basePath: "",
  },
  filterDropdownState: {
    selected: [] as string[],
  },
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
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
    const setDraft = useCallback(
      (nextValue: string) => setValue(nextValue),
      [],
    );
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
    setThinkingMode: vi.fn(),
    thinkingLevel: modelSettingsState.effortLevel,
    showThinking: "default",
    setShowThinking: vi.fn(),
    voiceInputEnabled: modelSettingsState.voiceInputEnabled,
    speechMethod: modelSettingsState.speechMethod,
    hasStoredSpeechMethod: modelSettingsState.hasStoredSpeechMethod,
    setSpeechMethod: mockSetSpeechMethod,
    speechSmartTurnSettings: modelSettingsState.speechSmartTurnSettings,
    setSpeechSmartTurnSettings: mockSetSpeechSmartTurnSettings,
    grokSpeechAudioSettings: modelSettingsState.grokSpeechAudioSettings,
    setGrokSpeechAudioSettings: mockSetGrokSpeechAudioSettings,
  }),
  getThinkingSetting: () =>
    modelSettingsState.thinkingMode === "off"
      ? "off"
      : modelSettingsState.thinkingMode === "auto"
        ? "auto"
        : `on:${modelSettingsState.effortLevel}`,
  getModelSetting: () => "opus",
  getShowThinkingSetting: () => "default",
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
    providers.filter(
      (provider) => provider.installed && provider.authenticated,
    ),
  getDefaultProvider: (providers: typeof providersState.providers) =>
    providers.find((provider) => provider.name === "claude") ??
    providers[0] ??
    null,
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => remoteBasePathState.basePath,
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

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: versionState.version,
    loading: false,
    error: null,
    refetch: vi.fn(),
    refetchFresh: vi.fn(),
  }),
}));

vi.mock("../../contexts/ToastContext", () => ({
  useToastContext: () => ({
    showToast: vi.fn(),
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      (
        ({
          effortLevelLowLabel: "Low",
          effortLevelMediumLabel: "Medium",
          effortLevelHighLabel: "High",
          effortLevelExtraLabel: "Extra",
          effortLevelExtraHighLabel: "Extra High",
          effortLevelMaxLabel: "Max",
          effortLevelLowDescription: "Fastest responses",
          effortLevelMediumDescription: "Moderate reasoning",
          effortLevelHighDescription: "Deep reasoning",
          effortLevelExtraDescription: "For your hardest tasks",
          effortLevelExtraHighDescription: "Extra-high reasoning",
          effortLevelMaxDescription: "Maximum effort",
        }) satisfies Record<string, string>
      )[key] ?? key,
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
  VoiceInputButton: forwardRef(
    (props: Record<string, unknown>, ref) => {
      voicePropsState.current = props as typeof voicePropsState.current;
      useImperativeHandle(
        ref,
        () => ({
          stopAndFinalize: () => "",
          toggle: mockVoiceToggle,
          cancelProcessing: mockVoiceCancelProcessing,
          isListening: false,
          isAvailable: true,
        }),
        [],
      );
      return <button type="button">voice</button>;
    },
  ),
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
        supportsRecaps: true,
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
        supportsRecaps: true,
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
    mockSetSpeechMethod.mockReset();
    mockSetSpeechSmartTurnSettings.mockReset();
    mockSetGrokSpeechAudioSettings.mockReset();
    mockVoiceToggle.mockReset();
    mockVoiceCancelProcessing.mockReset();
    voicePropsState.current = null;
    draftKeys.length = 0;
    remoteBasePathState.basePath = "";
    versionState.version = null;
    modelSettingsState.voiceInputEnabled = true;
    modelSettingsState.speechMethod = "browser-native";
    modelSettingsState.hasStoredSpeechMethod = false;
    modelSettingsState.speechSmartTurnSettings = {
      enabled: false,
      threshold: 0.95,
      timeoutMs: 3000,
    };
    modelSettingsState.grokSpeechAudioSettings = {
      uplinkMode: "pcm16",
    };
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
      expect(
        screen.getByRole("button", { name: "Codex" }).className,
      ).not.toContain("selected");
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
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledTimes(1);
    });

    expect(mockStartSession).toHaveBeenCalledWith(
      "project-1",
      "hello",
      expect.objectContaining({
        provider: "claude",
        model: "opus",
        promptSuggestionMode: "off",
      }),
      undefined,
      expect.any(Number),
    );
    expect(mockNavigate).toHaveBeenCalledWith(
      "/projects/project-1/sessions/session-1",
      expect.objectContaining({
        state: expect.objectContaining({
          initialStatus: {
            owner: "self",
            processId: "process-1",
            permissionMode: "default",
            modeVersion: 0,
          },
          initialProvider: "claude",
        }),
      }),
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

    const medium = screen.getByRole("radio", { name: "Medium" });
    expect(medium.className).toContain("active");

    fireEvent.click(screen.getByRole("radio", { name: "Low" }));

    expect(mockSetEffortLevel).toHaveBeenCalledWith("low");
  });

  it("does not show the display-only thinking preference in session setup", () => {
    modelSettingsState.thinkingMode = "on";

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(screen.getByText("modelSettingsThinkingTitle")).toBeDefined();
    expect(screen.queryByText("showThinkingTitle")).toBeNull();
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

  it("shows recent projects when opening a selected project chooser", () => {
    const { container } = render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const projectInput = screen.getByPlaceholderText(
      "newSessionProjectPathPlaceholder",
    ) as HTMLInputElement;
    expect(projectInput.value).toBe("/tmp/alpha");

    fireEvent.click(
      container.querySelector(".new-session-project-summary") as HTMLElement,
    );

    const shortcutNames = () =>
      Array.from(
        container.querySelectorAll(
          ".new-session-project-suggestions .new-session-project-option-name",
        ),
        (element) => element.textContent,
      );

    expect(shortcutNames()).toEqual([
      "newSessionProjectDetached",
      "Alpha",
      "Beta",
    ]);

    const projectOptions = container.querySelectorAll(
      ".new-session-project-suggestions .new-session-project-option",
    );
    expect(projectOptions[0]?.className).not.toContain("selected");
    expect(projectOptions[1]?.className).toContain("selected");

    fireEvent.change(projectInput, { target: { value: "Beta" } });

    expect(shortcutNames()).toEqual(["newSessionProjectDetached", "Beta"]);
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

  it("orders permission mode last among the config controls", async () => {
    serverSettingsState.isLoading = false;

    const { container } = render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("newSessionRecapTitle")).toBeDefined();
      expect(
        screen.getByText("newSessionPromptSuggestionsTitle"),
      ).toBeDefined();
    });

    // Permission mode is the tallest control, so it anchors the bottom as the
    // full-width last item rather than sitting above the helper controls.
    const headings = Array.from(
      container.querySelectorAll(".new-session-provider-slot h3"),
      (element) => element.textContent,
    );
    expect(headings.indexOf("newSessionModeTitle")).toBeGreaterThan(
      headings.indexOf("newSessionRecapTitle"),
    );
    expect(headings.indexOf("newSessionModeTitle")).toBeGreaterThan(
      headings.indexOf("newSessionPromptSuggestionsTitle"),
    );
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
    const { rerender } = render(
      <NewSessionForm projects={[...chooserProjects]} />,
    );

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
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

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
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

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

  it("toggles new-session voice input on Ctrl+Space", () => {
    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.keyDown(screen.getByPlaceholderText("newSessionPlaceholder"), {
      key: " ",
      code: "Space",
      ctrlKey: true,
    });

    expect(mockVoiceToggle).toHaveBeenCalledTimes(1);
  });

  it("keeps the new-session composer editable with a cancellable transcribing chip", async () => {
    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "newSessionPlaceholder",
    ) as HTMLTextAreaElement;

    expect(document.querySelector(".speech-processing-inline")).toBeNull();

    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
    });
    const badge = await waitFor(() => {
      const el = document.querySelector(".speech-processing-inline");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(badge.textContent).toContain("Transcribing");

    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: "typed while transcribing" } });
    expect(textarea.value).toBe("typed while transcribing");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(mockVoiceCancelProcessing).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(document.querySelector(".speech-processing-inline")).toBeNull();
    });
    expect(textarea.value).toBe("typed while transcribing");
  });

  it("hides a stored YA-routed Grok batch method from the method list", () => {
    versionState.version = {
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {
        "ya-grok": { streaming: true, smartTurn: true },
      },
    };
    modelSettingsState.speechMethod = "browser-native";
    modelSettingsState.hasStoredSpeechMethod = false;
    modelSettingsState.speechSmartTurnSettings = {
      enabled: true,
      threshold: 0.95,
      timeoutMs: 3000,
    };
    modelSettingsState.speechMethod = YA_GROK_BATCH_SPEECH_METHOD;
    modelSettingsState.hasStoredSpeechMethod = true;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.contextMenu(screen.getByText("voice"));
    expect(
      screen.queryByRole("radio", {
        name: /^Grok STT through YA batch Browser sends a complete compressed recording through YA to xAI\.$/,
      }),
    ).toBeNull();
    expect(
      screen.getByRole("radio", {
        name: /^Grok STT direct Browser streams PCM audio directly to xAI\.$/,
      }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("Smart Turn")).toBeDefined();

    fireEvent.click(
      screen.getByRole("radio", {
        name: /^Grok STT through YA Browser streams PCM audio through YA to xAI\.$/,
      }),
    );
    expect(mockSetSpeechMethod).toHaveBeenCalledWith("ya-grok");
  });

  it("shows Smart Turn for direct Grok streaming without server capabilities", () => {
    remoteBasePathState.basePath = "/ygraehl";
    versionState.version = {
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {},
    };
    modelSettingsState.speechMethod = XAI_DIRECT_STREAMING_SPEECH_METHOD;
    modelSettingsState.hasStoredSpeechMethod = true;
    modelSettingsState.speechSmartTurnSettings = {
      enabled: true,
      threshold: 0.95,
      timeoutMs: 3000,
    };

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.contextMenu(screen.getByText("voice"));

    expect(screen.getByText("Smart Turn")).toBeDefined();
    expect(screen.queryByText("Grok STT audio")).toBeNull();
  });

  it("hides a stored YA-routed Grok batch method in relay mode", () => {
    remoteBasePathState.basePath = "/ygraehl";
    versionState.version = {
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {
        "ya-grok": { streaming: true, smartTurn: true },
      },
    };
    modelSettingsState.speechMethod = YA_GROK_BATCH_SPEECH_METHOD;
    modelSettingsState.hasStoredSpeechMethod = true;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.contextMenu(screen.getByText("voice"));

    expect(
      screen.queryByRole("radio", {
        name: /^Grok STT through YA batch Browser sends a complete compressed recording through YA to xAI\.$/,
      }),
    ).toBeNull();
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
    expect(
      screen.queryByRole("button", {
        name: /promptSuggestionModeNative/,
      }),
    ).toBeNull();
    expect(screen.getByText("promptSuggestionNativeUnsupported")).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

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

  it("keeps native prompt suggestion preference across provider switches", async () => {
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        model: "opus",
        permissionMode: "default",
        promptSuggestionMode: "native",
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

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /promptSuggestionModeNative/ })
          .className,
      ).toContain("selected");
    });

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /promptSuggestionModeOff/ })
          .className,
      ).toContain("selected");
    });
    expect(
      screen.queryByRole("button", { name: /promptSuggestionModeNative/ }),
    ).toBeNull();
    expect(mockUpdateSetting).toHaveBeenCalledWith(
      "newSessionDefaults",
      expect.objectContaining({
        provider: "codex",
        promptSuggestionMode: "native",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /promptSuggestionModeNative/ })
          .className,
      ).toContain("selected");
    });
  });

  it("keeps simulated recaps available when native suggestions are unsupported", async () => {
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(
      screen.getByRole("button", { name: /recapModeSideSession/ }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", {
        name: /promptSuggestionModeNative/,
      }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /recapModeSideSession/ }),
    );
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-1",
        "hello",
        expect.objectContaining({
          provider: "codex",
          recapMode: "side-session",
          promptSuggestionMode: "off",
        }),
        undefined,
        expect.any(Number),
      );
    });
  });

  it("offers configured helper targets for side-session recaps", async () => {
    serverSettingsState.settings = {
      helperTargets: [
        {
          id: "local-vllm",
          name: "Local vLLM",
          kind: "openai-compatible",
          baseUrl: "http://localhost:8001/v1",
          model: "Qwen/Qwen3.6-27B",
        },
      ],
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /recapModeSideSession/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Local vLLM" }));
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-1",
        "hello",
        expect.objectContaining({
          recapMode: "side-session",
          helperSideModel: "helper-target:local-vllm",
        }),
        undefined,
        expect.any(Number),
      );
    });
  });
});
