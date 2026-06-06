// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ComponentProps, useCallback, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_ISEARCH_GUIDE_EVENT } from "../../lib/sessionIsearchGuide";
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
}));

vi.mock("../../hooks/useDraftPersistence", () => ({
  useDraftPersistence: () => {
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
      attachments: true,
      slashMenu: true,
      thinkingToggle: true,
      renderMode: true,
      microphone: true,
      shortcutsHelp: true,
      contextUsage: true,
      btw: true,
      nudge: true,
      queueControls: true,
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

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (
        {
          commonOr: "or",
          toolbarKeyboardShortcutsAria: "Session keyboard shortcuts",
          toolbarPatientQueueEnable: "Use patient queue",
          toolbarPatientQueueDisable: "Use regular queue",
          toolbarPatientQueueEnabledAck:
            "Patient queue on. Click again for regular queue.",
          toolbarPatientQueueDisabledAck:
            "Regular queue on. Click again for patient queue.",
          toolbarPatientQueueActionLabel: "Queue patiently",
          toolbarPatientQueueConfiguredTimeout: "the configured timeout",
          toolbarPatientQueueToggleShortcut:
            "Right-click or long-press a queue button to switch regular/patient queue.",
          toolbarPatientQueueTooltip:
            `Patient queue waits for ${params?.timeout ?? ""} of verified quiet before delivery. Regular queued messages may pass patient messages.`,
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
          toolbarShortcutPreviewRailJumps:
            "Match preview / rail mark jumps",
          toolbarShortcutCancelRestoreFocus: "Cancel / restore focus",
          toolbarShortcutScrollToCurrent: "Scroll to current",
          toolbarShortcutUserTurnReverseSearch:
            "User-turn reverse search",
          toolbarShortcutAllTurnReverseSearch: "All-turn reverse search",
          toolbarShortcutFullSessionReverseSearch:
            "Full-session reverse search",
          toolbarShortcutSteerCurrentTurn: "Steer current turn",
          toolbarShortcutQueueCurrentTurn: "Queue message",
          toolbarShortcutSend: "Send",
          toolbarShortcutNewLine: "New line",
          toolbarShortcutRightClickLongPress: "Right-click / long-press ?",
          toolbarShortcutChangeKeys: "Change keys",
          toolbarShortcutSwapEnterCtrlEnter: "Swap Enter and Ctrl+Enter",
          toolbarShortcutStartBtwAside: "Start /btw aside",
          toolbarShortcutStopAgentCancelOverlay:
            "Stop agent / cancel overlay",
          toolbarShortcutRecallLastSentText: "Recall last sent text",
          toolbarShortcutCancelLatestQueuedMessage:
            "Cancel latest queued message",
          toolbarShortcutClearComposer: "Clear composer",
          toolbarShortcutRenderedSourceMode: "Rendered/source mode",
        } satisfies Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("../VoiceInputButton", async () => {
  const React = await import("react");

  return {
    VoiceInputButton: React.forwardRef(
      (props: { speechMethod?: string }, ref) => {
        React.useImperativeHandle(ref, () => ({
          stopAndFinalize: () => "",
          toggle: mockVoiceToggle,
          isAvailable: true,
          isListening: false,
        }));

        return (
          <button type="button" data-speech-method={props.speechMethod}>
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
    extraProps.collapsed ? "messageInputContinueAbove" : placeholder,
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
  attachments: false,
  slashMenu: false,
  thinkingToggle: true,
  renderMode: false,
  microphone: false,
  shortcutsHelp: false,
  contextUsage: false,
  btw: false,
  nudge: false,
  queueControls: false,
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
  };
  return translations[key] ?? key;
}) as MessageInputToolbarViewProps["t"];

function renderToolbarView(
  thinkingControl: MessageInputToolbarViewProps["thinkingControl"],
) {
  render(
    <MessageInputToolbarView
      t={toolbarT}
      visibility={toolbarVisibility}
      attachmentControl={{ attachmentCount: 0 }}
      thinkingControl={thinkingControl}
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
    versionState.version = {
      current: "test",
      latest: null,
      updateAvailable: false,
      capabilities: ["voiceInput"],
      voiceBackends: [],
      voiceBackendCapabilities: {},
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
    mockSetSpeechMethod.mockReset();
    mockSetThinkingMode.mockReset();
    mockSetEffortLevel.mockReset();
    mockSetSpeechSmartTurnSettings.mockReset();
    mockSetGrokSpeechAudioSettings.mockReset();
    mockVoiceToggle.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("selects the preferred active server STT backend for the mic button", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-deepgram", "ya-grok"],
    };

    renderMessageInput();

    expect(
      screen.getByRole("button", { name: "voice" }).dataset.speechMethod,
    ).toBe("ya-grok");

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));
    expect(screen.getByRole("radio", { name: /Grok STT/ })).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: /Deepgram STT/ }));

    expect(mockSetSpeechMethod).toHaveBeenCalledWith("ya-deepgram");
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

  it("shows Grok audio format controls and hides Smart Turn on compressed uplink", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {
        "ya-grok": { streaming: true, smartTurn: true },
      },
    };
    modelSettingsState.speechMethod = "ya-grok";
    modelSettingsState.hasStoredSpeechMethod = true;
    modelSettingsState.speechSmartTurnSettings = {
      enabled: true,
      threshold: 0.95,
      timeoutMs: 3000,
    };
    modelSettingsState.grokSpeechAudioSettings = {
      uplinkMode: "browser-compressed",
    };

    renderMessageInput();

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));
    expect(screen.getByText("Grok STT audio")).toBeDefined();
    expect(
      (screen.getByLabelText("Compressed") as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByText("Smart Turn")).toBeNull();

    fireEvent.click(screen.getByLabelText("PCM16"));
    expect(mockSetGrokSpeechAudioSettings).toHaveBeenCalledWith({
      uplinkMode: "pcm16",
    });
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

  it("keeps stop available while a running composer has queued text", () => {
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

    fireEvent.click(screen.getByLabelText("toolbarStop"));

    expect(screen.getByLabelText("toolbarQueueLabel")).toBeTruthy();
    expect(onStop).toHaveBeenCalledTimes(1);
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

  it("queues steering-capable messages without adding a mode prefix", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    expect(
      screen.getByRole("button", { name: "Use patient queue" }),
    ).toBeTruthy();

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

  it("uses patient intent without rewriting text when the stopwatch is enabled", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    const toggle = screen.getByRole("button", { name: "Use patient queue" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(
      screen
        .getByRole("button", { name: "Use regular queue" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("status").textContent).toContain(
      "Patient queue on",
    );
    fireEvent.change(textarea, { target: { value: "follow up later" } });
    fireEvent.click(screen.getByLabelText("Queue patiently"));

    expectSubmission(onQueue, "follow up later", "patient");
  });

  it("keeps the patient switch visible for idle steering sessions", () => {
    renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
      },
    );

    expect(
      screen
        .getByRole("button", { name: "Use patient queue" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.getByLabelText("toolbarSend")).toBeTruthy();
    expect(screen.queryByLabelText("toolbarQueueLabel")).toBeNull();
  });

  it("keeps manually typed when-done text unchanged for patient queue", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Use patient queue" }),
    );
    fireEvent.change(textarea, {
      target: { value: "When done please run tests" },
    });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expectSubmission(onQueue, "When done please run tests", "patient");
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
    expect(primaryButton.getAttribute("title")).toContain("toolbarQueueTooltip");

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

    expect(
      screen.getByRole("button", { name: "Use patient queue" }),
    ).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "plain queue" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "plain queue", "deferred");
  });

  it("uses patient intent for non-steering queued messages", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      { onQueue },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Use patient queue" }),
    );
    fireEvent.change(textarea, { target: { value: "claude patient queue" } });
    fireEvent.click(screen.getByLabelText("Queue patiently"));

    expectSubmission(onQueue, "claude patient queue", "patient");
  });

  it("changes the single queue primary action when patient mode is on", () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        primaryActionKind: "queue",
      },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Use patient queue" }),
    );
    fireEvent.change(textarea, { target: { value: "single patient action" } });

    const patientAction = screen.getByLabelText("Queue patiently");
    expect(patientAction.className).toContain("patient-queue-action");
    fireEvent.click(patientAction);

    expectSubmission(onSend, "single patient action", "patient");
  });

  it("right-clicking a queue button toggles patient mode without sending", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    fireEvent.change(textarea, { target: { value: "patient mode switch" } });
    fireEvent.contextMenu(screen.getByLabelText("toolbarQueueLabel"));

    expect(onQueue).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: "Use regular queue" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByLabelText("Queue patiently")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Patient queue on",
    );
  });

  it("keeps patient queue visible for a stoppable non-steering turn before text", () => {
    renderMessageInput(
      vi.fn(() => true),
      {
        isRunning: true,
        isThinking: true,
        onQueue: vi.fn(),
        onStop: vi.fn(),
      },
    );

    expect(screen.getByLabelText("toolbarStop")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Use patient queue" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("toolbarQueueLabel").hasAttribute("disabled"))
      .toBe(true);
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
});
