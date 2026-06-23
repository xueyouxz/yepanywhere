// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ClientDefaults } from "@yep-anywhere/shared";
import {
  type ComponentProps,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_ISEARCH_GUIDE_EVENT } from "../../lib/sessionIsearchGuide";
import {
  YA_GROK_BATCH_SPEECH_METHOD,
  XAI_DIRECT_STREAMING_SPEECH_METHOD,
} from "../../lib/speechProviders/methods";
import { setBrowserXaiSttApiKey } from "../../lib/speechProviders/xaiCredentials";
import { MessageInput } from "../MessageInput";
import {
  MessageInputToolbarView,
  type MessageInputToolbarViewProps,
} from "../MessageInputToolbar";

const {
  versionState,
  modelSettingsState,
  mockSetThinkingMode,
  mockSetEffortLevel,
  mockSetSpeechMethod,
  mockSetSpeechSmartTurnSettings,
  mockSetGrokSpeechAudioSettings,
  mockVoiceToggle,
  mockVoiceStopAndFinalize,
  mockVoiceCancelProcessing,
  voiceButtonState,
  voicePropsState,
  remoteBasePathState,
} = vi.hoisted(() => ({
  versionState: {
    version: {
      current: "test",
      latest: null,
      updateAvailable: false,
      capabilities: ["voiceInput"],
      voiceBackends: [] as string[],
      voiceBackendCapabilities: {} as Record<
        string,
        { streaming?: boolean; smartTurn?: boolean }
      >,
      clientDefaults: undefined as ClientDefaults | undefined,
    },
  },
  modelSettingsState: {
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
  mockSetSpeechMethod: vi.fn(),
  mockSetThinkingMode: vi.fn(),
  mockSetEffortLevel: vi.fn(),
  mockSetSpeechSmartTurnSettings: vi.fn(),
  mockSetGrokSpeechAudioSettings: vi.fn(),
  mockVoiceToggle: vi.fn(),
  mockVoiceStopAndFinalize: vi.fn(() => ""),
  mockVoiceCancelProcessing: vi.fn(),
  voiceButtonState: {
    isListening: false,
  },
  voicePropsState: {
    current: null as null | {
      onTranscript?: (
        text: string,
        metadata?: {
          smartTurnCommand?: "cancel" | "send" | "wait";
          smartTurnAutoSend?: boolean;
          replacePreviousTranscriptChars?: number;
          speechTargetId?: string;
        },
      ) => void;
      onInterimTranscript?: (text: string) => void;
      onListeningStart?: () => void;
      onListeningStop?: () => void;
      onPendingSpeechChange?: (
        kind: "listening" | "transcribing" | "finalizing" | null,
      ) => void;
      onTranscriptionSettled?: (settlement: {
        speechTargetId?: string;
        status: "completed" | "cancelled" | "error";
      }) => void;
      getTranscriptionContext?: () => { speechTargetId?: string };
    },
  },
  remoteBasePathState: {
    basePath: "",
  },
}));

vi.mock("../../hooks/useDraftPersistence", () => ({
  useDraftPersistence: () => {
    const [value, setValueInternal] = useState("");
    const valueRef = useRef("");
    const setValue = useCallback((nextValue: string) => {
      valueRef.current = nextValue;
      setValueInternal(nextValue);
    }, []);
    const getDraft = useCallback(() => valueRef.current, []);
    const setDraft = useCallback((nextValue: string) => {
      valueRef.current = nextValue;
      setValueInternal(nextValue);
    }, []);
    const flushDraft = useCallback(() => {}, []);
    const clearInput = useCallback(() => {
      valueRef.current = "";
      setValueInternal("");
    }, []);
    const clearDraft = useCallback(() => {
      valueRef.current = "";
      setValueInternal("");
    }, []);
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
        getDraft,
        setDraft,
        flushDraft,
        clearInput,
        clearDraft,
        restoreFromStorage,
      ],
    );

    return [value, setValue, controls] as const;
  },
}));

vi.mock("../../hooks/useModelSettings", () => ({
  useModelSettings: () => ({
    thinkingMode: "off",
    cycleThinkingMode: vi.fn(),
    thinkingLevel: "high",
    setThinkingMode: mockSetThinkingMode,
    setEffortLevel: mockSetEffortLevel,
    voiceInputEnabled: true,
    speechMethod: modelSettingsState.speechMethod,
    hasStoredSpeechMethod: modelSettingsState.hasStoredSpeechMethod,
    setSpeechMethod: mockSetSpeechMethod,
    speechSmartTurnSettings: modelSettingsState.speechSmartTurnSettings,
    setSpeechSmartTurnSettings: mockSetSpeechSmartTurnSettings,
    grokSpeechAudioSettings: modelSettingsState.grokSpeechAudioSettings,
    setGrokSpeechAudioSettings: mockSetGrokSpeechAudioSettings,
  }),
}));

