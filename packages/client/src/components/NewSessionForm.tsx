import {
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  PROMPT_SUGGESTION_MODES,
  type ModelInfo,
  type PromptSuggestionMode,
  type ProviderName,
  type RecapMode,
  resolveModel,
} from "@yep-anywhere/shared";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { type UploadedFile, api } from "../api/client";
import { ENTER_SENDS_MESSAGE } from "../constants";
import { useToastContext } from "../contexts/ToastContext";
import { useConnection } from "../hooks/useConnection";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import {
  getModelSetting,
  getThinkingSetting,
  useModelSettings,
} from "../hooks/useModelSettings";
import {
  getAvailableProviders,
  getDefaultProvider,
  useProviders,
} from "../hooks/useProviders";
import {
  getAttachmentUploadLongEdgePx,
  useAttachmentUploadQuality,
} from "../hooks/useAttachmentUploadQuality";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useRemoteExecutors } from "../hooks/useRemoteExecutors";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import {
  getEffortLevelLabel,
  getEffortLevelOptions,
  resolveSupportedEffortLevel,
} from "../lib/effortLevels";
import { prepareImageUpload } from "../lib/imageAttachmentResize";
import { hasCoarsePointer } from "../lib/deviceDetection";
import { logSessionUiTrace } from "../lib/diagnostics/uiTrace";
import { helperTargetsToModelOptions } from "../lib/helperTargets";
import {
  clearNewSessionPrefill,
  getNewSessionPrefill,
} from "../lib/newSessionPrefill";
import {
  getEstimatedServerOffsetMs,
  getServerClockTimestamp,
  measureServerLatencyMs,
  recordServerClockSample,
} from "../lib/serverClock";
import { createSessionNavigationState } from "../lib/sessionNavigationState";
import {
  getSpeechMethods,
  isSpeechMethodId,
  resolveSpeechMethod,
  type SpeechMethodId,
} from "../lib/speechProviders/methods";
import type {
  SpeechSmartTurnSettings,
  SpeechTranscriptionContext,
  SpeechTranscriptionResultMetadata,
} from "../lib/speechProviders/SpeechProvider";
import { appendSpeechTranscript } from "../lib/speechRecognition";
import { isVoiceInputShortcut } from "../lib/voiceInputShortcut";
import { useVersion } from "../hooks/useVersion";
import { shortenPath } from "../lib/text";
import type { PermissionMode, Project } from "../types";
import { FilterDropdown, type FilterOption } from "./FilterDropdown";
import { SpeechGrokAudioControls } from "./SpeechGrokAudioControls";
import { SpeechSmartTurnControls } from "./SpeechSmartTurnControls";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";

interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string;
}

const MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];
const RECAP_MODE_ORDER: RecapMode[] = ["off", "native", "side-session"];
const PROMPT_SUGGESTION_MODE_ORDER: PromptSuggestionMode[] = [
  ...PROMPT_SUGGESTION_MODES,
];
const NEW_SESSION_DRAFT_KEY = "draft-new-session";
const QUICK_PROJECT_COUNT = 10;
const PROJECT_SUGGESTION_COUNT = 10;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  if (bytes < 1024 * 1024 * 1024)
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
  return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10}\u202fgb`;
}

function createClientSpeechTurnId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `speech-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getPreferredModelId(
  models: ModelInfo[],
  preferredModelId?: string | null,
) {
  if (preferredModelId) {
    const matchingPreferredModel = models.find(
      (m) => m.id === preferredModelId,
    );
    if (matchingPreferredModel) return matchingPreferredModel.id;
  }

  return models[0]?.id ?? null;
}

function getPreferredProviderModelId(
  providerName: ProviderName,
  models: ModelInfo[],
  defaults?: {
    provider?: ProviderName;
    model?: string;
  } | null,
) {
  const sessionDefaultModel =
    defaults?.provider === providerName ? defaults.model : undefined;
  const legacyClaudeFallbackModel =
    providerName === "claude" ? resolveModel(getModelSetting()) : undefined;

  return getPreferredModelId(
    models,
    sessionDefaultModel ?? legacyClaudeFallbackModel,
  );
}

function providerSupportsRecapMode(
  provider:
    | {
        supportsRecaps?: boolean;
        supportsNativeRecaps?: boolean;
      }
    | null
    | undefined,
  mode: RecapMode,
): boolean {
  if (mode === "off") return true;
  if (mode === "native") return provider?.supportsNativeRecaps === true;
  return provider?.supportsRecaps === true;
}

function getDefaultRecapMode(
  provider:
    | {
        supportsRecaps?: boolean;
        supportsNativeRecaps?: boolean;
      }
    | null
    | undefined,
  defaults?: { recapMode?: RecapMode } | null,
): RecapMode {
  if (
    defaults?.recapMode &&
    providerSupportsRecapMode(provider, defaults.recapMode)
  ) {
    return defaults.recapMode;
  }
  return provider?.supportsNativeRecaps ? "native" : "off";
}

function providerSupportsPromptSuggestionMode(
  provider: { supportsNativePromptSuggestions?: boolean } | null | undefined,
  mode: PromptSuggestionMode,
): boolean {
  if (mode === "off") return true;
  return provider?.supportsNativePromptSuggestions === true;
}

function getDefaultPromptSuggestionMode(
  provider: { supportsNativePromptSuggestions?: boolean } | null | undefined,
  defaults?: { promptSuggestionMode?: PromptSuggestionMode } | null,
): PromptSuggestionMode {
  if (
    defaults?.promptSuggestionMode &&
    providerSupportsPromptSuggestionMode(
      provider,
      defaults.promptSuggestionMode,
    )
  ) {
    return defaults.promptSuggestionMode;
  }
  return "off";
}

function getDefaultHelperSideModel(
  models: ModelInfo[],
  defaults?: { helperSideModel?: string } | null,
): string {
  const defaultModel = defaults?.helperSideModel;
  if (
    defaultModel &&
    (defaultModel === HELPER_SIDE_MODEL_CHEAPEST ||
      defaultModel === HELPER_SIDE_MODEL_SAME_AS_MAIN ||
      models.some((model) => model.id === defaultModel))
  ) {
    return defaultModel;
  }
  return HELPER_SIDE_MODEL_CHEAPEST;
}

function getProjectSortValue(project: Project): number {
  return project.lastActivity ? new Date(project.lastActivity).getTime() : 0;
}

function sortProjectsForChooser(
  projects: readonly Project[],
  recentProjectIds: readonly string[] = [],
): Project[] {
  const recentRanks = new Map(
    recentProjectIds.map((projectId, index) => [projectId, index]),
  );

  return [...projects].sort((a, b) => {
    const recentRankA = recentRanks.get(a.id) ?? Number.POSITIVE_INFINITY;
    const recentRankB = recentRanks.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (recentRankA !== recentRankB) return recentRankA - recentRankB;

    const activityDiff = getProjectSortValue(b) - getProjectSortValue(a);
    if (activityDiff !== 0) return activityDiff;
    const nameDiff = a.name.localeCompare(b.name);
    if (nameDiff !== 0) return nameDiff;
    return a.path.localeCompare(b.path);
  });
}

function normalizeProjectInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 1 && /[/\\]$/.test(trimmed)) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

