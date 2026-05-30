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

const { versionState, modelSettingsState, mockSetSpeechMethod } = vi.hoisted(
  () => ({
    versionState: {
      version: {
        current: "test",
        latest: null,
        updateAvailable: false,
        capabilities: ["voiceInput"],
        voiceBackends: [] as string[],
      },
    },
    modelSettingsState: {
      speechMethod: "browser-native",
      hasStoredSpeechMethod: false,
    },
    mockSetSpeechMethod: vi.fn(),
  }),
);

vi.mock("../../hooks/useDraftPersistence", () => ({
  useDraftPersistence: () => {
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
    voiceInputEnabled: true,
    speechMethod: modelSettingsState.speechMethod,
    hasStoredSpeechMethod: modelSettingsState.hasStoredSpeechMethod,
    setSpeechMethod: mockSetSpeechMethod,
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
    t: (key: string) => key,
  }),
}));

vi.mock("../VoiceInputButton", async () => {
  const React = await import("react");

  return {
    VoiceInputButton: React.forwardRef(
      (props: { speechMethod?: string }, ref) => {
        React.useImperativeHandle(ref, () => ({
          stopAndFinalize: () => "",
          toggle: vi.fn(),
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

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(window, "localStorage");

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
  });

  return {
    store,
    restore: () => {
      if (previous) {
        Object.defineProperty(window, "localStorage", previous);
      } else {
        Reflect.deleteProperty(window, "localStorage");
      }
    },
  };
}

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

describe("MessageInput", () => {
  beforeEach(() => {
    versionState.version = {
      current: "test",
      latest: null,
      updateAvailable: false,
      capabilities: ["voiceInput"],
      voiceBackends: [],
    };
    modelSettingsState.speechMethod = "browser-native";
    modelSettingsState.hasStoredSpeechMethod = false;
    mockSetSpeechMethod.mockReset();
  });

  afterEach(() => {
    cleanup();
    window.localStorage?.removeItem?.("test-draft:patient-queue-mode");
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

  it("selects the preferred active server STT backend for the mic button", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-deepgram", "ya-grok"],
    };

    renderMessageInput();

    expect(screen.getByText("YA Grok")).toBeDefined();
    expect(screen.getByRole("button", { name: "voice" }).dataset.speechMethod).toBe(
      "ya-grok",
    );

    fireEvent.click(screen.getByText("YA Grok").closest("button")!);
    fireEvent.click(screen.getByText("YA Deepgram").closest("button")!);

    expect(mockSetSpeechMethod).toHaveBeenCalledWith("ya-deepgram");
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

  it("shows the isearch key guide from the shortcut help while search is active", async () => {
    renderMessageInput();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SESSION_ISEARCH_GUIDE_EVENT, {
          detail: { active: true, scope: "all" },
        }),
      );
    });

    expect(await screen.findByText("Previous match")).toBeTruthy();
    expect(screen.getByText("Cancel / restore focus")).toBeTruthy();
    expect(screen.getByText("User turns")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Session keyboard shortcuts" })
        .getAttribute("aria-expanded"),
    ).toBe("true");

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
    expect(
      screen
        .getByRole("button", { name: "Session keyboard shortcuts" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
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

  it("keeps stop available while a running composer has queued text", () => {
    const onStop = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), {
      isRunning: true,
      isThinking: true,
      onQueue: vi.fn(),
      onStop,
    });

    fireEvent.change(textarea, { target: { value: "still editable" } });

    fireEvent.click(screen.getByLabelText("toolbarStop"));

    expect(screen.getByLabelText("toolbarQueueLabel")).toBeTruthy();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("stops the current turn with Escape from the composer", () => {
    const onStop = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), {
      isRunning: true,
      isThinking: true,
      onStop,
    });

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape alone when the current turn is not stoppable", () => {
    const onStop = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), {
      isRunning: true,
      isThinking: false,
      onStop,
    });

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onStop).not.toHaveBeenCalled();
  });

  it("cancels the newest queued message with Ctrl+K", () => {
    const onCancelLatestDeferred = vi.fn(() => true);
    const textarea = renderMessageInput(vi.fn(() => true), {
      onCancelLatestDeferred,
    });

    fireEvent.keyDown(textarea, { key: "k", ctrlKey: true });

    expect(onCancelLatestDeferred).toHaveBeenCalledTimes(1);
  });

  it("starts a /btw aside with Ctrl+B and clears accepted text", () => {
    const onBtwShortcut = vi.fn(() => true);
    const textarea = renderMessageInput(vi.fn(() => true), {
      onBtwShortcut,
    });

    fireEvent.change(textarea, { target: { value: "side question" } });
    fireEvent.keyDown(textarea, { key: "b", ctrlKey: true });

    expect(onBtwShortcut).toHaveBeenCalledWith("side question");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps Ctrl+B text when /btw is not accepted", () => {
    const onBtwShortcut = vi.fn(() => false);
    const textarea = renderMessageInput(vi.fn(() => true), {
      onBtwShortcut,
    });

    fireEvent.change(textarea, { target: { value: "not supported" } });
    fireEvent.keyDown(textarea, { key: "b", ctrlKey: true });

    expect(onBtwShortcut).toHaveBeenCalledWith("not supported");
    expect((textarea as HTMLTextAreaElement).value).toBe("not supported");
  });

  it("starts a /btw aside from the toolbar button", () => {
    const onBtwShortcut = vi.fn(() => true);
    const textarea = renderMessageInput(vi.fn(() => true), {
      onBtwShortcut,
    });

    fireEvent.change(textarea, { target: { value: "tap target" } });
    fireEvent.click(screen.getByRole("button", { name: /Start \/btw aside/ }));

    expect(onBtwShortcut).toHaveBeenCalledWith("tap target");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("marks the /btw toolbar button active for focused aside mode", () => {
    const onBtwShortcut = vi.fn(() => false);
    renderMessageInput(vi.fn(() => true), {
      btwActive: true,
      onBtwShortcut,
    });

    const button = screen.getByRole("button", {
      name: /Composer is focused on a \/btw aside/,
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);

    expect(onBtwShortcut).toHaveBeenCalledWith("");
  });

  it("marks a focused /btw pane without claiming footer routing", () => {
    const onBtwShortcut = vi.fn(() => false);
    renderMessageInput(vi.fn(() => true), {
      btwToolbarMode: "focused-pane",
      onBtwShortcut,
    });

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
    renderMessageInput(vi.fn(() => true), {
      btwToolbarMode: "focused-pane",
      onBtwShortcut,
    });

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
    renderMessageInput(vi.fn(() => true), {
      btwHasAsides: true,
      onBtwShortcut: vi.fn(() => false),
    });

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

    renderMessageInput(vi.fn(() => true), {
      lastActivityAt: "2026-04-26T12:00:00.000Z",
    });

    expect(screen.getByText("6m ago")).toBeTruthy();
  });

  it("uses compact last-activity wording before 30 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:28:00.000Z"));

    renderMessageInput(vi.fn(() => true), {
      lastActivityAt: "2026-04-26T12:20:00.000Z",
    });

    expect(screen.getByText("8m ago")).toBeTruthy();
    expect(screen.queryByText("Last activity 8m ago")).toBeNull();
  });

  it("keeps long-form last activity wording after 30 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:35:00.000Z"));

    renderMessageInput(vi.fn(() => true), {
      lastActivityAt: "2026-04-26T12:00:00.000Z",
    });

    expect(screen.getByText("Last activity 35m")).toBeTruthy();
  });

  it("keeps ok liveness from duplicating stale last-activity age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:06:00.000Z"));

    renderMessageInput(vi.fn(() => true), {
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
    });

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
    const textarea = renderMessageInput(vi.fn(() => true), {
      onSend,
      collapsed: true,
      placeholder: "messageInputContinueAbove",
    });

    fireEvent.change(textarea, { target: { value: "collapsed send" } });
    fireEvent.click(screen.getByLabelText("toolbarSend"));

    expectSubmission(onSend, "collapsed send", "direct");
  });

  it("keeps a queue affordance visible when the running composer is collapsed", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), {
      onQueue,
      collapsed: true,
      placeholder: "messageInputContinueAbove",
    });

    fireEvent.change(textarea, { target: { value: "collapsed queue" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "collapsed queue", "deferred");
  });

  it("defaults steering-capable queue to patient mode", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), {
      supportsSteering: true,
      onQueue,
    });

    const modeToggle = screen.getByRole("button", { name: "Queue when done" });
    expect(modeToggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(textarea, { target: { value: "follow up later" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "when done, follow up later", "patient");
  });

  it("does not double-prefix patient queued text", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), {
      supportsSteering: true,
      onQueue,
    });

    fireEvent.change(textarea, {
      target: { value: "when done, already patient" },
    });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "when done, already patient", "patient");
  });

  it("can queue ASAP unchanged from a steering-capable composer", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), {
      supportsSteering: true,
      onQueue,
    });

    fireEvent.click(screen.getByRole("button", { name: "Queue when done" }));
    expect(
      screen.getByRole("button", { name: "Queue ASAP" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("false");
    expect(screen.getByLabelText("toolbarQueueLabel").getAttribute("title")).toBe(
      "Queue ASAP",
    );

    fireEvent.change(textarea, { target: { value: "run next" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "run next", "deferred");
  });

  it("routes a queue-only primary button through onSend", () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), {
      onSend,
      primaryActionKind: "queue",
    });

    const primaryButton = screen.getByLabelText("toolbarQueueLabel");
    expect(primaryButton.getAttribute("title")).toBe("Queue ASAP");

    fireEvent.change(textarea, { target: { value: "claude queue click" } });
    fireEvent.click(primaryButton);

    expectSubmission(onSend, "claude queue click", "deferred");
  });

  it("routes Enter through a queue-only primary action", () => {
    const restoreMatchMedia = installDesktopMatchMedia();
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), {
      onSend,
      primaryActionKind: "queue",
    });

    try {
      fireEvent.change(textarea, { target: { value: "claude queue enter" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expectSubmission(onSend, "claude queue enter", "deferred");
    } finally {
      restoreMatchMedia();
    }
  });

  it("persists patient queue mode per draft", () => {
    const storage = installMemoryLocalStorage();

    try {
      renderMessageInput(vi.fn(() => true), {
        supportsSteering: true,
        onQueue: vi.fn(),
      });

      fireEvent.click(screen.getByRole("button", { name: "Queue when done" }));
      expect(storage.store.get("test-draft:patient-queue-mode")).toBe("asap");

      cleanup();

      renderMessageInput(vi.fn(() => true), {
        supportsSteering: true,
        onQueue: vi.fn(),
      });

      expect(
        screen.getByRole("button", { name: "Queue ASAP" }).getAttribute(
          "aria-pressed",
        ),
      ).toBe("false");
    } finally {
      storage.restore();
    }
  });

  it("keeps non-steering queue text unchanged", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), { onQueue });

    expect(
      screen.queryByRole("button", { name: "Queue when done" }),
    ).toBeNull();

    fireEvent.change(textarea, { target: { value: "plain queue" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "plain queue", "deferred");
  });

  it("keeps queue available when the primary steer action downgrades", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), {
      supportsSteering: true,
      onQueue,
      primaryActionKind: "queue",
    });

    fireEvent.change(textarea, { target: { value: "queue fallback" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expect(screen.getAllByLabelText("toolbarQueueLabel")).toHaveLength(1);
    expectSubmission(onQueue, "when done, queue fallback", "patient");
  });

  it("routes the primary downgraded steer action to queue", () => {
    const onQueue = vi.fn();
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(() => true), {
      onSend,
      supportsSteering: true,
      onQueue,
      primaryActionKind: "queue",
    });

    fireEvent.change(textarea, { target: { value: "queue from primary" } });
    fireEvent.click(screen.getByLabelText("Queue from primary action"));

    expect(onSend).not.toHaveBeenCalled();
    expectSubmission(onQueue, "when done, queue from primary", "patient");
  });
});