vi.mock("../../hooks/useSessionToolbarVisibility", () => ({
  useSessionToolbarVisibility: () => ({
    visibility: {
      modeSelector: true,
      steerNow: true,
      attachments: true,
      slashMenu: true,
      thinkingToggle: true,
      renderMode: true,
      microphone: true,
      waveform: true,
      shortcutsHelp: true,
      contextUsage: true,
      btw: true,
      nudge: true,
      sessionStatus: true,
    },
    setControlVisible: vi.fn(),
    resetVisibility: vi.fn(),
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

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => remoteBasePathState.basePath,
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (
        ({
          commonOr: "or",
          toolbarKeyboardShortcutsAria: "Session keyboard shortcuts",
          toolbarSteerNowLabel: "Steer now",
          toolbarSteerNowShortLabel: "Now",
          toolbarSteerNowTooltip:
            "Steer now interrupts in-flight generation without ending the turn.",
          toolbarOverflowMenu: "More toolbar controls",
          toolbarQueuePrimaryActionLabel: "Queue from primary action",
          toolbarLivenessVerifiedProgress: "Verified progress",
          toolbarLivenessVerifiedIdle: "Verified idle",
          toolbarRelativeAgeNow: "now",
          toolbarRelativeAgePast: `${params?.age ?? ""} ago`,
          toolbarLivenessSummary: `${params?.state ?? ""} ${params?.age ?? ""}`,
          toolbarLivenessAria: `Session verified liveness: ${
            params?.summary ?? ""
          }`,
          toolbarLastActivityAria: "Session last activity",
          toolbarLastActivityAge: `Last activity ${params?.age ?? ""}`,
          toolbarBtwChildSessionTitle:
            "Viewing a /btw child session; click to return to Mother (Ctrl+B)",
          toolbarBtwFocusedFooterTitle:
            "Composer is focused on a /btw aside; click to return to Mother (Ctrl+B)",
          toolbarBtwFocusedPaneTitle:
            "A /btw pane is focused; click to focus its composer (Ctrl+B)",
          toolbarBtwFocusExistingTitle: "Focus existing /btw aside (Ctrl+B)",
          toolbarBtwStartTitle: "Start /btw aside (Ctrl+B)",
          toolbarShortcutUserTurns: "User turns",
          toolbarShortcutAllTurns: "All turns",
          toolbarShortcutFullSession: "Full session",
          toolbarShortcutPreviousMatch: "Previous match",
          toolbarShortcutJump: "Jump",
          toolbarShortcutPreviousNextMatch: "Previous / next match",
          toolbarShortcutClick: "Click",
          toolbarShortcutPreviewRailJumps: "Match preview / rail mark jumps",
          toolbarShortcutCancelRestoreFocus: "Cancel / restore focus",
          toolbarShortcutScrollToCurrent: "Scroll to current",
          toolbarShortcutUserTurnReverseSearch: "User-turn reverse search",
          toolbarShortcutAllTurnReverseSearch: "All-turn reverse search",
          toolbarShortcutFullSessionReverseSearch:
            "Full-session reverse search",
          toolbarShortcutSteerCurrentTurn: "Steer current turn",
          toolbarShortcutQueueCurrentTurn: "Queue message",
          toolbarShortcutForkAfterSummary:
            "Fork after initial turn with summary",
          toolbarShortcutSend: "Send",
          toolbarShortcutNewLine: "New line",
          toolbarShortcutRightClickLongPress: "Right-click / long-press ?",
          toolbarShortcutChangeKeys: "Change keys",
          toolbarShortcutSwapEnterCtrlEnter: "Swap Enter and Ctrl+Enter",
          toolbarShortcutStartBtwAside: "Start /btw aside",
          toolbarShortcutStopAgentCancelOverlay: "Stop agent / cancel overlay",
          toolbarShortcutRecallLastSentText: "Recall last sent text",
          toolbarShortcutCancelLatestQueuedMessage:
            "Cancel latest queued message",
          toolbarShortcutClearComposer: "Clear composer",
          toolbarShortcutRenderedSourceMode: "Rendered/source mode",
          speechSettingsXaiKeyTitle: "Browser xAI STT Key",
          speechSettingsXaiKeyPlaceholder: "Borrow from server when empty",
          speechListeningPlaceholder: "Listening...",
          speechTranscribingPlaceholder: "Transcribing...",
          speechFinalizingPlaceholder: "Finalizing...",
          speechTranscribingCancel: "Cancel transcription",
          messageInputCollapsedLineCount: `${params?.count ?? ""} lines`,
          forkSummaryComposerTitle: "Fork after selected turn",
          forkSummaryComposerDescription:
            "Keep this request and the agent response to it; replace later turns with a generated summary.",
          forkSummaryComposerPlaceholder:
            "Optional summary instructions; leave empty for the default summary...",
          forkSummarySubmit: "Fork with summary",
          forkSummaryTooltip:
            "Fork after the selected turn with a generated summary",
          forkSummaryCancel: "Cancel fork summary",
        }) satisfies Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("../VoiceInputButton", async () => {
  const React = await import("react");

  return {
    VoiceInputButton: React.forwardRef(
      (
        props: {
          onTranscript?: (
            text: string,
            metadata?: {
              smartTurnCommand?: "cancel" | "send" | "wait";
              smartTurnAutoSend?: boolean;
              replacePreviousTranscriptChars?: number;
              speechTargetId?: string;
            },
          ) => void;
          onInterimTranscript?: (text: string) => void;
          onListeningStart?: () => void;
          onListeningStop?: () => void;
          getTranscriptionContext?: () => { speechTargetId?: string };
          speechMethod?: string;
        },
        ref,
      ) => {
        voicePropsState.current = props;
        React.useImperativeHandle(ref, () => ({
          stopAndFinalize: mockVoiceStopAndFinalize,
          toggle: mockVoiceToggle,
          cancelProcessing: mockVoiceCancelProcessing,
          prewarm: vi.fn(),
          isAvailable: true,
          isListening: voiceButtonState.isListening,
        }));

        return (
          <button
            type="button"
            data-speech-method={props.speechMethod}
            onClick={() => {
              props.onListeningStart?.();
              mockVoiceToggle();
            }}
          >
            voice
          </button>
        );
      },
    ),
  };
});

function installDesktopMatchMedia() {
  const previous = Object.getOwnPropertyDescriptor(window, "matchMedia");

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  return () => {
    if (previous) {
      Object.defineProperty(window, "matchMedia", previous);
    } else {
      Reflect.deleteProperty(window, "matchMedia");
    }
  };
}

function installWindowNumberProperty(key: "innerHeight", value: number) {
  const previous = Object.getOwnPropertyDescriptor(window, key);

  Object.defineProperty(window, key, {
    configurable: true,
    value,
  });

  return () => {
    if (previous) {
      Object.defineProperty(window, key, previous);
    } else {
      Reflect.deleteProperty(window, key);
    }
  };
}

function renderMessageInput(
  onRecallLastSubmission = vi.fn(() => true),
  extraProps: Partial<ComponentProps<typeof MessageInput>> = {},
) {
  const placeholder = extraProps.placeholder ?? "Message";
  render(
    <MessageInput
      onSend={vi.fn()}
      draftKey="test-draft"
      placeholder={placeholder}
      supportsPermissionMode={false}
      supportsThinkingToggle={false}
      onRecallLastSubmission={onRecallLastSubmission}
      {...extraProps}
    />,
  );

  return screen.getByPlaceholderText(
    extraProps.collapsed
      ? "messageInputContinueAbove"
      : extraProps.forkSummaryMode
        ? extraProps.forkSummaryMode.placeholder
        : placeholder,
  );
}

function expectSubmission(
  fn: { mock: { calls: unknown[][] } },
  text: string,
  deliveryIntent: string,
) {
  const call = fn.mock.calls.at(-1);
  expect(call?.[0]).toBe(text);
  expect(call?.[1]).toMatchObject({
    deliveryIntent,
    composition: {
      typingStartedAt: expect.any(String),
      typingEndedAt: expect.any(String),
      lastEditedAt: expect.any(String),
      submittedAt: expect.any(String),
    },
  });
}

const toolbarVisibility: MessageInputToolbarViewProps["visibility"] = {
  modeSelector: false,
  steerNow: true,
  attachments: false,
  slashMenu: false,
  thinkingToggle: true,
  renderMode: false,
  microphone: false,
  waveform: false,
  shortcutsHelp: false,
  contextUsage: false,
  btw: false,
  nudge: false,
  sessionStatus: false,
};

const toolbarT = ((key: string, params?: Record<string, string>) => {
  const translations: Record<string, string> = {
    modelSettingsEffortTitle: "Effort Level",
    modelSettingsThinkingAutoLabel: "Auto",
    modelSettingsThinkingOffLabel: "Off",
    modelSettingsThinkingOnLabel: "On",
    modelSettingsThinkingTitle: "Thinking Mode",
    newSessionThinkingAuto: "Thinking: auto",
    newSessionThinkingOff: "Thinking: off",
    newSessionThinkingOn: `Thinking: on (${params?.level ?? ""})`,
    toolbarThinkingTitle: `${params?.current ?? ""}. Click to choose; right-click or long-press to toggle off/on. Applies next turn.`,
    toolbarKeyboardShortcutsAria: "Session keyboard shortcuts",
    toolbarQueueLabel: "Queue message",
    toolbarQueueTooltip: "Queue for the next regular delivery\nCtrl+Enter",
    toolbarSteerTooltip: "Steer current turn\nEnter",
    toolbarSend: "Send",
    toolbarOverflowMenu: "More toolbar controls",
  };
  return translations[key] ?? key;
}) as MessageInputToolbarViewProps["t"];

function renderToolbarView(
  thinkingControl: Omit<
    NonNullable<MessageInputToolbarViewProps["thinkingControl"]>,
    "showThinking" | "onSetShowThinking"
  >,
) {
  const control: NonNullable<MessageInputToolbarViewProps["thinkingControl"]> =
    {
      showThinking: "default",
      onSetShowThinking: () => {},
      ...thinkingControl,
    };
  render(
    <MessageInputToolbarView
      t={toolbarT}
      visibility={toolbarVisibility}
      attachmentControl={{ attachmentCount: 0 }}
      thinkingControl={control}
      shortcutsControl={{
        open: false,
        isearchScope: null,
        setOpen:
          vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
        settingsOpen: false,
        setSettingsOpen:
          vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
        hasDualActions: false,
        enterActionKind: "send",
        canSwapEnterAction: false,
        queueShortcutLabel: "Queue while agent runs",
      }}
      actionsControl={{}}
    />,
  );
}

describe("MessageInput", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    versionState.version = {
      current: "test",
      latest: null,
      updateAvailable: false,
      capabilities: ["voiceInput"],
      voiceBackends: [],
      voiceBackendCapabilities: {},
      clientDefaults: undefined,
    };
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
    remoteBasePathState.basePath = "";
    mockSetSpeechMethod.mockReset();
    mockSetThinkingMode.mockReset();
    mockSetEffortLevel.mockReset();
    mockSetSpeechSmartTurnSettings.mockReset();
    mockSetGrokSpeechAudioSettings.mockReset();
    mockVoiceToggle.mockReset();
    mockVoiceStopAndFinalize.mockReset();
    mockVoiceCancelProcessing.mockReset();
    voiceButtonState.isListening = false;
    voicePropsState.current = null;
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("grows the expanded composer until the draft reaches half the viewport", () => {
    const restoreInnerHeight = installWindowNumberProperty("innerHeight", 400);
    const textarea = renderMessageInput() as HTMLTextAreaElement;
    let scrollHeight = 160;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    try {
      fireEvent.change(textarea, {
        target: { value: "one\ntwo\nthree\nfour" },
      });

      expect(textarea.style.height).toBe("160px");
      expect(textarea.style.overflowY).toBe("hidden");

      scrollHeight = 260;
      fireEvent.change(textarea, {
        target: { value: "one\ntwo\nthree\nfour\nfive\nsix\nseven" },
      });

      expect(textarea.style.height).toBe("200px");
      expect(textarea.style.overflowY).toBe("auto");
    } finally {
      restoreInnerHeight();
    }
  });

  it("uses fork summary mode with empty instructions as a valid submit", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderMessageInput(vi.fn(), {
      forkSummaryMode: {
        title: "Fork after selected turn",
        description:
          "Keep this request and the agent response to it; replace later turns with a generated summary.",
        placeholder:
          "Optional summary instructions; leave empty for the default summary...",
        submitLabel: "Fork with summary",
        tooltip: "Fork after the selected turn with a generated summary",
        icon: "⑂",
        onCancel,
        onSubmit,
      },
    });

    expect(screen.getByText("Fork after selected turn")).toBeTruthy();
    expect(
      screen.getByPlaceholderText(
        "Optional summary instructions; leave empty for the default summary...",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Fork with summary" }));

    expect(onSubmit).toHaveBeenCalledWith("");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("sends the current draft as fork summary instructions with Ctrl+Alt+Enter", () => {
    const onForkSummaryShortcut = vi.fn(() => true);
    const textarea = renderMessageInput(vi.fn(), {
      onForkSummaryShortcut,
    }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "focus on tests" } });
    fireEvent.keyDown(textarea, {
      key: "Enter",
      ctrlKey: true,
      altKey: true,
    });

    expect(onForkSummaryShortcut).toHaveBeenCalledWith("focus on tests");
    expect(textarea.value).toBe("");
  });

  it("recalls the last submission from a blank composer with Up or Ctrl+P", () => {
    const onRecallLastSubmission = vi.fn(() => true);
    const textarea = renderMessageInput(onRecallLastSubmission);

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent.keyDown(textarea, { key: "p", ctrlKey: true });

    expect(onRecallLastSubmission).toHaveBeenCalledTimes(2);
  });

  it("opens explicit thinking choices from the toolbar button", () => {
    const onSetMode = vi.fn();
    renderToolbarView({
      mode: "off",
      level: "high",
      effortOptions: [
        { value: "low", label: "Low", description: "Fastest responses" },
        { value: "high", label: "High", description: "Deep reasoning" },
      ],
      onSetMode,
      onSetEffort: vi.fn(),
      onToggleEnabled: vi.fn(),
    });

    const button = screen.getByRole("button", {
      name: /Click to choose/i,
    });
    expect(button.textContent).toContain("Off");

    fireEvent.click(button);

    expect(screen.getByRole("menu")).toBeDefined();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Auto" }));

    expect(onSetMode).toHaveBeenCalledWith("auto");
  });

  it("sets toolbar effort choices through Thinking On", () => {
    const onSetMode = vi.fn();
    const onSetEffort = vi.fn();
    renderToolbarView({
      mode: "auto",
      level: "high",
      effortOptions: [
        { value: "high", label: "High", description: "Deep reasoning" },
        {
          value: "xhigh",
          label: "Extra High",
          description: "Extra-high reasoning",
        },
      ],
      onSetMode,
      onSetEffort,
      onToggleEnabled: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: /Click to choose/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Extra High" }));

    expect(onSetEffort).toHaveBeenCalledWith("xhigh");
    expect(onSetMode).toHaveBeenCalledWith("on");
  });

  it("uses the thinking secondary gesture as an off/on toggle", () => {
    const onToggleEnabled = vi.fn();
    renderToolbarView({
      mode: "auto",
      level: "high",
      effortOptions: [
        { value: "high", label: "High", description: "Deep reasoning" },
      ],
      onSetMode: vi.fn(),
      onSetEffort: vi.fn(),
      onToggleEnabled,
    });

    fireEvent.contextMenu(
      screen.getByRole("button", { name: /right-click or long-press/i }),
    );

    expect(onToggleEnabled).toHaveBeenCalledTimes(1);
  });

  it("selects direct Grok streaming by default when Grok STT is enabled", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-deepgram", "ya-grok"],
    };

    renderMessageInput();

    expect(
      screen.getByRole("button", { name: "voice" }).dataset.speechMethod,
    ).toBe(XAI_DIRECT_STREAMING_SPEECH_METHOD);

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));
    expect(
      screen.getByRole("radio", {
        name: /^Grok STT through YA Browser streams PCM audio through YA to xAI\.$/,
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole("radio", {
        name: /^Grok STT through YA batch Browser sends a complete compressed recording through YA to xAI\.$/,
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Deepgram STT/ }));

    expect(mockSetSpeechMethod).toHaveBeenCalledWith("ya-deepgram");
  });

  it("selects direct Grok streaming when a browser xAI key is configured", async () => {
    setBrowserXaiSttApiKey("browser-xai-key");

    renderMessageInput();

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "voice" }).dataset.speechMethod,
      ).toBe(XAI_DIRECT_STREAMING_SPEECH_METHOD),
    );
    expect(
      screen.getByRole("radio", {
        name: /^Grok STT direct Browser streams PCM audio directly to xAI\.$/,
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole("radio", {
        name: /Grok STT direct batch/,
      }),
    ).toBeNull();
  });

  it("stops active voice capture before opening speech settings", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
    };
    voiceButtonState.isListening = true;

    renderMessageInput();

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));

    expect(mockVoiceStopAndFinalize).toHaveBeenCalledTimes(1);
  });

  it("toggles session voice input on Ctrl+Space from the composer", () => {
    const textarea = renderMessageInput();

    fireEvent.keyDown(textarea, {
      key: " ",
      code: "Space",
      ctrlKey: true,
    });

    expect(mockVoiceToggle).toHaveBeenCalledTimes(1);
  });

  it("replaces selected text only when speech text commits", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "replace this text" } });
    textarea.focus();
    textarea.setSelectionRange(8, 12);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
    });

    await waitFor(() => {
      expect(textarea.value).toBe("replace this text");
      expect(textarea.selectionStart).toBe(8);
      expect(textarea.selectionEnd).toBe(12);
    });

    act(() => {
      voicePropsState.current?.onTranscript?.("spoken");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("replace spoken text");
      expect(textarea.selectionStart).toBe("replace spoken".length);
    });

    act(() => {
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "cancel",
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe("replace text");
      expect(textarea.selectionStart).toBe("replace".length);
    });
  });

  it("shows the Transcribing label inline at the cursor and cancels on Escape", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    expect(document.querySelector(".speech-processing-inline")).toBeNull();

    // Enter the batch processing wait (no interim), e.g. parakeet first-load.
    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
    });

    const badge = await waitFor(() => {
      const el = document.querySelector(".speech-processing-inline");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(badge.textContent).toContain("Transcribing");

    // The field stays editable while transcription is pending.
    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, {
      target: { value: "typed while transcribing" },
    });
    expect(textarea.value).toBe("typed while transcribing");

    // Escape is the deliberate cancel path now (no chip ✕; backspace can't
    // reach it). Cancel leaves the user's typed text intact.
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(mockVoiceCancelProcessing).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(document.querySelector(".speech-processing-inline")).toBeNull();
    });
    expect(textarea.value).toBe("typed while transcribing");
  });

  it("previews interim inline, then shows the Finalizing label inline; Escape cancels", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    // Active streaming: interim text previews inline (green highlight).
    act(() => {
      voicePropsState.current?.onInterimTranscript?.("live words");
    });
    await waitFor(() => {
      expect(document.querySelector(".speech-interim-inline")).not.toBeNull();
    });
    expect(document.querySelector(".speech-processing-inline")).toBeNull();

    // Flush (stop): the finalize wait shows its label inline at the same place,
    // unified with the batch transcribe wait; Escape cancels.
    act(() => {
      voicePropsState.current?.onInterimTranscript?.("");
      voicePropsState.current?.onPendingSpeechChange?.("finalizing");
    });
    const badge = await waitFor(() => {
      const el = document.querySelector(".speech-processing-inline");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(badge.textContent).toContain("Finalizing");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(mockVoiceCancelProcessing).toHaveBeenCalledTimes(1);
  });

  it("shows the Listening label inline during active capture", async () => {
    renderMessageInput();

    // Active live capture previews the pending state inline at the insertion
    // point too, not as a chip below the composer.
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });
    const badge = await waitFor(() => {
      const el = document.querySelector(".speech-processing-inline");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(badge.textContent).toContain("Listening");
  });

  it("cancels the inline pending tag via its ✕ button", async () => {
    renderMessageInput();

    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
    });
    const badge = await waitFor(() => {
      const el = document.querySelector(".speech-processing-inline");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(
      badge.querySelector(".speech-tag-cancel") as HTMLButtonElement,
    );
    expect(mockVoiceCancelProcessing).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(document.querySelector(".speech-processing-inline")).toBeNull();
    });
  });

  it("renders one tag per overlapping pending target, ordinal on the 2nd", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "draft" } });

    // Two recordings started before either result lands: each gets its own tag.
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });

    await waitFor(() => {
      expect(
        document.querySelectorAll(".speech-processing-inline").length,
      ).toBe(2);
    });
    // Only the 2nd (later) tag carries a "(N)" ordinal.
    const ordinals = document.querySelectorAll(".speech-tag-ordinal");
    expect(ordinals.length).toBe(1);
    expect(ordinals[0]?.textContent).toContain("2");
  });

  it("retires an older failed target while a newer recording stays active", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "draft" } });

    let firstTargetId: string | undefined;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      firstTargetId =
        voicePropsState.current?.getTranscriptionContext?.().speechTargetId;
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });

    await waitFor(() => {
      expect(
        document.querySelectorAll(".speech-processing-inline"),
      ).toHaveLength(2);
    });

    act(() => {
      voicePropsState.current?.onTranscriptionSettled?.({
        speechTargetId: firstTargetId,
        status: "error",
      });
    });

    await waitFor(() => {
      expect(
        document.querySelectorAll(".speech-processing-inline"),
      ).toHaveLength(1);
    });
    expect(document.querySelector(".speech-tag-ordinal")).toBeNull();
    expect(document.querySelector(".speech-tag-cancel")).not.toBeNull();
  });

  it("clears a completed recording's tag; a later activation does not revive it", async () => {
    renderMessageInput();

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
    });
    await waitFor(() => {
      expect(
        document.querySelectorAll(".speech-processing-inline").length,
      ).toBe(1);
    });

    // Recording completes (result committed, pending ends) -> tag clears.
    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.(null);
    });
    await waitFor(() => {
      expect(document.querySelector(".speech-processing-inline")).toBeNull();
    });

    // A second activation shows exactly one tag, not a revived stack.
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });
    await waitFor(() => {
      expect(
        document.querySelectorAll(".speech-processing-inline").length,
      ).toBe(1);
    });
    expect(document.querySelector(".speech-tag-ordinal")).toBeNull();
  });

  it("does not grace-delay the selection that started the mic transaction", () => {
    vi.useFakeTimers();
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "replace this text" } });
    textarea.focus();
    textarea.setSelectionRange(8, 12);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
    });
    fireEvent.select(textarea);

    act(() => {
      voicePropsState.current?.onTranscript?.("spoken");
    });

    expect(textarea.value).toBe("replace spoken text");
  });

  it("leaves a selected replacement untouched when speech is cancelled first", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "replace this text" } });
    textarea.focus();
    textarea.setSelectionRange(8, 12);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "cancel",
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe("replace this text");
      expect(textarea.selectionStart).toBe(8);
      expect(textarea.selectionEnd).toBe(12);
    });
  });

  it("replaces a hot-mic selection with the next final chunk after grace", () => {
    vi.useFakeTimers();
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "replace this text" } });
    textarea.focus();

    act(() => {
      voicePropsState.current?.onListeningStart?.();
    });

    textarea.setSelectionRange(8, 12);
    fireEvent.select(textarea);

    act(() => {
      voicePropsState.current?.onTranscript?.("spoken");
    });

    expect(textarea.value).toBe("replace this text");

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(textarea.value).toBe("replace spoken text");
    expect(textarea.selectionStart).toBe("replace spoken".length);
  });

  it("lets a manual edit cancel a pending hot-mic selection replacement", () => {
    vi.useFakeTimers();
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "replace this text" } });
    textarea.focus();

    act(() => {
      voicePropsState.current?.onListeningStart?.();
    });

    textarea.setSelectionRange(8, 12);
    fireEvent.select(textarea);

    act(() => {
      voicePropsState.current?.onTranscript?.("spoken");
    });

    fireEvent.change(textarea, { target: { value: "replace typed text" } });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(textarea.value).toBe("replace typed text");
  });

  it("renders interim speech at the current insertion point", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "hello world" } });
    textarea.focus();
    textarea.setSelectionRange(5, 5);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onInterimTranscript?.("there");
    });

    await waitFor(() => {
      expect(document.querySelector(".speech-draft-mirror")?.textContent).toBe(
        "hello there world",
      );
      expect(textarea.value).toBe("hello world");
      expect(textarea.selectionStart).toBe(5);
    });
  });

  it("relayouts interim speech over a hot selected replacement span", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "alpha beta gamma" } });
    textarea.focus();
    textarea.setSelectionRange(
      "alpha beta gamma".length,
      "alpha beta gamma".length,
    );

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onInterimTranscript?.("draft");
    });

    await waitFor(() => {
      expect(document.querySelector(".speech-draft-mirror")?.textContent).toBe(
        "alpha beta gamma draft",
      );
    });

    textarea.setSelectionRange("alpha ".length, "alpha beta".length);
    fireEvent.select(textarea);

    await waitFor(() => {
      expect(document.querySelector(".speech-draft-mirror")?.textContent).toBe(
        "alpha draft gamma",
      );
      expect(textarea.value).toBe("alpha beta gamma");
    });
  });

  it("uses selected text context to case speech replacements", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "Ok, look again." } });
    textarea.focus();
    textarea.setSelectionRange("Ok, ".length, "Ok, look".length);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Focus");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Ok, focus again.");
    });
  });

  it("replaces the previous speech-owned span from provider metadata", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Testing.");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Testing.");
    });

    act(() => {
      voicePropsState.current?.onTranscript?.("Testing. again.", {
        replacePreviousTranscriptChars: "Testing.".length,
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Testing. again.");
    });
  });

  it("replaces a corrected streaming segment after several final chunks", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Audio isn't done.");
      voicePropsState.current?.onTranscript?.("Empty final box.");
      voicePropsState.current?.onTranscript?.("Blocks");
      voicePropsState.current?.onTranscript?.(", blocks");
      voicePropsState.current?.onTranscript?.(", empty, five");
      voicePropsState.current?.onTranscript?.("o blocks.");
      voicePropsState.current?.onTranscript?.("Empty, final.");
      voicePropsState.current?.onTranscript?.("Blocks.");
    });

    const previousSegment =
      "Blocks, blocks, empty, five o blocks. Empty, final. Blocks.";
    await waitFor(() => {
      expect(textarea.value).toBe(
        `Audio isn't done. Empty final box. ${previousSegment}`,
      );
    });

    act(() => {
      voicePropsState.current?.onTranscript?.(
        "Blocks, blocks, empty final blocks, empty final blocks.",
        { replacePreviousTranscriptChars: previousSegment.length },
      );
    });

    await waitFor(() => {
      expect(textarea.value).toBe(
        "Audio isn't done. Empty final box. Blocks, blocks, empty final blocks, empty final blocks.",
      );
    });
  });

  it("inserts consecutive final speech chunks at a middle cursor", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "prefix suffix" } });
    textarea.focus();
    textarea.setSelectionRange("prefix".length, "prefix".length);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("first.");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("prefix first. suffix");
    });

    act(() => {
      voicePropsState.current?.onTranscript?.("second.");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("prefix first. second. suffix");
    });
  });

  it("moves a pending batch target after earlier speech inserted at the same cursor", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "prefix suffix" } });
    textarea.focus();
    textarea.setSelectionRange("prefix".length, "prefix".length);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
    });
    const firstTarget =
      voicePropsState.current?.getTranscriptionContext?.().speechTargetId;
    expect(firstTarget).toBeTruthy();

    act(() => {
      voicePropsState.current?.onListeningStop?.();
      voicePropsState.current?.onListeningStart?.();
    });
    const secondTarget =
      voicePropsState.current?.getTranscriptionContext?.().speechTargetId;
    expect(secondTarget).toBeTruthy();
    expect(secondTarget).not.toBe(firstTarget);

    act(() => {
      voicePropsState.current?.onTranscript?.("first.", {
        speechTargetId: firstTarget,
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe("prefix first. suffix");
    });

    act(() => {
      voicePropsState.current?.onTranscript?.("second.", {
        speechTargetId: secondTarget,
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe("prefix first. second. suffix");
    });
  });

  it("keeps active streaming final chunks in the composer", async () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onInterimTranscript?.("Okay");
      voicePropsState.current?.onTranscript?.("Okay.");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Okay.");
    });

    act(() => {
      voicePropsState.current?.onInterimTranscript?.("Does it work");
      voicePropsState.current?.onTranscript?.("Does it work at all?");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Okay. Does it work at all?");
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("submits committed speech when Smart Turn send follows immediately", async () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Okay.");
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
      });
    });

    await waitFor(() => {
      expectSubmission(onSend, "Okay.", "direct");
      expect(textarea.value).toBe("");
    });
  });

  it("holds a Smart Turn auto-send after a manual non-whitespace edit", async () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Hello world.");
    });
    await waitFor(() => expect(textarea.value).toBe("Hello world."));

    // The user types into the composer mid-dictation.
    fireEvent.change(textarea, { target: { value: "Hello world. mine" } });

    // The automatic endpoint send must not submit; the draft is left for review.
    act(() => {
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
        smartTurnAutoSend: true,
      });
    });
    await waitFor(() => expect(textarea.value).toBe("Hello world. mine"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("auto-sends when only speech (not manual typing) filled the draft", async () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    // Speech-inserted finals go through setDraft, not onChange, so they do not
    // count as a manual edit and the auto-send still fires.
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Ship it.");
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
        smartTurnAutoSend: true,
      });
    });
    await waitFor(() => {
      expectSubmission(onSend, "Ship it.", "direct");
      expect(textarea.value).toBe("");
    });
  });

  it("still auto-sends after a whitespace-only manual edit", async () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Go now.");
    });
    await waitFor(() => expect(textarea.value).toBe("Go now."));

    // A trailing space adds no non-whitespace text, so the auto-send proceeds.
    fireEvent.change(textarea, { target: { value: "Go now. " } });
    act(() => {
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
        smartTurnAutoSend: true,
      });
    });
    await waitFor(() => expectSubmission(onSend, "Go now.", "direct"));
  });

  it("submits an explicit spoken send even after a manual edit", async () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Reply done.");
    });
    await waitFor(() => expect(textarea.value).toBe("Reply done."));

    fireEvent.change(textarea, { target: { value: "Reply done. plus" } });

    // An explicit spoken `send` (no smartTurnAutoSend) is never held.
    act(() => {
      voicePropsState.current?.onTranscript?.("", { smartTurnCommand: "send" });
    });
    await waitFor(() => {
      expectSubmission(onSend, "Reply done. plus", "direct");
      expect(textarea.value).toBe("");
    });
  });

  it("hides a stored YA-routed Grok batch method from the method list", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {
        "ya-grok": { streaming: true, smartTurn: true },
      },
    };
    modelSettingsState.speechMethod = YA_GROK_BATCH_SPEECH_METHOD;
    modelSettingsState.hasStoredSpeechMethod = true;
    modelSettingsState.speechSmartTurnSettings = {
      enabled: true,
      threshold: 0.95,
      timeoutMs: 3000,
    };

    renderMessageInput();

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));
    expect(
      screen.queryByRole("radio", {
        name: /^Grok STT through YA batch Browser sends a complete compressed recording through YA to xAI\.$/,
      }),
    ).toBeNull();
    expect(
      screen
        .getByRole("radio", {
          name: /^Grok STT direct Browser streams PCM audio directly to xAI\.$/,
        })
        .getAttribute("aria-checked"),
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
      ...versionState.version,
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

    renderMessageInput();

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));

    expect(screen.getByText("Smart Turn")).toBeDefined();
    expect(screen.queryByText("Grok STT audio")).toBeNull();
  });

  it("hides a stored YA-routed Grok batch method in relay mode", () => {
    remoteBasePathState.basePath = "/ygraehl";
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {
        "ya-grok": { streaming: true, smartTurn: true },
      },
    };
    modelSettingsState.speechMethod = YA_GROK_BATCH_SPEECH_METHOD;
    modelSettingsState.hasStoredSpeechMethod = true;

    renderMessageInput();

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));

    expect(
      screen.queryByRole("radio", {
        name: /^Grok STT through YA batch Browser sends a complete compressed recording through YA to xAI\.$/,
      }),
    ).toBeNull();
  });

  it("keeps Up as native navigation when the composer has text", () => {
    const onRecallLastSubmission = vi.fn(() => true);
    const textarea = renderMessageInput(onRecallLastSubmission);

    fireEvent.change(textarea, { target: { value: "still editing" } });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });

    expect(onRecallLastSubmission).not.toHaveBeenCalled();
  });

  it("recalls with Ctrl+P even when accidental text is present", () => {
    const onRecallLastSubmission = vi.fn(() => true);
    const textarea = renderMessageInput(onRecallLastSubmission);

    fireEvent.change(textarea, { target: { value: "oops" } });
    fireEvent.keyDown(textarea, { key: "p", ctrlKey: true });

    expect(onRecallLastSubmission).toHaveBeenCalledTimes(1);
  });

  it("shows slash suggestions from a leading slash token", () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        slashCommands: ["compact", "goal"],
        onCustomCommand: vi.fn(() => false),
      },
    );

    fireEvent.change(textarea, { target: { value: "/co" } });

    expect(screen.getByRole("menuitem", { name: "/compact" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "/goal" })).toBeNull();
  });

  it("accepts a typed slash suggestion into the composer", () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        slashCommands: ["compact", "goal"],
        onCustomCommand: vi.fn(() => false),
      },
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/co" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("/compact ");
  });

  it("shows the isearch key guide on shortcut help hover while search is active", async () => {
    renderMessageInput();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SESSION_ISEARCH_GUIDE_EVENT, {
          detail: { active: true, scope: "all" },
        }),
      );
    });

    const shortcutsButton = screen.getByRole("button", {
      name: "Session keyboard shortcuts",
    });
    expect(screen.queryByText("Previous match")).toBeNull();
    expect(shortcutsButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.mouseEnter(shortcutsButton);

    expect(await screen.findByText("Previous match")).toBeTruthy();
    expect(screen.getByText("Previous / next match")).toBeTruthy();
    expect(screen.getByText("Match preview / rail mark jumps")).toBeTruthy();
    expect(screen.getByText("Cancel / restore focus")).toBeTruthy();
    expect(screen.getByText("User turns")).toBeTruthy();
    expect(screen.getByText("Full session")).toBeTruthy();
    expect(shortcutsButton.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseLeave(shortcutsButton.parentElement as Element);

    await waitFor(() => {
      expect(screen.queryByText("Previous match")).toBeNull();
    });
    expect(shortcutsButton.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SESSION_ISEARCH_GUIDE_EVENT, {
          detail: { active: false, scope: "all" },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText("Previous match")).toBeNull();
    });
    expect(shortcutsButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the Chrome-safe user search fallback in shortcut help", async () => {
    renderMessageInput();

    fireEvent.click(
      screen.getByRole("button", { name: "Session keyboard shortcuts" }),
    );

    const row = screen
      .getByText("User-turn reverse search")
      .closest(".session-shortcuts-row");
    const keys = Array.from(row?.querySelectorAll("kbd") ?? []).map(
      (key) => key.textContent,
    );

    expect(keys).toEqual(["Ctrl", "R", "Ctrl", "Alt", "R"]);
  });

  it("shows the full-session search shortcut in shortcut help", async () => {
    renderMessageInput();

    fireEvent.click(
      screen.getByRole("button", { name: "Session keyboard shortcuts" }),
    );

    const row = screen
      .getByText("Full-session reverse search")
      .closest(".session-shortcuts-row");
    const keys = Array.from(row?.querySelectorAll("kbd") ?? []).map(
      (key) => key.textContent,
    );

    expect(keys).toEqual(["Ctrl", "Alt", "S"]);
  });

  it("hides stop while a running composer has queued text", () => {
    const onStop = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        isRunning: true,
        isThinking: true,
        onQueue: vi.fn(),
        onStop,
      },
    );

    fireEvent.change(textarea, { target: { value: "still editable" } });

    expect(screen.getByLabelText("toolbarQueueLabel")).toBeTruthy();
    expect(screen.queryByLabelText("toolbarStop")).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("stops the current turn with Escape from the composer", () => {
    const onStop = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        isRunning: true,
        isThinking: true,
        onStop,
      },
    );

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("stops active voice capture with Escape before stopping the current turn", () => {
    voiceButtonState.isListening = true;
    const onStop = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        isRunning: true,
        isThinking: true,
        onStop,
      },
    );

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(mockVoiceStopAndFinalize).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("leaves Escape alone when the current turn is not stoppable", () => {
    const onStop = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        isRunning: true,
        isThinking: false,
        onStop,
      },
    );

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onStop).not.toHaveBeenCalled();
  });

  it("cancels the newest queued message with Ctrl+K", () => {
    const onCancelLatestDeferred = vi.fn(() => true);
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onCancelLatestDeferred,
      },
    );

    fireEvent.keyDown(textarea, { key: "k", ctrlKey: true });

    expect(onCancelLatestDeferred).toHaveBeenCalledTimes(1);
  });

  it("starts a /btw aside with Ctrl+B and clears accepted text", () => {
    const onBtwShortcut = vi.fn(() => true);
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onBtwShortcut,
      },
    );

    fireEvent.change(textarea, { target: { value: "side question" } });
    fireEvent.keyDown(textarea, { key: "b", ctrlKey: true });

    expect(onBtwShortcut).toHaveBeenCalledWith("side question");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps Ctrl+B text when /btw is not accepted", () => {
    const onBtwShortcut = vi.fn(() => false);
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onBtwShortcut,
      },
    );

    fireEvent.change(textarea, { target: { value: "not supported" } });
    fireEvent.keyDown(textarea, { key: "b", ctrlKey: true });

    expect(onBtwShortcut).toHaveBeenCalledWith("not supported");
    expect((textarea as HTMLTextAreaElement).value).toBe("not supported");
  });

  it("starts a /btw aside from the toolbar button", () => {
    const onBtwShortcut = vi.fn(() => true);
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onBtwShortcut,
      },
    );

    fireEvent.change(textarea, { target: { value: "tap target" } });
    fireEvent.click(screen.getByRole("button", { name: /Start \/btw aside/ }));

    expect(onBtwShortcut).toHaveBeenCalledWith("tap target");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("marks the /btw toolbar button active for focused aside mode", () => {
    const onBtwShortcut = vi.fn(() => false);
    renderMessageInput(
      vi.fn(() => true),
      {
        btwActive: true,
        onBtwShortcut,
      },
    );

    const button = screen.getByRole("button", {
      name: /Composer is focused on a \/btw aside/,
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);

    expect(onBtwShortcut).toHaveBeenCalledWith("");
  });

  it("marks a focused /btw pane without claiming footer routing", () => {
    const onBtwShortcut = vi.fn(() => false);
    renderMessageInput(
      vi.fn(() => true),
      {
        btwToolbarMode: "focused-pane",
        onBtwShortcut,
      },
    );

    const button = screen.getByRole("button", {
      name: /click to focus its composer/,
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);

    expect(onBtwShortcut).toHaveBeenCalledWith("");
  });

  it("lets a pane-focused /btw click move focus after footer refocus", () => {
    vi.useFakeTimers();
    const paneComposer = document.createElement("textarea");
    document.body.append(paneComposer);
    const onBtwShortcut = vi.fn(() => {
      window.setTimeout(() => paneComposer.focus(), 0);
      return false;
    });
    renderMessageInput(
      vi.fn(() => true),
      {
        btwToolbarMode: "focused-pane",
        onBtwShortcut,
      },
    );

    try {
      fireEvent.click(
        screen.getByRole("button", { name: /click to focus its composer/ }),
      );
      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(document.activeElement).toBe(paneComposer);
    } finally {
      paneComposer.remove();
    }
  });

  it("marks the /btw toolbar button when an aside can be focused", () => {
    renderMessageInput(
      vi.fn(() => true),
      {
        btwHasAsides: true,
        onBtwShortcut: vi.fn(() => false),
      },
    );

    const button = screen.getByRole("button", {
      name: /Focus existing \/btw aside/,
    });

    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("clears the composer with Ctrl+G through the textarea undo stack", () => {
    const previousExecCommand = document.execCommand;
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const textarea = renderMessageInput();

    try {
      fireEvent.change(textarea, { target: { value: "undoable draft" } });
      fireEvent.keyDown(textarea, { key: "g", ctrlKey: true });

      expect(execCommand).toHaveBeenCalledWith("delete");
      expect((textarea as HTMLTextAreaElement).value).toBe("");
    } finally {
      if (previousExecCommand) {
        Object.defineProperty(document, "execCommand", {
          configurable: true,
          value: previousExecCommand,
        });
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  });

  it("shows stale last activity in the composer chrome", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:06:00.000Z"));

    renderMessageInput(
      vi.fn(() => true),
      {
        lastActivityAt: "2026-04-26T12:00:00.000Z",
      },
    );

    expect(screen.getByText("6m ago")).toBeTruthy();
  });

  it("uses compact last-activity wording before 30 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:28:00.000Z"));

    renderMessageInput(
      vi.fn(() => true),
      {
        lastActivityAt: "2026-04-26T12:20:00.000Z",
      },
    );

    expect(screen.getByText("8m ago")).toBeTruthy();
    expect(screen.queryByText("Last activity 8m ago")).toBeNull();
  });

  it("keeps long-form last activity wording after 30 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:35:00.000Z"));

    renderMessageInput(
      vi.fn(() => true),
      {
        lastActivityAt: "2026-04-26T12:00:00.000Z",
      },
    );

    expect(screen.getByText("Last activity 35m")).toBeTruthy();
  });

  it("keeps ok liveness from duplicating stale last-activity age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:06:00.000Z"));

    renderMessageInput(
      vi.fn(() => true),
      {
        lastActivityAt: "2026-04-26T12:00:00.000Z",
        sessionLiveness: {
          checkedAt: "2026-04-26T12:06:00.000Z",
          derivedStatus: "verified-progressing",
          activeWorkKind: "agent-turn",
          state: "in-turn",
          evidence: ["provider-message"],
          lastProviderMessageAt: "2026-04-26T12:01:00.000Z",
          lastRawProviderEventAt: null,
          lastRawProviderEventSource: null,
          lastStateChangeAt: "2026-04-26T11:59:00.000Z",
          lastVerifiedProgressAt: "2026-04-26T12:01:00.000Z",
          lastVerifiedIdleAt: null,
          lastLivenessProbeAt: null,
          lastLivenessProbeStatus: null,
          lastLivenessProbeSource: null,
          silenceMs: 300_000,
          longSilenceThresholdMs: 300_000,
          processAlive: true,
          queueDepth: 0,
          deferredQueueDepth: 0,
        },
      },
    );

    expect(
      screen.queryByLabelText(
        "Session verified liveness: Verified progress 5m ago",
      ),
    ).toBeNull();
    expect(screen.queryByText("Verified progress 5m")).toBeNull();
    expect(screen.getByText("6m ago")).toBeTruthy();
  });

  it("keeps a send affordance visible when the composer is collapsed", () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        collapsed: true,
        placeholder: "messageInputContinueAbove",
      },
    );

    fireEvent.change(textarea, { target: { value: "collapsed send" } });
    fireEvent.click(screen.getByLabelText("toolbarSend"));

    expectSubmission(onSend, "collapsed send", "direct");
  });

  it("keeps a queue affordance visible when the running composer is collapsed", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onQueue,
        collapsed: true,
        placeholder: "messageInputContinueAbove",
      },
    );

    fireEvent.change(textarea, { target: { value: "collapsed queue" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "collapsed queue", "deferred");
  });

  it("keeps the collapsed composer scrolled to the cursor", async () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        collapsed: true,
      },
    ) as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(textarea, "clientHeight", {
      configurable: true,
      value: 28,
    });

    fireEvent.change(textarea, {
      target: { value: "one\ntwo\nthree\nfour\nfive" },
    });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.keyUp(textarea, { key: "End" });

    await waitFor(() => expect(textarea.scrollTop).toBe(152));
  });

  it("uses the server default busy composer action", () => {
    const restoreMatchMedia = installDesktopMatchMedia();
    versionState.version = {
      ...versionState.version,
      clientDefaults: { busyComposerDefaultAction: "queue" },
    };
    const onSend = vi.fn();
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        onQueue,
        supportsSteering: true,
      },
    );

    try {
      fireEvent.change(textarea, { target: { value: "default queue" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expect(onSend).not.toHaveBeenCalled();
      expectSubmission(onQueue, "default queue", "deferred");
    } finally {
      restoreMatchMedia();
    }
  });

  it("keeps session-local Enter swaps ahead of the server default", () => {
    const restoreMatchMedia = installDesktopMatchMedia();
    versionState.version = {
      ...versionState.version,
      clientDefaults: { busyComposerDefaultAction: "queue" },
    };
    window.localStorage.setItem("test-draft:enter-action-kind", "steer");
    const onSend = vi.fn();
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        onQueue,
        supportsSteering: true,
      },
    );

    try {
      fireEvent.change(textarea, { target: { value: "local steer" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expectSubmission(onSend, "local steer", "steer");
      expect(onQueue).not.toHaveBeenCalled();
    } finally {
      restoreMatchMedia();
    }
  });

  it("can show the alternate collapsed action", () => {
    versionState.version = {
      ...versionState.version,
      clientDefaults: { collapsedComposerButton: "alternate" },
    };
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onQueue,
        supportsSteering: true,
        collapsed: true,
      },
    );

    fireEvent.change(textarea, { target: { value: "alternate queue" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "alternate queue", "deferred");
  });

  it("can use the microphone as the collapsed action", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
      clientDefaults: { collapsedComposerButton: "microphone" },
    };

    renderMessageInput(
      vi.fn(() => true),
      { collapsed: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "voice" }));

    expect(mockVoiceToggle).toHaveBeenCalledTimes(1);
  });

  it("uses desktop collapsed side space for line count and server mic", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
    };
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        collapsed: true,
      },
    );

    fireEvent.change(textarea, { target: { value: "one\ntwo\nthree" } });

    expect(screen.getByText("3 lines")).toBeTruthy();
    expect(screen.getByRole("button", { name: "voice" })).toBeTruthy();
  });

  it("queues steering-capable messages without adding a mode prefix", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    fireEvent.change(textarea, { target: { value: "follow up later" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "follow up later", "deferred");
  });

  it("preserves manually typed when-done text as a normal queue message", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    fireEvent.change(textarea, {
      target: { value: "when done, already manual" },
    });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "when done, already manual", "deferred");
  });

  it("Ctrl+Enter queues without adding patient wording by default", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    fireEvent.change(textarea, { target: { value: "follow up later" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expectSubmission(onQueue, "follow up later", "deferred");
  });

  it("leaves a button-click queue unprefixed and deferred", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    fireEvent.change(textarea, { target: { value: "follow up later" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "follow up later", "deferred");
  });

  it("stamps steer-now metadata when the Claude now checkbox is enabled", () => {
    const restoreMatchMedia = installDesktopMatchMedia();
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        supportsSteering: true,
        supportsSteerNow: true,
        onQueue: vi.fn(),
      },
    );

    try {
      fireEvent.click(screen.getByRole("checkbox", { name: "Steer now" }));
      fireEvent.change(textarea, { target: { value: "interrupt softly" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expectSubmission(onSend, "interrupt softly", "steer");
      expect(onSend.mock.calls.at(-1)?.[1]).toMatchObject({
        steerNow: true,
      });
    } finally {
      restoreMatchMedia();
    }
  });

  it("routes a queue-only primary button through onSend", () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        primaryActionKind: "queue",
      },
    );

    const primaryButton = screen.getByLabelText("toolbarQueueLabel");
    expect(primaryButton.getAttribute("data-tooltip")).toContain(
      "toolbarQueueTooltip",
    );

    fireEvent.change(textarea, { target: { value: "claude queue click" } });
    fireEvent.click(primaryButton);

    expectSubmission(onSend, "claude queue click", "deferred");
  });

  it("routes Enter through a queue-only primary action", () => {
    const restoreMatchMedia = installDesktopMatchMedia();
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        primaryActionKind: "queue",
      },
    );

    try {
      fireEvent.change(textarea, { target: { value: "claude queue enter" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expectSubmission(onSend, "claude queue enter", "deferred");
    } finally {
      restoreMatchMedia();
    }
  });

  it("keeps non-steering queue text unchanged", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      { onQueue },
    );

    fireEvent.change(textarea, { target: { value: "plain queue" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "plain queue", "deferred");
  });

  it("uses patient intent when the patient-queue default is enabled", () => {
    versionState.version = {
      ...versionState.version,
      clientDefaults: { patientQueueDefault: true },
    };
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      { onQueue },
    );

    fireEvent.change(textarea, { target: { value: "claude patient queue" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "claude patient queue", "patient");
  });

  it("keeps queue available when the primary steer action downgrades", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
        primaryActionKind: "queue",
      },
    );

    fireEvent.change(textarea, { target: { value: "queue fallback" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expect(screen.getAllByLabelText("toolbarQueueLabel")).toHaveLength(1);
    expectSubmission(onQueue, "queue fallback", "deferred");
  });

  it("routes the primary downgraded steer action to queue", () => {
    const onQueue = vi.fn();
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        supportsSteering: true,
        onQueue,
        primaryActionKind: "queue",
      },
    );

    fireEvent.change(textarea, { target: { value: "queue from primary" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expect(onSend).not.toHaveBeenCalled();
    expectSubmission(onQueue, "queue from primary", "deferred");
  });

  it("renders context usage as passive status chrome", () => {
    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{ ...toolbarVisibility, contextUsage: true }}
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{
          contextUsage: {
            inputTokens: 42_000,
            percentage: 42,
            contextWindow: 100_000,
          },
        }}
      />,
    );

    const indicator = container.querySelector(".context-usage-indicator");
    expect(indicator).toBeTruthy();
    expect(indicator?.closest("button")).toBe(null);
  });

  it("renders the active speech waveform in the toolbar center slot", () => {
    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={toolbarVisibility}
        speechWaveformActive
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{}}
      />,
    );

    const toolbar = container.querySelector(".message-input-toolbar");
    const waveform = container.querySelector(".composer-speech-waveform");
    expect(waveform).toBeTruthy();
    expect(
      waveform?.parentElement?.classList.contains("message-input-left"),
    ).toBe(true);
    expect(toolbar?.contains(waveform)).toBe(true);
  });

  it("uses only the custom tooltip on the primary send action", () => {
    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={toolbarVisibility}
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "steer",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{
          send: {
            onSend: vi.fn(),
            canSend: true,
            primaryActionKind: "steer",
            primaryActionLabel: "Steer current turn",
            tooltip: "Steer current turn\nEnter",
            icon: "↗",
          },
        }}
      />,
    );

    const button = screen.getByRole("button", { name: "Steer current turn" });
    expect(button.getAttribute("data-tooltip")).toBe(
      "Steer current turn\nEnter",
    );
    expect(button.getAttribute("title")).toBe(null);
    expect(container.querySelector(".send-button-with-help")).toBe(button);
  });

  it("opens a bottom-row overflow strip for lower-priority controls", () => {
    const onRenderToggle = vi.fn();
    const onNudgeClick = vi.fn();
    const setShortcutsOpen = vi.fn();

    render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{
          ...toolbarVisibility,
          thinkingToggle: false,
          renderMode: true,
          shortcutsHelp: true,
          nudge: true,
        }}
        attachmentControl={{ attachmentCount: 0 }}
        renderModeControl={{
          state: "mixed",
          title: "Toggle rendered output",
          onToggle: onRenderToggle,
        }}
        nudgeControl={{
          enabled: true,
          title: "Pulse after quiet",
          onClick: onNudgeClick,
          onContextMenu: vi.fn(),
          onTouchStart: vi.fn(),
          onTouchEnd: vi.fn(),
          onClearTouch: vi.fn(),
        }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            setShortcutsOpen as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{
          send: {
            onSend: vi.fn(),
            canSend: true,
            primaryActionKind: "send",
            primaryActionLabel: "Send",
            tooltip: "Send",
            icon: "↑",
          },
        }}
      />,
    );

    const overflow = screen.getByRole("button", {
      name: "More toolbar controls",
    });
    expect(overflow.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(overflow);

    expect(overflow.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText("Toggle rendered output").at(-1)!);
    fireEvent.click(screen.getAllByLabelText("Pulse after quiet").at(-1)!);
    fireEvent.click(
      screen.getAllByLabelText("Session keyboard shortcuts").at(-1)!,
    );

    expect(onRenderToggle).toHaveBeenCalledTimes(1);
    expect(onNudgeClick).toHaveBeenCalledTimes(1);
    expect(setShortcutsOpen).toHaveBeenCalledTimes(1);
  });
});