function findProjectByInput(
  projects: readonly Project[],
  candidate: string,
): Project | null {
  const normalizedCandidate = normalizeProjectInput(candidate);
  if (!normalizedCandidate) return null;

  const exactPathMatch = projects.find(
    (project) => project.path === normalizedCandidate,
  );
  if (exactPathMatch) return exactPathMatch;

  const exactNameMatches = projects.filter(
    (project) =>
      project.name.toLowerCase() === normalizedCandidate.toLowerCase(),
  );
  if (exactNameMatches.length === 1) {
    return exactNameMatches[0] ?? null;
  }

  return null;
}

export interface NewSessionFormProps {
  projectId?: string;
  selectedProject?: Project | null;
  projects?: Project[];
  recentProjectIds?: string[];
  projectsLoading?: boolean;
  onProjectChange?: (projectId: string | null) => void;
  /** Whether to focus the textarea on mount (default: true) */
  autoFocus?: boolean;
  /** Number of rows for the textarea (default: 6) */
  rows?: number;
  /** Placeholder text for the textarea */
  placeholder?: string;
  /** Compact mode: no header, no mode selector (default: false) */
  compact?: boolean;
}

export function NewSessionForm({
  projectId,
  selectedProject,
  projects = [],
  recentProjectIds = [],
  projectsLoading = false,
  onProjectChange,
  autoFocus = true,
  rows = 6,
  placeholder,
  compact = false,
}: NewSessionFormProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const [message, setMessage, draftControls] = useDraftPersistence(
    NEW_SESSION_DRAFT_KEY,
  );
  const [mode, setMode] = useState<PermissionMode>("default");
  const [selectedProvider, setSelectedProvider] = useState<ProviderName | null>(
    null,
  );
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedRecapMode, setSelectedRecapMode] = useState<RecapMode>("off");
  const [selectedPromptSuggestionMode, setSelectedPromptSuggestionMode] =
    useState<PromptSuggestionMode>("off");
  const [helperSideModel, setHelperSideModel] = useState<string>(
    HELPER_SIDE_MODEL_CHEAPEST,
  );
  // null = local, string = remote host
  const [selectedExecutor, setSelectedExecutor] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, { uploaded: number; total: number }>
  >({});
  const [attachmentQuality] = useAttachmentUploadQuality();
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isSavingDefaults, setIsSavingDefaults] = useState(false);
  const [isProjectChooserExpanded, setIsProjectChooserExpanded] =
    useState(false);
  const [projectInput, setProjectInput] = useState(
    () => selectedProject?.path ?? "",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  const speechTurnIdRef = useRef<string | null>(null);
  const hasInitializedDefaultsRef = useRef(false);
  const hasUserCustomizedDefaultsRef = useRef(false);
  const lastSyncedProjectIdRef = useRef<string | null>(null);

  // Thinking toggle state
  const {
    effortLevel,
    setEffortLevel,
    thinkingMode,
    cycleThinkingMode,
    voiceInputEnabled,
    speechMethod,
    hasStoredSpeechMethod,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
    grokSpeechAudioSettings,
    setGrokSpeechAudioSettings,
  } = useModelSettings();

  // Connection for uploads (uses WebSocket when enabled)
  const connection = useConnection();

  // Server version for voiceBackends advertisement
  const { version: versionInfo } = useVersion();

  // Toast for error messages
  const { showToast } = useToastContext();

  // Fetch available providers
  const { providers, loading: providersLoading } = useProviders();
  const {
    settings,
    isLoading: settingsLoading,
    updateSetting: updateServerSetting,
  } = useServerSettings();

  // Fetch remote executors
  const { executors: remoteExecutors, loading: executorsLoading } =
    useRemoteExecutors();
  const availableProviders = getAvailableProviders(providers);
  const resolvedPlaceholder = placeholder ?? t("newSessionPlaceholder");
  const modeLabels: Record<PermissionMode, string> = {
    default: t("modeDefaultLabel"),
    acceptEdits: t("modeAcceptEditsLabel"),
    plan: t("modePlanLabel"),
    bypassPermissions: t("modeBypassPermissionsLabel"),
  };
  const modeDescriptions: Record<PermissionMode, string> = {
    default: t("modeDefaultDescription"),
    acceptEdits: t("modeAcceptEditsDescription"),
    plan: t("modePlanDescription"),
    bypassPermissions: t("modeBypassPermissionsDescription"),
  };
  const recapModeLabels: Record<RecapMode, string> = {
    off: t("recapModeOff"),
    native: t("recapModeNative"),
    "side-session": t("recapModeSideSession"),
  };
  const recapModeDescriptions: Record<RecapMode, string> = {
    off: t("recapModeOffDescription"),
    native: t("recapModeNativeDescription"),
    "side-session": t("recapModeSideSessionDescription"),
  };
  const promptSuggestionModeLabels: Record<PromptSuggestionMode, string> = {
    off: t("promptSuggestionModeOff"),
    native: t("promptSuggestionModeNative"),
  };
  const promptSuggestionModeDescriptions: Record<PromptSuggestionMode, string> =
    {
      off: t("promptSuggestionModeOffDescription"),
      native: t("promptSuggestionModeNativeDescription"),
    };

  // Get models and capabilities for the currently selected provider
  const selectedProviderInfo = providers.find(
    (p) => p.name === selectedProvider,
  );
  const availableModels: ModelInfo[] = selectedProviderInfo?.models ?? [];
  const helperTargetModelOptions = useMemo(
    () => helperTargetsToModelOptions(settings?.helperTargets),
    [settings?.helperTargets],
  );
  const helperSelectableModels = useMemo(
    () => [...helperTargetModelOptions, ...availableModels],
    [availableModels, helperTargetModelOptions],
  );
  const helperSideModelOptions: FilterOption<string>[] = useMemo(
    () => [
      {
        value: HELPER_SIDE_MODEL_CHEAPEST,
        label: t("helperSideModelCheapest"),
      },
      {
        value: HELPER_SIDE_MODEL_SAME_AS_MAIN,
        label: t("helperSideModelSameAsMain"),
        description: selectedModel ?? undefined,
      },
      ...helperSelectableModels.map((model) => ({
        value: model.id,
        label: model.name,
        description: model.description,
      })),
    ],
    [helperSelectableModels, selectedModel, t],
  );
  // Default to true for backwards compatibility with providers that don't set these flags
  const supportsPermissionMode =
    selectedProviderInfo?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    selectedProviderInfo?.supportsThinkingToggle ?? true;
  const selectedModelInfo = availableModels.find(
    (model) => model.id === selectedModel,
  );
  const effortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider: selectedProviderInfo,
        model: selectedModelInfo,
      }),
    [selectedModelInfo, selectedProviderInfo],
  );
  const effectiveEffortLevel = resolveSupportedEffortLevel(
    effortLevel,
    effortOptions,
  );
  const effectiveEffortLabel = getEffortLevelLabel(
    effectiveEffortLevel,
    selectedProviderInfo,
  );
  const selectedProviderDisplayName =
    selectedProviderInfo?.displayName ?? selectedProvider ?? "";
  const availableRecapModes = RECAP_MODE_ORDER.filter((modeValue) =>
    providerSupportsRecapMode(selectedProviderInfo, modeValue),
  );
  const availablePromptSuggestionModes = PROMPT_SUGGESTION_MODE_ORDER.filter(
    (modeValue) =>
      providerSupportsPromptSuggestionMode(selectedProviderInfo, modeValue),
  );
  const sortedProjects = useMemo(
    () => sortProjectsForChooser(projects, recentProjectIds),
    [projects, recentProjectIds],
  );
  const quickProjects = useMemo(
    () => sortedProjects.slice(0, QUICK_PROJECT_COUNT),
    [sortedProjects],
  );
  const normalizedProjectInput = normalizeProjectInput(projectInput);
  const normalizedSelectedProjectPath = normalizeProjectInput(
    selectedProject?.path ?? "",
  );
  const isProjectInputCommittedSelection =
    Boolean(normalizedProjectInput) &&
    Boolean(normalizedSelectedProjectPath) &&
    normalizedProjectInput === normalizedSelectedProjectPath;
  const activeProjectSearchQuery = isProjectInputCommittedSelection
    ? ""
    : normalizedProjectInput;
  const exactProjectMatch = useMemo(
    () => findProjectByInput(projects, activeProjectSearchQuery),
    [activeProjectSearchQuery, projects],
  );
  const projectMatches = useMemo(() => {
    if (!activeProjectSearchQuery) {
      return sortedProjects;
    }

    const query = activeProjectSearchQuery.toLowerCase();
    return sortedProjects.filter((project) => {
      return (
        project.name.toLowerCase().includes(query) ||
        project.path.toLowerCase().includes(query)
      );
    });
  }, [activeProjectSearchQuery, sortedProjects]);
  const projectSuggestions = useMemo(() => {
    const source = activeProjectSearchQuery ? projectMatches : quickProjects;
    return source.slice(0, PROJECT_SUGGESTION_COUNT);
  }, [activeProjectSearchQuery, projectMatches, quickProjects]);
  const projectSuggestionOptions = useMemo(
    () =>
      projectSuggestions.map((project) => (
        <option key={project.id} value={project.path}>
          {project.name}
        </option>
      )),
    [projectSuggestions],
  );
  const hasCustomProjectPath =
    Boolean(activeProjectSearchQuery) && exactProjectMatch === null;
  const currentProjectSelection = exactProjectMatch ?? selectedProject ?? null;
  const isDetachedProject =
    !hasCustomProjectPath && currentProjectSelection === null;
  const projectSummaryTitle =
    currentProjectSelection?.name ?? t("newSessionProjectDetached");
  const projectSummaryMeta = hasCustomProjectPath
    ? normalizedProjectInput
    : (currentProjectSelection?.path ?? t("newSessionProjectDetachedHint"));
  const displayedProjectSummaryMeta =
    hasCustomProjectPath || currentProjectSelection
      ? shortenPath(projectSummaryMeta)
      : projectSummaryMeta;

  const handleProjectOptionSelect = useCallback(
    (project: Project) => {
      setProjectInput(project.path);
      lastSyncedProjectIdRef.current = project.id;
      onProjectChange?.(project.id);
      setIsProjectChooserExpanded(false);
    },
    [onProjectChange],
  );

  const handleDetachedProject = useCallback(() => {
    setProjectInput("");
    lastSyncedProjectIdRef.current = null;
    onProjectChange?.(null);
    setIsProjectChooserExpanded(false);
  }, [onProjectChange]);

  const projectPanelRows = useMemo(() => {
    if (!isProjectChooserExpanded) return null;

    const rows: ReactNode[] = [
      <button
        key="detached"
        type="button"
        className={`new-session-project-option ${isDetachedProject ? "selected" : ""}`}
        onClick={handleDetachedProject}
      >
        <span className="new-session-project-option-name">
          {t("newSessionProjectDetached")}
        </span>
        <span className="new-session-project-option-path">
          {t("newSessionProjectDetachedHint")}
        </span>
      </button>,
    ];

    if (hasCustomProjectPath) {
      rows.push(
        <button
          key="custom"
          type="button"
          className="new-session-project-option new-session-project-option-custom"
          onClick={() => setIsProjectChooserExpanded(false)}
        >
          <span className="new-session-project-option-name">
            {t("newSessionProjectUseTypedPath")}
          </span>
          <span className="new-session-project-option-path">
            {activeProjectSearchQuery}
          </span>
        </button>,
      );
    }

    if (projectsLoading) {
      rows.push(
        <div key="loading" className="new-session-project-empty">
          {t("newSessionLoading")}
        </div>,
      );
      return rows;
    }

    if (projectSuggestions.length === 0) {
      rows.push(
        <div key="no-matches" className="new-session-project-empty">
          {t("newSessionProjectNoMatches")}
        </div>,
      );
      return rows;
    }

    rows.push(
      ...projectSuggestions.map((project) => (
        <button
          key={project.id}
          type="button"
          className={`new-session-project-option ${currentProjectSelection?.id === project.id && !hasCustomProjectPath ? "selected" : ""}`}
          onClick={() => handleProjectOptionSelect(project)}
          title={project.path}
        >
          <span className="new-session-project-option-name">
            {project.name}
          </span>
          <span className="new-session-project-option-path">
            {shortenPath(project.path)}
          </span>
        </button>
      )),
    );

    return rows;
  }, [
    currentProjectSelection?.id,
    handleDetachedProject,
    handleProjectOptionSelect,
    hasCustomProjectPath,
    isDetachedProject,
    isProjectChooserExpanded,
    activeProjectSearchQuery,
    projectSuggestions,
    projectsLoading,
    setIsProjectChooserExpanded,
    t,
  ]);

  // Initialize provider/model/mode from saved defaults once settings and providers load.
  useEffect(() => {
    if (
      hasInitializedDefaultsRef.current ||
      providersLoading ||
      settingsLoading
    ) {
      return;
    }

    hasInitializedDefaultsRef.current = true;
    if (hasUserCustomizedDefaultsRef.current) {
      return;
    }

    if (providers.length === 0) return;

    const availableProviderNames = new Set(
      availableProviders.map((p) => p.name),
    );
    const savedDefaults = settings?.newSessionDefaults;
    const savedProviderName =
      savedDefaults?.provider &&
      availableProviderNames.has(savedDefaults.provider)
        ? savedDefaults.provider
        : null;
    const initialProvider =
      providers.find((p) => p.name === savedProviderName) ??
      getDefaultProvider(providers);

    if (!initialProvider) return;

    const initialModels = initialProvider.models ?? [];
    setSelectedProvider(initialProvider.name);
    setSelectedModel(
      getPreferredProviderModelId(
        initialProvider.name,
        initialModels,
        savedDefaults,
      ),
    );
    setSelectedRecapMode(getDefaultRecapMode(initialProvider, savedDefaults));
    setSelectedPromptSuggestionMode(
      getDefaultPromptSuggestionMode(initialProvider, savedDefaults),
    );
    setHelperSideModel(
      getDefaultHelperSideModel(
        [...helperTargetModelOptions, ...initialModels],
        savedDefaults,
      ),
    );
    setMode(savedDefaults?.permissionMode ?? "default");
  }, [
    availableProviders,
    providers,
    providersLoading,
    settings,
    settingsLoading,
    helperTargetModelOptions,
  ]);

  useEffect(() => {
    const nextProjectId = projectId ?? null;
    if (lastSyncedProjectIdRef.current === nextProjectId) {
      return;
    }

    lastSyncedProjectIdRef.current = nextProjectId;
    setProjectInput((prev) => prev || (selectedProject?.path ?? ""));
  }, [projectId, selectedProject]);

  // When provider changes, reset model based on user settings
  const handleProviderSelect = (providerName: ProviderName) => {
    hasUserCustomizedDefaultsRef.current = true;
    setSelectedProvider(providerName);
    const provider = providers.find((p) => p.name === providerName);
    const providerModels = provider?.models ?? [];
    if (provider?.models && provider.models.length > 0) {
      setSelectedModel(
        getPreferredProviderModelId(
          providerName,
          providerModels,
          settings?.newSessionDefaults,
        ),
      );
    } else {
      setSelectedModel(null);
    }
    setSelectedRecapMode(
      getDefaultRecapMode(provider, settings?.newSessionDefaults),
    );
    setSelectedPromptSuggestionMode(
      getDefaultPromptSuggestionMode(provider, settings?.newSessionDefaults),
    );
    setHelperSideModel(
      getDefaultHelperSideModel(
        [...helperTargetModelOptions, ...providerModels],
        settings?.newSessionDefaults,
      ),
    );
  };

  // Build model options for FilterDropdown
  const modelOptions = useMemo((): FilterOption<string>[] => {
    return availableModels.map((model) => {
      const label = model.size
        ? `${model.name} (${(model.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`
        : model.name;

      let description = model.description;
      if (!description) {
        const parts: string[] = [];
        if (model.parameterSize) parts.push(model.parameterSize);
        if (model.contextWindow) {
          parts.push(`${Math.round(model.contextWindow / 1024)}K ctx`);
        }
        if (model.parentModel) parts.push(model.parentModel);
        if (model.quantizationLevel) parts.push(model.quantizationLevel);
        if (parts.length > 0) description = parts.join(" · ");
      }

      return { value: model.id, label, description };
    });
  }, [availableModels]);

  // Handle model selection from FilterDropdown
  const handleModelSelect = useCallback((selected: string[]) => {
    hasUserCustomizedDefaultsRef.current = true;
    setSelectedModel(selected[0] ?? null);
  }, []);

  // Build STT backend options for FilterDropdown.
  const speechMethodOptions = useMemo((): FilterOption<SpeechMethodId>[] => {
    const serverBackends = versionInfo?.voiceBackends ?? [];
    return getSpeechMethods(serverBackends).map((method) => ({
      value: method.id,
      label: method.label,
      description: method.description,
    }));
  }, [versionInfo?.voiceBackends]);
  const selectedSpeechMethod = useMemo(
    () =>
      resolveSpeechMethod(
        speechMethod,
        versionInfo?.voiceBackends,
        hasStoredSpeechMethod,
      ),
    [speechMethod, versionInfo?.voiceBackends, hasStoredSpeechMethod],
  );

  const handleSpeechMethodSelect = useCallback(
    (selected: string[]) => {
      const next = selected[0];
      if (next && isSpeechMethodId(next)) {
        setSpeechMethod(next);
      }
    },
    [setSpeechMethod],
  );
  const showSpeechMethodSelector =
    voiceInputEnabled && speechMethodOptions.length > 1;
  const supportsSelectedSpeechSmartTurn =
    selectedSpeechMethod !== "browser-native" &&
    (selectedSpeechMethod !== "ya-grok" ||
      grokSpeechAudioSettings.uplinkMode === "pcm16") &&
    versionInfo?.voiceBackendCapabilities?.[selectedSpeechMethod]?.smartTurn ===
      true;
  const activeSpeechSmartTurnSettings: SpeechSmartTurnSettings | undefined =
    supportsSelectedSpeechSmartTurn ? speechSmartTurnSettings : undefined;
  const showGrokSpeechAudioControls = selectedSpeechMethod === "ya-grok";

  // Combined display text: committed text + interim transcript
  const displayText = interimTranscript
    ? message + (message.trimEnd() ? " " : "") + interimTranscript
    : message;

  // Auto-scroll textarea when voice input updates (interim transcript changes)
  // Browser handles scrolling for normal typing, but programmatic updates need explicit scroll
  useEffect(() => {
    if (interimTranscript) {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    }
  }, [interimTranscript]);

  // Focus textarea on mount if autoFocus is enabled
  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  // Check for opt-in new-session prefill on mount.
  useEffect(() => {
    const prefill = getNewSessionPrefill();
    if (prefill) {
      setMessage(prefill);
      clearNewSessionPrefill();
      // Focus and move cursor to end
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(prefill.length, prefill.length);
      }
    }
  }, [setMessage]);

  const handleProjectInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (exactProjectMatch) {
          handleProjectOptionSelect(exactProjectMatch);
        } else if (normalizedProjectInput) {
          setIsProjectChooserExpanded(false);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsProjectChooserExpanded(false);
      }
    },
    [
      exactProjectMatch,
      handleProjectOptionSelect,
      normalizedProjectInput,
      setIsProjectChooserExpanded,
    ],
  );

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;

    const newPendingFiles: PendingFile[] = Array.from(files).map((file) => ({
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined,
    }));

    setPendingFiles((prev) => [...prev, ...newPendingFiles]);
    e.target.value = ""; // Reset for re-selection
  };

  const handleRemoveFile = (id: string) => {
    setPendingFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file?.previewUrl) {
        URL.revokeObjectURL(file.previewUrl);
      }
      return prev.filter((f) => f.id !== id);
    });
  };

  const handleModeSelect = (selectedMode: PermissionMode) => {
    hasUserCustomizedDefaultsRef.current = true;
    setMode(selectedMode);
  };

  const handleSaveDefaults = useCallback(async () => {
    setIsSavingDefaults(true);
    try {
      await updateServerSetting("newSessionDefaults", {
        provider: selectedProvider ?? undefined,
        model: selectedModel ?? undefined,
        permissionMode: mode,
        recapMode: selectedRecapMode,
        promptSuggestionMode: selectedPromptSuggestionMode,
        helperSideModel,
      });
      showToast(t("newSessionDefaultsSaved"), "success");
    } catch (err) {
      console.error("Failed to save new session defaults:", err);
      showToast(
        err instanceof Error ? err.message : t("newSessionDefaultsSaveError"),
        "error",
      );
    } finally {
      setIsSavingDefaults(false);
    }
  }, [
    mode,
    helperSideModel,
    selectedModel,
    selectedProvider,
    selectedPromptSuggestionMode,
    selectedRecapMode,
    showToast,
    t,
    updateServerSetting,
  ]);

  const handleStartSession = async (messageOverride?: unknown) => {
    const override =
      typeof messageOverride === "string" ? messageOverride : undefined;
    // Stop voice recording and get any pending interim text unless the caller
    // already supplied the finalized text from the STT backend.
    const pendingVoice =
      override === undefined
        ? (voiceButtonRef.current?.stopAndFinalize() ?? "")
        : "";

    // Combine committed text with any pending voice text
    let finalMessage = (override ?? message).trimEnd();
    if (pendingVoice) {
      finalMessage = finalMessage
        ? `${finalMessage} ${pendingVoice}`
        : pendingVoice;
    }

    const hasContent = finalMessage.trim() || pendingFiles.length > 0;
    if (!hasContent || isStarting) return;

    const trimmedMessage = finalMessage.trim();
    const trimmedProjectInput = normalizeProjectInput(projectInput);
    const actionAtMs = Date.now();
    const clientTimestamp = getServerClockTimestamp(actionAtMs);

    setInterimTranscript("");
    setIsStarting(true);

    try {
      let resolvedProjectId = trimmedProjectInput
        ? currentProjectSelection?.path === trimmedProjectInput
          ? currentProjectSelection.id
          : findProjectByInput(projects, trimmedProjectInput)?.id
        : null;

      if (trimmedProjectInput && !resolvedProjectId) {
        const addProjectResult = await api.addProject(trimmedProjectInput);
        resolvedProjectId = addProjectResult.project.id;
        lastSyncedProjectIdRef.current = resolvedProjectId;
        onProjectChange?.(resolvedProjectId);
      }

      let sessionId: string;
      let processId: string;
      const uploadedFiles: UploadedFile[] = [];

      // Get model and thinking settings
      const thinking = getThinkingSetting(effectiveEffortLevel);
      const sessionOptions = {
        mode,
        model: selectedModel ?? undefined,
        thinking,
        provider: selectedProvider ?? undefined,
        executor: selectedExecutor ?? undefined,
        recapMode: selectedRecapMode,
        promptSuggestionMode: selectedPromptSuggestionMode,
        helperSideModel,
      };
      logSessionUiTrace("new-session-submit", {
        projectId: resolvedProjectId ?? null,
        detached: !resolvedProjectId,
        mode,
        model: selectedModel ?? null,
        thinking,
        provider: selectedProvider ?? null,
        executor: selectedExecutor ?? null,
        recapMode: selectedRecapMode,
        promptSuggestionMode: selectedPromptSuggestionMode,
        helperSideModel,
        textLength: trimmedMessage.length,
        pendingFileCount: pendingFiles.length,
        clientTimestamp,
        serverOffsetMs: getEstimatedServerOffsetMs(),
      });

      if (pendingFiles.length > 0) {
        // Two-phase flow: create session first, then upload to real session folder
        // Step 1: Create the session without sending a message
        const createRequestSentAtMs = Date.now();
        const createResult = resolvedProjectId
          ? await api.createSession(resolvedProjectId, sessionOptions)
          : await api.createDetachedSession(sessionOptions);
        const createResponseReceivedAtMs = Date.now();
        const createTiming = recordServerClockSample({
          clientRequestStartMs: createRequestSentAtMs,
          clientResponseEndMs: createResponseReceivedAtMs,
          serverTimestamp: createResult.serverTimestamp,
        });
        const activeProjectId = createResult.projectId;
        sessionId = createResult.sessionId;
        processId = createResult.processId;
        resolvedProjectId = activeProjectId;
        logSessionUiTrace("new-session-created", {
          sessionId,
          processId,
          projectId: resolvedProjectId,
          thinking,
          mode,
          serverTimestamp: createResult.serverTimestamp,
          requestRttMs: createTiming?.roundTripMs ?? null,
          estimatedServerOffsetMs: createTiming?.serverOffsetMs ?? null,
        });

        // Step 2: Upload files to the real session folder
        for (const pendingFile of pendingFiles) {
          try {
            const preparedImage = pendingFile.file.type.startsWith("image/")
              ? await prepareImageUpload(
                  pendingFile.file,
                  getAttachmentUploadLongEdgePx(attachmentQuality),
                )
              : { file: pendingFile.file };
            const uploadFile = preparedImage.file;
            const uploadedFile = await connection.upload(
              activeProjectId,
              sessionId,
              uploadFile,
              {
                onProgress: (bytesUploaded) => {
                  setUploadProgress((prev) => ({
                    ...prev,
                    [pendingFile.id]: {
                      uploaded: bytesUploaded,
                      total: uploadFile.size,
                    },
                  }));
                },
                ...(preparedImage.width !== undefined &&
                preparedImage.height !== undefined
                  ? {
                      imageDimensions: {
                        width: preparedImage.width,
                        height: preparedImage.height,
                      },
                    }
                  : {}),
              },
            );
            uploadedFiles.push(uploadedFile);
          } catch (uploadErr) {
            console.error("Failed to upload file:", uploadErr);
            const uploadMessage =
              uploadErr instanceof Error ? uploadErr.message : "";
            showToast(
              t("newSessionUploadError", { message: uploadMessage }),
              "error",
            );
            // Continue with other files
          }
        }

        // Step 3: Send the first message with attachments
        const queueRequestSentAtMs = Date.now();
        const queueResult = await api.queueMessage(
          sessionId,
          trimmedMessage,
          mode,
          uploadedFiles.length > 0 ? uploadedFiles : undefined,
          undefined, // tempId
          thinking, // Pass the captured thinking setting to avoid process restart
          undefined,
          undefined,
          clientTimestamp,
        );
        const queueResponseReceivedAtMs = Date.now();
        const queueTiming = recordServerClockSample({
          clientRequestStartMs: queueRequestSentAtMs,
          clientResponseEndMs: queueResponseReceivedAtMs,
          serverTimestamp: queueResult.serverTimestamp,
        });
        logSessionUiTrace("new-session-queued", {
          sessionId,
          processId,
          projectId: resolvedProjectId,
          clientTimestamp,
          serverTimestamp: queueResult.serverTimestamp,
          uploadWaitMs: queueRequestSentAtMs - actionAtMs,
          requestRttMs: queueTiming?.roundTripMs ?? null,
          estimatedServerOffsetMs: queueTiming?.serverOffsetMs ?? null,
          clientToServerLatencyMs: measureServerLatencyMs(
            clientTimestamp,
            queueResult.serverTimestamp,
          ),
        });
      } else {
        // No files - use single-step flow for efficiency
        const startRequestSentAtMs = Date.now();
        const result = resolvedProjectId
          ? await api.startSession(
              resolvedProjectId,
              trimmedMessage,
              sessionOptions,
              undefined,
              clientTimestamp,
            )
          : await api.startDetachedSession(
              trimmedMessage,
              sessionOptions,
              undefined,
              clientTimestamp,
            );
        const startResponseReceivedAtMs = Date.now();
        const startTiming = recordServerClockSample({
          clientRequestStartMs: startRequestSentAtMs,
          clientResponseEndMs: startResponseReceivedAtMs,
          serverTimestamp: result.serverTimestamp,
        });
        sessionId = result.sessionId;
        processId = result.processId;
        resolvedProjectId = result.projectId;
        logSessionUiTrace("new-session-started", {
          sessionId,
          processId,
          projectId: resolvedProjectId,
          thinking,
          mode,
          provider: selectedProvider ?? null,
          model: selectedModel ?? null,
          clientTimestamp,
          serverTimestamp: result.serverTimestamp,
          requestRttMs: startTiming?.roundTripMs ?? null,
          estimatedServerOffsetMs: startTiming?.serverOffsetMs ?? null,
          clientToServerLatencyMs: measureServerLatencyMs(
            clientTimestamp,
            result.serverTimestamp,
          ),
        });
      }

      if (!resolvedProjectId) {
        throw new Error("Missing project ID for new session");
      }

      // Clean up preview URLs
      for (const pf of pendingFiles) {
        if (pf.previewUrl) {
          URL.revokeObjectURL(pf.previewUrl);
        }
      }

      draftControls.clearDraft();
      // Pass initial status so SessionPage can connect SSE immediately
      // without waiting for getSession to complete
      // Also pass initial message as optimistic title (session name = first message)
      // Pass model/provider so ProviderBadge can render immediately
      navigate(
        `${basePath}/projects/${resolvedProjectId}/sessions/${sessionId}`,
        {
          state: createSessionNavigationState({
            initialStatus: { owner: "self", processId },
            initialTitle: trimmedMessage,
            initialModel: selectedModel ?? undefined,
            initialProvider: selectedProvider ?? undefined,
          }),
        },
      );
    } catch (err) {
      console.error("Failed to start session:", err);
      draftControls.restoreFromStorage();
      setIsStarting(false);

      // Show user-visible error message
      let errorMessage = t("newSessionStartError");
      if (err instanceof Error) {
        const providerDisplayName =
          selectedProviderInfo?.displayName ?? selectedProvider ?? "Provider";
        const lowerMessage = err.message.toLowerCase();
        const status = (err as Error & { status?: number }).status;

        // Check for specific error types
        if (err.message.includes("Queue is full")) {
          errorMessage = t("newSessionServerBusy");
        } else if (
          lowerMessage.includes("invalid authentication credentials") ||
          lowerMessage.includes("authentication_error") ||
          lowerMessage.includes("please run /login") ||
          (status === 401 &&
            (selectedProvider === "claude" ||
              selectedProvider === "gemini" ||
              selectedProvider === "codex"))
        ) {
          errorMessage = t("newSessionProviderAuthError", {
            provider: providerDisplayName,
          });
        } else if (err.message.includes("503")) {
          errorMessage = t("newSessionServerCapacity");
        } else if (err.message.includes("404")) {
          errorMessage = t("newSessionProjectNotFound");
        } else if (
          err.message.includes("fetch") ||
          err.message.includes("network")
        ) {
          errorMessage = t("newSessionNetworkError");
        } else {
          errorMessage = err.message;
        }
      }
      showToast(errorMessage, "error");
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.nativeEvent.isComposing) return;

      // On mobile (touch devices), Enter adds newline - must use send button
      // On desktop, Enter sends message, Shift/Ctrl+Enter adds newline
      const isMobile = hasCoarsePointer();

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        handleStartSession();
        return;
      }

      if (isMobile) {
        // Mobile: Enter always adds newline, send button required
        return;
      }

      if (ENTER_SENDS_MESSAGE) {
        if (e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        handleStartSession();
      } else {
        if (e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          handleStartSession();
        }
      }
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      const newPendingFiles: PendingFile[] = files.map((file) => ({
        id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined,
      }));
      setPendingFiles((prev) => [...prev, ...newPendingFiles]);
    }
  };

  // Voice input handlers
  const handleVoiceTranscript = useCallback(
    (
      transcript: string,
      metadata?: SpeechTranscriptionResultMetadata,
    ) => {
      if (metadata?.smartTurnCommand === "cancel") {
        setInterimTranscript("");
        return;
      }

      const current = draftControls.getDraft();
      const trimmedTranscript = transcript.trim();
      const nextMessage = trimmedTranscript
        ? appendSpeechTranscript(current, trimmedTranscript)
        : current;
      if (nextMessage !== current) {
        draftControls.setDraft(nextMessage);
      }
      setInterimTranscript("");
      if (metadata?.smartTurnCommand === "send") {
        void handleStartSession(nextMessage);
      }
      // Scroll to bottom after committing voice transcript
      // Use setTimeout to ensure state update has rendered
      setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.scrollTop = textarea.scrollHeight;
        }
      }, 0);
    },
    [draftControls, handleStartSession],
  );

  const handleInterimTranscript = useCallback((transcript: string) => {
    setInterimTranscript(transcript);
  }, []);

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!isVoiceInputShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const voice = voiceButtonRef.current;
      if (!voice?.isAvailable) return;
      const wasActive = voice.isListening;
      voice.toggle();
      if (!wasActive) {
        textareaRef.current?.focus();
      }
    },
    [],
  );

  const hasContent = message.trim() || pendingFiles.length > 0;
  const canStart = Boolean(hasContent);
  const getTranscriptionContext =
    useCallback((): SpeechTranscriptionContext => {
      if (!speechTurnIdRef.current) {
        speechTurnIdRef.current = createClientSpeechTurnId();
      }
      return {
        projectId,
        draftKey: NEW_SESSION_DRAFT_KEY,
        clientTurnId: speechTurnIdRef.current,
      };
    }, [projectId]);
  const savedDefaults = settings?.newSessionDefaults;
  const defaultRecapMode = getDefaultRecapMode(
    selectedProviderInfo,
    savedDefaults,
  );
  const defaultHelperSideModel = getDefaultHelperSideModel(
    helperSelectableModels,
    savedDefaults,
  );
  const defaultPromptSuggestionMode = getDefaultPromptSuggestionMode(
    selectedProviderInfo,
    savedDefaults,
  );
  const savedPromptSuggestionModeForMatch =
    savedDefaults?.promptSuggestionMode ?? defaultPromptSuggestionMode;
  const defaultsMatchCurrent =
    (savedDefaults?.provider ?? undefined) ===
      (selectedProvider ?? undefined) &&
    (savedDefaults?.model ?? undefined) === (selectedModel ?? undefined) &&
    (savedDefaults?.permissionMode ?? "default") === mode &&
    defaultRecapMode === selectedRecapMode &&
    savedPromptSuggestionModeForMatch === selectedPromptSuggestionMode &&
    defaultHelperSideModel === helperSideModel;

  // Shared input area with toolbar (textarea + attach/voice on left, send on right)
  const inputArea = (
    <>
      <textarea
        ref={textareaRef}
        value={displayText}
        onChange={(e) => {
          setInterimTranscript("");
          setMessage(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={resolvedPlaceholder}
        disabled={isStarting}
        rows={rows}
        className="new-session-form-textarea"
      />
      <div className="new-session-form-toolbar">
        <div className="new-session-form-toolbar-left">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFileSelect}
          />
          <button
            type="button"
            className="toolbar-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStarting}
            aria-label={t("newSessionAttachFiles")}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <VoiceInputButton
            ref={voiceButtonRef}
            onTranscript={handleVoiceTranscript}
            onInterimTranscript={handleInterimTranscript}
            onListeningStart={() => textareaRef.current?.focus()}
            disabled={isStarting}
            className="toolbar-button"
            speechMethod={selectedSpeechMethod}
            getTranscriptionContext={getTranscriptionContext}
            smartTurn={activeSpeechSmartTurnSettings}
            grokSpeechAudioSettings={grokSpeechAudioSettings}
          />
          {supportsThinkingToggle && (
            <>
              <button
                type="button"
                className={`toolbar-button thinking-toggle-button ${thinkingMode !== "off" ? `active ${thinkingMode}` : ""}`}
                onClick={cycleThinkingMode}
                disabled={isStarting}
                title={
                  thinkingMode === "off"
                    ? t("newSessionThinkingOff")
                    : thinkingMode === "auto"
                      ? t("newSessionThinkingAuto")
                      : t("newSessionThinkingOn", {
                          level: effectiveEffortLabel,
                        })
                }
                aria-label={t("newSessionThinkingMode", { mode: thinkingMode })}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                  {thinkingMode === "auto" && (
                    <g>
                      <circle
                        cx="19"
                        cy="5"
                        r="5.5"
                        fill="currentColor"
                        stroke="none"
                      />
                      <text
                        x="19"
                        y="5"
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="var(--bg-primary, #1a1a2e)"
                        fontSize="8"
                        fontWeight="700"
                        fontFamily="system-ui, sans-serif"
                        stroke="none"
                      >
                        A
                      </text>
                    </g>
                  )}
                </svg>
              </button>
              {thinkingMode === "on" && (
                <div
                  className="new-session-effort-selector"
                  role="group"
                  aria-label={t("modelSettingsEffortTitle")}
                >
                  {effortOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`new-session-effort-option ${
                        effectiveEffortLevel === option.value ? "active" : ""
                      }`}
                      onClick={() => setEffortLevel(option.value)}
                      disabled={isStarting}
                      title={option.description}
                      aria-label={`${t("modelSettingsEffortTitle")}: ${option.label}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={handleStartSession}
          disabled={isStarting || !canStart}
          className="send-button new-session-submit-button"
          aria-label={t("newSessionStartAction")}
        >
          {isStarting ? (
            <span className="send-spinner" />
          ) : (
            <svg
              className="send-icon new-session-submit-icon"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          )}
        </button>
      </div>
      {pendingFiles.length > 0 && (
        <div className="pending-files-list">
          {pendingFiles.map((pf) => {
            const progress = uploadProgress[pf.id];
            return (
              <div key={pf.id} className="pending-file-chip">
                {pf.previewUrl && (
                  <img
                    src={pf.previewUrl}
                    alt=""
                    className="pending-file-preview"
                  />
                )}
                <div className="pending-file-info">
                  <span className="pending-file-name">{pf.file.name}</span>
                  <span className="pending-file-size">
                    {progress
                      ? `${Math.round((progress.uploaded / progress.total) * 100)}%`
                      : formatSize(pf.file.size)}
                  </span>
                </div>
                {!isStarting && (
                  <button
                    type="button"
                    className="pending-file-remove"
                    onClick={() => handleRemoveFile(pf.id)}
                    aria-label={t("newSessionRemoveFile", {
                      name: pf.file.name,
                    })}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  const projectChooser = (
    <div
      className={`new-session-project-chooser ${isProjectChooserExpanded ? "expanded" : ""}`}
    >
      <div className="new-session-project-controls">
        <button
          type="button"
          className="new-session-project-summary"
          onClick={() => setIsProjectChooserExpanded((prev) => !prev)}
          aria-expanded={isProjectChooserExpanded}
          aria-controls="new-session-project-panel"
        >
          <span className="new-session-project-summary-body">
            <span className="new-session-project-summary-title">
              {projectSummaryTitle}
            </span>
            <span
              className="new-session-project-summary-path"
              title={projectSummaryMeta}
            >
              {isDetachedProject ? (
                <>
                  <span className="new-session-project-summary-path-long">
                    {t("newSessionProjectDetachedHint")}
                  </span>
                  <span className="new-session-project-summary-path-short">
                    {t("newSessionProjectDetachedHintShort")}
                  </span>
                </>
              ) : (
                displayedProjectSummaryMeta
              )}
            </span>
          </span>
          <svg
            className="new-session-project-summary-chevron"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        <label className="new-session-project-inline-field">
          <span className="new-session-project-inline-label">
            {t("newSessionProjectPathLabel")}
          </span>
          <input
            ref={projectInputRef}
            type="text"
            value={projectInput}
            onChange={(e) => {
              setProjectInput(e.target.value);
              if (!isProjectChooserExpanded) {
                setIsProjectChooserExpanded(true);
              }
            }}
            onFocus={() => setIsProjectChooserExpanded(true)}
            onKeyDown={handleProjectInputKeyDown}
            placeholder={t("newSessionProjectPathPlaceholder")}
            disabled={isStarting}
            className="new-session-project-input"
            spellCheck={false}
            list="new-session-project-options"
          />
        </label>
        <datalist id="new-session-project-options">
          {projectSuggestionOptions}
        </datalist>
      </div>

      {isProjectChooserExpanded && projectPanelRows && (
        <div
          id="new-session-project-panel"
          className="new-session-project-panel"
        >
          <p className="new-session-project-field-hint">
            {t("newSessionProjectPathHint")}
          </p>

          <div className="new-session-project-suggestions">
            {projectPanelRows}
          </div>
        </div>
      )}
    </div>
  );

  const providerSection =
    !providersLoading && availableProviders.length > 1 ? (
      <div className="new-session-provider-section">
        <h3>{t("newSessionProviderTitle")}</h3>
        <div className="provider-options">
          {providers.map((p) => {
            const isAvailable = p.installed && (p.authenticated || p.enabled);
            const isSelected = selectedProvider === p.name;
            return (
              <button
                key={p.name}
                type="button"
                className={`provider-option ${isSelected ? "selected" : ""} ${!isAvailable ? "disabled" : ""}`}
                onClick={() => isAvailable && handleProviderSelect(p.name)}
                disabled={isStarting || !isAvailable}
                title={
                  !isAvailable
                    ? t("newSessionProviderUnavailable", {
                        provider: p.displayName,
                        reason: !p.installed
                          ? t("newSessionProviderNotInstalled")
                          : t("newSessionProviderNotAuthenticated"),
                      })
                    : p.displayName
                }
              >
                <span className={`provider-option-dot provider-${p.name}`} />
                <div className="provider-option-content">
                  <span className="provider-option-label">{p.displayName}</span>
                  {!isAvailable && (
                    <span className="provider-option-status">
                      {!p.installed
                        ? t("newSessionProviderStatusNotInstalled")
                        : t("newSessionProviderStatusNotAuthenticated")}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    ) : null;
  const modelField =
    selectedProvider && modelOptions.length > 0 ? (
      <div className="new-session-model-field">
        <h3>{t("newSessionModelTitle")}</h3>
        <FilterDropdown
          label={t("newSessionModelTitle")}
          options={modelOptions}
          selected={selectedModel ? [selectedModel] : []}
          onChange={handleModelSelect}
          multiSelect={false}
          placeholder={t("newSessionModelPlaceholder")}
        />
      </div>
    ) : null;
  const shouldShowSpeechField =
    showSpeechMethodSelector ||
    showGrokSpeechAudioControls ||
    supportsSelectedSpeechSmartTurn;
  const speechField = shouldShowSpeechField ? (
    <div className="new-session-speech-field">
      <h3>{t("newSessionSpeechTitle")}</h3>
      {showSpeechMethodSelector && (
        <FilterDropdown
          label={t("newSessionSpeechTitle")}
          options={speechMethodOptions}
          selected={[selectedSpeechMethod]}
          onChange={handleSpeechMethodSelect}
          multiSelect={false}
          placeholder={t("newSessionSpeechPlaceholder")}
        />
      )}
      {showGrokSpeechAudioControls && (
        <SpeechGrokAudioControls
          settings={grokSpeechAudioSettings}
          onChange={setGrokSpeechAudioSettings}
        />
      )}
      {supportsSelectedSpeechSmartTurn && (
        <SpeechSmartTurnControls
          settings={speechSmartTurnSettings}
          onChange={setSpeechSmartTurnSettings}
        />
      )}
    </div>
  ) : null;
  const modelSection = modelField ? (
    <div className="new-session-model-section">
      {modelField}
    </div>
    ) : null;
  const recapSection = selectedProvider ? (
    <div className="new-session-helper-section">
      <h3>{t("newSessionRecapTitle")}</h3>
      <div className="new-session-helper-options">
        {availableRecapModes.map((modeValue) => (
          <button
            key={modeValue}
            type="button"
            className={`new-session-helper-option ${
              selectedRecapMode === modeValue ? "selected" : ""
            }`}
            onClick={() => {
              hasUserCustomizedDefaultsRef.current = true;
              setSelectedRecapMode(modeValue);
            }}
            disabled={isStarting}
            title={recapModeDescriptions[modeValue]}
          >
            <span className={`mode-option-dot recap-${modeValue}`} />
            <span>{recapModeLabels[modeValue]}</span>
          </button>
        ))}
      </div>
      {selectedRecapMode === "side-session" && (
        <div className="new-session-helper-model">
          <h3>{t("helperSideModelTitle")}</h3>
          <FilterDropdown
            label={t("helperSideModelTitle")}
            options={helperSideModelOptions}
            selected={[helperSideModel]}
            onChange={(selected) => {
              hasUserCustomizedDefaultsRef.current = true;
              setHelperSideModel(selected[0] ?? HELPER_SIDE_MODEL_CHEAPEST);
            }}
            multiSelect={false}
            placeholder={t("helperSideModelCheapest")}
          />
        </div>
      )}
    </div>
  ) : null;
  const promptSuggestionSection = selectedProvider ? (
    <div className="new-session-helper-section">
      <h3>{t("newSessionPromptSuggestionsTitle")}</h3>
      <div className="new-session-helper-options">
        {availablePromptSuggestionModes.map((modeValue) => (
          <button
            key={modeValue}
            type="button"
            className={`new-session-helper-option ${
              selectedPromptSuggestionMode === modeValue ? "selected" : ""
            }`}
            onClick={() => {
              hasUserCustomizedDefaultsRef.current = true;
              setSelectedPromptSuggestionMode(modeValue);
            }}
            disabled={isStarting}
            title={promptSuggestionModeDescriptions[modeValue]}
          >
            <span className={`mode-option-dot suggestion-${modeValue}`} />
            <span>{promptSuggestionModeLabels[modeValue]}</span>
          </button>
        ))}
      </div>
      {availablePromptSuggestionModes.length === 1 &&
        availablePromptSuggestionModes[0] === "off" &&
        selectedProviderDisplayName && (
          <p className="new-session-helper-note">
            {t("promptSuggestionNativeUnsupported", {
              provider: selectedProviderDisplayName,
            })}
          </p>
        )}
    </div>
  ) : null;
  const permissionSection = supportsPermissionMode ? (
    <div className="new-session-mode-section">
      <h3>{t("newSessionModeTitle")}</h3>
      <div className="mode-options">
        {MODE_ORDER.map((m) => (
          <button
            key={m}
            type="button"
            className={`mode-option ${mode === m ? "selected" : ""}`}
            onClick={() => handleModeSelect(m)}
            disabled={isStarting}
          >
            <span className={`mode-option-dot mode-${m}`} />
            <div className="mode-option-content">
              <span className="mode-option-label">{modeLabels[m]}</span>
              <span className="mode-option-desc">{modeDescriptions[m]}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  ) : null;
  const hasConfigControls = Boolean(
    selectedProvider ||
      permissionSection ||
      speechField ||
      recapSection ||
      promptSuggestionSection,
  );
  const defaultsBar = hasConfigControls ? (
    <div className="new-session-defaults-bar">
      <p className="new-session-defaults-copy">
        {t("newSessionDefaultsDescription")}
      </p>
      <button
        type="button"
        className="new-session-defaults-button"
        onClick={handleSaveDefaults}
        disabled={
          isStarting ||
          isSavingDefaults ||
          settingsLoading ||
          !selectedProvider ||
          defaultsMatchCurrent
        }
      >
        {isSavingDefaults
          ? t("newSessionDefaultsSaving")
          : t("newSessionDefaultsAction")}
      </button>
    </div>
  ) : null;

  // Compact mode: just the input area, no header or mode selector
  if (compact) {
    return (
      <div
        className={`new-session-form new-session-form-compact ${interimTranscript ? "voice-recording" : ""}`}
        onKeyDownCapture={handleComposerKeyDown}
      >
        {inputArea}
      </div>
    );
  }

  // Full mode: form with header, input area, and mode selector
  return (
    <div
      className={`new-session-form new-session-container ${interimTranscript ? "voice-recording" : ""}`}
      onKeyDownCapture={handleComposerKeyDown}
    >
      <div className="new-session-header">
        <p className="new-session-subtitle">{t("newSessionHeaderSubtitle")}</p>
      </div>

      <div className="new-session-top-layout">
        <div className="new-session-main-stack">
          <div className="new-session-input-area">{inputArea}</div>
        </div>
        <aside className="new-session-project-slot">{projectChooser}</aside>
        {(providerSection ||
          modelSection ||
          recapSection ||
          promptSuggestionSection ||
          permissionSection ||
          defaultsBar) && (
          <div className="new-session-provider-slot">
            {providerSection}
            {modelSection}
            {permissionSection}
            {speechField}
            {recapSection}
            {promptSuggestionSection}
            {defaultsBar}
          </div>
        )}
      </div>

      {/* Executor Selection - only show if remote executors are configured */}
      {!executorsLoading && remoteExecutors.length > 0 && (
        <div className="new-session-executor-section">
          <h3>{t("newSessionRunOnTitle")}</h3>
          <div className="executor-options">
            <button
              key="local"
              type="button"
              className={`executor-option ${selectedExecutor === null ? "selected" : ""}`}
              onClick={() => setSelectedExecutor(null)}
              disabled={isStarting}
            >
              <span className="executor-option-dot executor-local" />
              <div className="executor-option-content">
                <span className="executor-option-label">
                  {t("newSessionRunOnLocal")}
                </span>
                <span className="executor-option-desc">
                  {t("newSessionRunOnLocalDesc")}
                </span>
              </div>
            </button>
            {remoteExecutors.map((host) => (
              <button
                key={host}
                type="button"
                className={`executor-option ${selectedExecutor === host ? "selected" : ""}`}
                onClick={() => setSelectedExecutor(host)}
                disabled={isStarting}
              >
                <span className="executor-option-dot executor-remote" />
                <div className="executor-option-content">
                  <span className="executor-option-label">{host}</span>
                  <span className="executor-option-desc">
                    {t("newSessionRunOnRemoteDesc")}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
