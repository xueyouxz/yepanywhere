// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentContentProvider } from "../../contexts/AgentContentContext";
import { RenderModeProvider } from "../../contexts/RenderModeContext";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { StreamingMarkdownProvider } from "../../contexts/StreamingMarkdownContext";
import { buildCorrectionText } from "../../lib/correctionText";
import { UI_KEYS } from "../../lib/storageKeys";
import type { Message } from "../../types";
import { MessageList } from "../MessageList";

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        processingThinkingTranscriptHide:
          "Hide thinking transcript rows (display only; the agent keeps working)",
        processingThinkingTranscriptShowHidden:
          "Show hidden thinking transcript rows",
        processingThinkingTranscriptShowWhenAvailable:
          "Show thinking transcript rows when available",
        sessionQuoteBlock: "Quote this block",
        sessionSteerNow: "Steer now",
        sessionSteerQueuedMessageNow: "Steer queued message now",
        sessionQueuedInlineEditLabel: "Edit queued message text",
        sessionQueuedInlineSave: "Save edit",
        sessionQueuedInlineCancel: "Cancel edit (Esc)",
        userPromptCopyAction: "Copy message text",
        userPromptEditAction: "Edit latest message",
      })[key] ?? key,
  }),
}));

const originalClipboard = navigator.clipboard;

function userMessage(
  uuid: string,
  content: string,
  timestamp?: string,
): Message {
  return {
    type: "user",
    uuid,
    timestamp,
    message: { role: "user", content },
  };
}

function assistantMessage(
  uuid: string,
  content: string,
  timestamp?: string,
): Message {
  return {
    type: "assistant",
    uuid,
    timestamp,
    message: { role: "assistant", content },
  };
}

function assistantToolUseMessage(
  uuid: string,
  content: NonNullable<Message["message"]>["content"],
  timestamp?: string,
): Message {
  return {
    type: "assistant",
    uuid,
    timestamp,
    message: { role: "assistant", content },
  };
}

function codexThinkingMessage(
  uuid: string,
  thinking: string,
  timestamp?: string,
  isStreaming = false,
): Message {
  return {
    type: "assistant",
    uuid,
    timestamp,
    _isStreaming: isStreaming,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
    },
  };
}

function systemMessage(
  uuid: string,
  content: string,
  details?: Array<NonNullable<Message["content"]>>,
): Message {
  return {
    type: "system",
    uuid,
    subtype: "compact_boundary",
    content,
    ...(details ? { details } : {}),
  };
}

function dispatchCopyEvent() {
  const setData = vi.fn();
  const event = new Event("copy", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: { setData },
  });

  document.dispatchEvent(event);
  return { event, setData };
}

function stubClipboardWriteText() {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function SessionTranscriptHarness({ messages }: { messages: Message[] }) {
  return (
    <StreamingMarkdownProvider>
      <RenderModeProvider>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="/repo"
          sessionId="session-1"
        >
          <AgentContentProvider
            agentContent={{}}
            setAgentContent={() => {}}
            toolUseToAgent={new Map()}
            projectId="project-1"
            sessionId="session-1"
          >
            <MessageList
              messages={messages}
              provider="codex"
              markdownAugments={{
                "assistant-1": {
                  html: '<ol><li>First item</li><li>Second item</li></ol><pre class="code-block"><code>const superLongIdentifierName = "value";</code></pre>',
                },
              }}
            />
          </AgentContentProvider>
        </SessionMetadataProvider>
      </RenderModeProvider>
    </StreamingMarkdownProvider>
  );
}

describe("MessageList", () => {
  beforeEach(() => {
    vi.useRealTimers();

    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    document.querySelectorAll(".session-input-inner").forEach((node) => {
      node.remove();
    });
    document.querySelectorAll("textarea").forEach((node) => {
      node.remove();
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("offers correction only for the latest real user message", () => {
    const onCorrect = vi.fn();

    render(
      <MessageList
        messages={[
          userMessage("user-1", "first request"),
          assistantMessage("assistant-1", "response"),
          userMessage("user-2", "second request"),
        ]}
        onCorrectLatestUserMessage={onCorrect}
      />,
    );

    const buttons = screen.getAllByRole("button", {
      name: "Edit latest message",
    });
    expect(buttons).toHaveLength(1);
    expect((buttons[0] as HTMLElement).textContent).toContain("Edit");

    fireEvent.click(buttons[0] as HTMLElement);

    expect(onCorrect).toHaveBeenCalledWith("user-2", "second request");
  });

  it("renders compact summaries as one collapsed compact notification", () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            type: "system",
            uuid: "compact-boundary",
            subtype: "compact_boundary",
            content: "Conversation compacted",
            compactMetadata: { trigger: "manual", preTokens: 123 },
          },
          {
            type: "user",
            uuid: "compact-summary",
            message: {
              role: "user",
              content:
                "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n- hidden detail",
            },
            isCompactSummary: true,
            isVisibleInTranscriptOnly: true,
          },
          {
            type: "user",
            uuid: "compact-stdout",
            message: {
              role: "user",
              content: "<local-command-stdout>Compacted </local-command-stdout>",
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("Conversation compacted")).toBeTruthy();
    expect(screen.queryByText("/compact")).toBeNull();
    expect(screen.queryByText("Compacted")).toBeNull();

    const compactDetails = container.querySelector(
      "details.system-message-compact-boundary",
    ) as HTMLDetailsElement | null;
    expect(compactDetails).toBeTruthy();
    expect(compactDetails?.open).toBe(false);

    const summary = compactDetails?.querySelector("summary");
    expect(summary).toBeTruthy();
    fireEvent.click(summary as HTMLElement);
    expect(compactDetails?.open).toBe(true);
    expect(screen.getByText(/hidden detail/)).toBeTruthy();
    expect(screen.getByText(/compactMetadata/)).toBeTruthy();
  });

  it("passes display text without uploaded-file metadata to correction", () => {
    const onCorrect = vi.fn();

    render(
      <MessageList
        messages={[
          userMessage(
            "user-1",
            "fix typo\n\nUser uploaded files:\n- notes.txt (12 B, text/plain): /uploads/notes.txt",
          ),
        ]}
        onCorrectLatestUserMessage={onCorrect}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit latest message" }),
    );

    expect(onCorrect).toHaveBeenCalledWith("user-1", "fix typo");
  });

  it("renders correction messages with corrected text as the primary content", () => {
    render(
      <MessageList
        messages={[
          userMessage(
            "user-1",
            buildCorrectionText("(testing)", "(test correction)") ?? "",
          ),
        ]}
      />,
    );

    expect(screen.getByText("Correction")).toBeTruthy();
    expect(screen.getByText("(test correction)")).toBeTruthy();
    expect(
      screen.getByText('Change: replace "testing" with "test correction".'),
    ).toBeTruthy();
  });

  it("renders Codex reasoning summaries as collapsed thinking blocks", () => {
    const { container } = render(
      <MessageList
        provider="codex"
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "**Checking instructions**\n\nI need to inspect the repo.",
          ),
        ]}
      />,
    );

    expect(container.querySelector(".thinking-block")).not.toBeNull();
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByLabelText("Expand thinking")).toBeTruthy();
    expect(container.querySelector(".text-block-assistant")).toBeNull();
  });

  it("expands a collapsed thinking block from the timeline hit target", async () => {
    const { container } = render(
      <MessageList
        provider="codex"
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "**Checking instructions**\n\nI need to inspect the repo.",
          ),
        ]}
      />,
    );

    const thinkingBlock = container.querySelector<HTMLDetailsElement>(
      "details.thinking-block",
    );
    const dot = container.querySelector<HTMLElement>(
      ".thinking-block .timeline-dot-btn",
    );
    expect(thinkingBlock?.open).toBe(false);
    expect(dot).toBeTruthy();
    expect(container.querySelector(".thinking-dot-btn")).toBeNull();

    fireEvent.click(dot as HTMLElement);

    await waitFor(() => expect(thinkingBlock?.open).toBe(true));
  });

  it("auto-expands newly observed Codex thinking blocks", () => {
    const { container, rerender } = render(
      <MessageList provider="codex" isProcessing={true} messages={[]} />,
    );

    let thinkingBlocks = container.querySelectorAll<HTMLDetailsElement>(
      "details.thinking-block",
    );
    expect(thinkingBlocks).toHaveLength(0);

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "First active thought",
            "2026-04-25T00:00:00.000Z",
          ),
        ]}
      />,
    );

    thinkingBlocks = container.querySelectorAll<HTMLDetailsElement>(
      "details.thinking-block",
    );
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]?.open).toBe(true);

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "First active thought",
            "2026-04-25T00:00:00.000Z",
          ),
          codexThinkingMessage(
            "thinking-2",
            "Second active thought",
            "2026-04-25T00:00:02.000Z",
          ),
        ]}
      />,
    );

    thinkingBlocks = container.querySelectorAll<HTMLDetailsElement>(
      "details.thinking-block",
    );
    expect(thinkingBlocks).toHaveLength(2);
    expect(thinkingBlocks[0]?.open).toBe(true);
    expect(thinkingBlocks[1]?.open).toBe(true);
  });

  it("does not auto-expand complete Codex thinking blocks on load", () => {
    const { container } = render(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Earlier complete thought",
            "2026-04-25T00:00:00.000Z",
          ),
          codexThinkingMessage(
            "thinking-2",
            "Latest complete thought",
            "2026-04-25T00:00:02.000Z",
          ),
        ]}
      />,
    );

    const thinkingBlocks = container.querySelectorAll<HTMLDetailsElement>(
      "details.thinking-block",
    );
    expect(thinkingBlocks).toHaveLength(2);
    expect(thinkingBlocks[0]?.open).toBe(false);
    expect(thinkingBlocks[1]?.open).toBe(false);
  });

  it("auto-expands historical pi thinking blocks", () => {
    const { container } = render(
      <MessageList
        provider="pi"
        isProcessing={false}
        messages={[
          {
            type: "assistant",
            uuid: "pi-thinking-1",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Historical pi thought" },
                { type: "text", text: "Visible pi answer" },
              ],
            },
          } as Message,
        ]}
      />,
    );

    const thinkingBlock = container.querySelector<HTMLDetailsElement>(
      "details.thinking-block",
    );
    expect(thinkingBlock).not.toBeNull();
    expect(thinkingBlock?.open).toBe(true);
  });

  it("restores hidden historical pi thinking blocks expanded", () => {
    window.localStorage.setItem(UI_KEYS.sessionThinkingVisible, "false");
    const { container } = render(
      <MessageList
        provider="pi"
        messages={[codexThinkingMessage("pi-thinking-1", "Stored pi thought")]}
      />,
    );

    expect(container.querySelectorAll("details.thinking-block")).toHaveLength(
      0,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show hidden thinking transcript rows",
      }),
    );

    const thinkingBlock = container.querySelector<HTMLDetailsElement>(
      "details.thinking-block",
    );
    expect(thinkingBlock).not.toBeNull();
    expect(thinkingBlock?.open).toBe(true);
  });

  it("keeps an auto-expanded thinking block open after completion", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <MessageList provider="codex" isProcessing={true} messages={[]} />,
    );

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Completing thought",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );

    expect(
      container.querySelector<HTMLDetailsElement>("details.thinking-block")
        ?.open,
    ).toBe(true);

    rerender(
      <MessageList
        provider="codex"
        isProcessing={false}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Completing thought",
            "2026-04-25T00:00:00.000Z",
          ),
        ]}
      />,
    );

    expect(
      container.querySelector<HTMLDetailsElement>("details.thinking-block")
        ?.open,
    ).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });

    expect(
      container.querySelector<HTMLDetailsElement>("details.thinking-block")
        ?.open,
    ).toBe(true);
  });

  it("hides and restores thinking transcript rows from the compact toggle", () => {
    const { container } = render(
      <MessageList
        provider="codex"
        messages={[
          codexThinkingMessage("thinking-1", "First stored thought"),
          codexThinkingMessage("thinking-2", "Second stored thought"),
        ]}
      />,
    );

    expect(container.querySelectorAll("details.thinking-block")).toHaveLength(
      2,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide thinking transcript rows (display only; the agent keeps working)",
      }),
    );

    expect(container.querySelectorAll("details.thinking-block")).toHaveLength(
      0,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show hidden thinking transcript rows",
      }),
    );

    expect(container.querySelectorAll("details.thinking-block")).toHaveLength(
      2,
    );
  });

  it("hides and restores thinking transcript rows with Ctrl+O", async () => {
    const { container } = render(
      <MessageList
        provider="codex"
        messages={[
          codexThinkingMessage("thinking-1", "First stored thought"),
          codexThinkingMessage("thinking-2", "Second stored thought"),
        ]}
      />,
    );

    expect(container.querySelectorAll("details.thinking-block")).toHaveLength(
      2,
    );

    fireEvent.keyDown(window, {
      key: "o",
      code: "KeyO",
      ctrlKey: true,
    });

    await waitFor(() =>
      expect(container.querySelectorAll("details.thinking-block")).toHaveLength(
        0,
      ),
    );

    fireEvent.keyDown(window, {
      key: "o",
      code: "KeyO",
      ctrlKey: true,
    });

    await waitFor(() =>
      expect(container.querySelectorAll("details.thinking-block")).toHaveLength(
        2,
      ),
    );
  });

  it("exposes a cancel control for queued messages", () => {
    const onCancelDeferred = vi.fn();

    render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            tempId: "temp-queued",
            content: "queued text",
            timestamp: "2026-04-25T00:00:00.000Z",
          },
        ]}
        onCancelDeferred={onCancelDeferred}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel queued message" }),
    );

    expect(onCancelDeferred).toHaveBeenCalledWith("temp-queued");
  });

  it("copies sent user message text", async () => {
    const writeText = stubClipboardWriteText();

    render(<MessageList messages={[userMessage("user-1", "sent text")]} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy message text" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("sent text"));
  });

  it("copies queued message text", async () => {
    const writeText = stubClipboardWriteText();

    render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            tempId: "temp-queued",
            content: "queued text",
            timestamp: "2026-04-25T00:00:00.000Z",
          },
        ]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Copy queued message" }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("queued text"));
  });

  it("renders pending sends before server-queued deferred messages", () => {
    const { container } = render(
      <MessageList
        messages={[]}
        pendingMessages={[
          {
            tempId: "temp-pending",
            content: "still posting",
            timestamp: "2026-04-25T00:00:00.000Z",
            clientOrder: 2,
          },
        ]}
        deferredMessages={[
          {
            tempId: "temp-queued",
            content: "already queued",
            timestamp: "2026-04-25T00:00:10.000Z",
          },
        ]}
      />,
    );

    const prompts = Array.from(
      container.querySelectorAll(".message-user-prompt"),
    ).map((node) => node.textContent);
    expect(prompts).toEqual(["still posting", "already queued"]);
  });

  it("renders deferred messages in the server's queue order with status-only patient distinction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T00:03:00.000Z"));

    const { container } = render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            tempId: "temp-regular-first",
            content: "regular first",
            timestamp: "2026-04-25T00:00:01.000Z",
          },
          {
            tempId: "temp-patient",
            content: "patient second",
            timestamp: "2026-04-25T00:00:00.000Z",
            metadata: { deliveryIntent: "patient" },
          },
          {
            tempId: "temp-regular-third",
            content: "regular third",
            timestamp: "2026-04-25T00:00:02.000Z",
          },
        ]}
      />,
    );

    const prompts = Array.from(
      container.querySelectorAll(".message-user-prompt"),
    ).map((node) => node.textContent);
    expect(prompts).toEqual([
      "regular first",
      "patient second",
      "regular third",
    ]);
    expect(
      screen
        .getByText("patient second")
        .closest(".deferred-message")
        ?.classList.contains("patient-deferred-message"),
    ).toBe(false);
    expect(screen.getByText("Patient (waiting, 3m ago)")).toBeTruthy();
    expect(screen.getByText("Queued (next regular)")).toBeTruthy();
    expect(screen.getByText("Queued regular (#2)")).toBeTruthy();
  });

  it("keeps the latest stale message age visible in the right rail", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:10:00.000Z"));
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "stale request", "2026-04-26T12:00:00.000Z"),
        ]}
      />,
    );

    const row = container.querySelector('[data-render-id="user-1"]');

    expect(row?.classList.contains("has-message-age")).toBe(true);
    expect(row?.classList.contains("is-message-age-visible")).toBe(true);
    expect(row?.querySelector(".message-age")?.textContent).toBe("10m");
  });

  it("does not refresh historical message ages on idle ticks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:10:00.000Z"));
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "older request", "2026-04-26T12:00:00.000Z"),
          assistantMessage(
            "assistant-1",
            "latest response",
            "2026-04-26T12:04:45.000Z",
          ),
        ]}
      />,
    );

    const olderAge = container.querySelector(
      '[data-render-id="user-1"] .message-age',
    );
    const latestAge = container.querySelector(
      '[data-render-id="assistant-1"] .message-age',
    );

    expect(olderAge?.textContent).toBe("10m");
    expect(latestAge?.textContent).toBe("5m");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(olderAge?.textContent).toBe("10m");
    expect(latestAge?.textContent).toBe("6m");
  });

  it("copies rendered assistant selections as source markdown", () => {
    render(
      <MessageList
        messages={[
          assistantMessage("assistant-1", "1. First item\n1. Second item"),
        ]}
        markdownAugments={{
          "assistant-1": {
            html: "<ol><li>First item</li><li>Second item</li></ol>",
          },
        }}
      />,
    );

    const secondItem = screen.getByText("Second item");
    const textNode = secondItem.firstChild;
    expect(textNode).toBeTruthy();
    const range = document.createRange();
    range.setStart(textNode as Node, 0);
    range.setEnd(textNode as Node, secondItem.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const { event, setData } = dispatchCopyEvent();

    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "1. Second item");
  });

  it("preserves old rendered assistant DOM when later messages append", () => {
    const first = assistantMessage(
      "assistant-1",
      "1. First item\n1. Second item",
      "2026-04-25T00:00:00.000Z",
    );
    const { rerender } = render(
      <SessionTranscriptHarness messages={[first]} />,
    );

    const selectedElement = screen.getByText("Second item");
    const selectedTextNode = selectedElement.firstChild;
    expect(selectedTextNode).toBeTruthy();
    const codeBlock = document.querySelector(
      ".code-block",
    ) as HTMLElement | null;
    expect(codeBlock).toBeTruthy();
    if (codeBlock) {
      codeBlock.scrollLeft = 73;
    }

    const range = document.createRange();
    range.setStart(selectedTextNode as Node, 0);
    range.setEnd(selectedTextNode as Node, "Second item".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    rerender(
      <SessionTranscriptHarness
        messages={[
          first,
          assistantMessage(
            "assistant-2",
            "new complete response",
            "2026-04-25T00:01:00.000Z",
          ),
        ]}
      />,
    );

    const nextSelectedElement = screen.getByText("Second item");
    const nextCodeBlock = document.querySelector(
      ".code-block",
    ) as HTMLElement | null;

    expect(nextSelectedElement).toBe(selectedElement);
    expect(selectedTextNode?.isConnected).toBe(true);
    expect(window.getSelection()?.toString()).toBe("Second item");
    expect(nextCodeBlock).toBe(codeBlock);
    expect(codeBlock?.isConnected).toBe(true);
    expect(nextCodeBlock?.scrollLeft).toBe(73);
  });

  it("does not drop user text from mixed turn selections", () => {
    render(
      <MessageList
        messages={[
          userMessage("user-1", "user selected text"),
          assistantMessage("assistant-1", "assistant selected text"),
        ]}
      />,
    );

    const userText = screen.getByText("user selected text").firstChild;
    const assistantText = screen.getByText(
      "assistant selected text",
    ).firstChild;
    expect(userText).toBeTruthy();
    expect(assistantText).toBeTruthy();

    const range = document.createRange();
    range.setStart(userText as Node, 0);
    range.setEnd(assistantText as Node, "assistant selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const { event, setData } = dispatchCopyEvent();

    expect(event.defaultPrevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });

  it("scrolls to current from a focused composer with Ctrl+End", () => {
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );
    const scrollTo = vi.fn();

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    container.scrollTo = scrollTo as typeof container.scrollTo;

    const editableTarget = document.createElement("textarea");
    document.body.append(editableTarget);
    editableTarget.focus();
    fireEvent.keyDown(editableTarget, {
      key: "End",
      code: "End",
      ctrlKey: true,
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(900);
    editableTarget.remove();
  });

  it("shows a composer follow control when scrolled away from latest", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );
    const scrollTo = vi.fn();

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = scrollTo as typeof container.scrollTo;

    fireEvent.wheel(container, { deltaY: -120 });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Follow latest session output",
      }),
    );

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(500);
    composerTarget.remove();
  });

  it("keeps catching up after Follow while output grows", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    });
    container.scrollTo = scrollTo as typeof container.scrollTo;

    fireEvent.wheel(container, { deltaY: -120 });
    const followButton = await screen.findByRole("button", {
      name: "Follow latest session output",
    });
    vi.useFakeTimers();
    fireEvent.click(followButton);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(500);

    scrollHeight = 1400;
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(900);
    composerTarget.remove();
  });

  it("does not follow visible thinking deltas until Follow is clicked", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    let resizeCallback: ResizeObserverCallback | null = null;
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: CapturingResizeObserver,
    });

    const { container, rerender } = render(
      <MessageList provider="codex" isProcessing={true} messages={[]} />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    }) as typeof container.scrollTo;

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );

    scrollHeight = 1400;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought\nA longer visible thinking delta",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(500);
    const followButton = await screen.findByRole("button", {
      name: "Follow latest session output",
    });

    fireEvent.click(followButton);
    expect(container.scrollTop).toBe(900);

    scrollHeight = 1600;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            [
              "Initial visible thought",
              "A longer visible thinking delta",
              "Another visible thinking delta after Follow",
            ].join("\n"),
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(1100);
    composerTarget.remove();
  });

  it("lets a user wheel away cancel live follow before resize catch-up", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: CapturingResizeObserver,
    });

    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = vi.fn() as typeof container.scrollTo;

    fireEvent.wheel(container, { deltaY: -120 });
    container.scrollTop = 320;
    scrollHeight = 1400;
    expect(resizeCallback).not.toBeNull();
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(320);
  });

  it("opens reverse user-turn search with Ctrl+R and hides nonmatches", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    render(
      <MessageList
        messages={[
          userMessage("user-1", "alpha setup request"),
          assistantMessage("assistant-1", "first response"),
          userMessage(
            "user-2",
            "please inspect the render latency regression in the client",
          ),
          assistantMessage("assistant-2", "second response"),
        ]}
      />,
    );

    const editableTarget = document.createElement("textarea");
    document.body.append(editableTarget);
    editableTarget.focus();
    fireEvent.keyDown(editableTarget, { key: "r", ctrlKey: true });

    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    expect(composerTarget.contains(input)).toBe(true);
    expect(screen.getByText("2+ chars")).toBeTruthy();

    fireEvent.change(input, { target: { value: "latency" } });

    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.queryByText("alpha setup request")).toBeNull();
    expect(screen.getByText(/render latency regression/)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(document.activeElement).toBe(editableTarget);
    });
    editableTarget.remove();
    composerTarget.remove();
  });

  it("opens user-turn search with Ctrl+Alt+R fallback for one turn", async () => {
    render(
      <MessageList
        messages={[userMessage("user-1", "inspect Chrome shortcut handling")]}
      />,
    );

    fireEvent.keyDown(window, {
      key: "R",
      code: "KeyR",
      ctrlKey: true,
      altKey: true,
    });

    expect(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
    ).toBeTruthy();
  });

  it("closes reverse search when focus moves back to the composer", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "first searchable request"),
          userMessage("user-2", "second searchable request"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    const composer = document.createElement("textarea");
    document.body.append(composer);

    fireEvent.blur(input, { relatedTarget: composer });

    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search user turns" }),
      ).toBeNull();
    });
    composer.remove();
  });

  it("opens all-turn reverse search with Ctrl+S", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "look at the first thing"),
          assistantMessage("assistant-1", "the assistant found needle text"),
          systemMessage("system-1", "system compacted needle context"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    const input = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    expect(screen.getByText("All turns")).toBeTruthy();

    fireEvent.change(input, { target: { value: "needle" } });

    expect(await screen.findByText("2/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(await screen.findByText("2/2")).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.queryByText("look at the first thing")).toBeNull();
    expect(screen.getByText("the assistant found needle text")).toBeTruthy();
    expect(screen.getByText("system compacted needle context")).toBeTruthy();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("repeats all-turn search arrow movement at a fast cadence", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "needle in the first request"),
          assistantMessage("assistant-1", "needle in the first answer"),
          systemMessage("system-1", "needle in the compacted context"),
          assistantMessage("assistant-2", "needle in the final answer"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(await screen.findByText("4/4")).toBeTruthy();

    vi.useFakeTimers();

    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(screen.getByText("3/4")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("2/4")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(42);
    });
    expect(screen.getByText("1/4")).toBeTruthy();

    fireEvent.keyUp(window, { key: "ArrowUp" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("1/4")).toBeTruthy();
  });

  it("opens full-session reverse search with Ctrl+Alt+S for tool groups", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "inspect recent changes"),
          assistantToolUseMessage("assistant-tools", [
            {
              type: "tool_use",
              id: "grep-1",
              name: "Grep",
              input: {
                pattern: "SearchNeedle",
                path: "packages/client/src/components/MessageList.tsx",
              },
            },
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: {
                file_path:
                  "packages/client/src/components/UserTurnNavigator.tsx",
              },
            },
          ]),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

    const allInput = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    fireEvent.change(allInput, { target: { value: "Explored" } });

    expect(await screen.findByText("0/0")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search all turns" }),
      ).toBeNull();
    });

    fireEvent.keyDown(window, {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
      altKey: true,
    });

    const fullInput = await screen.findByRole("textbox", {
      name: "Reverse search full session",
    });
    expect(screen.getByText("Full session")).toBeTruthy();
    expect(screen.getByText(/Ctrl\+Alt\+S prev/)).toBeTruthy();
    expect(screen.getByText(/click selects/)).toBeTruthy();
    expect(screen.getByText(/Enter jump\+close/)).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "Explored" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.getByText("Explored")).toBeTruthy();

    fireEvent.change(fullInput, {
      target: { value: "UserTurnNavigator.tsx" },
    });
    expect(await screen.findByText("1/1")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "grep" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.getByText("Grep")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "searchneedle" } });
    expect(await screen.findByText("1/1")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Case-sensitive search" }),
    );
    expect(await screen.findByText("0/0")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "SearchNeedle" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
  });
});
