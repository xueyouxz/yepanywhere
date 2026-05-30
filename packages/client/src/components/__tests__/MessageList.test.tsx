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
import { buildCorrectionText } from "../../lib/correctionText";
import type { Message } from "../../types";
import { MessageList } from "../MessageList";

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

function systemMessage(uuid: string, content: string): Message {
  return {
    type: "system",
    uuid,
    subtype: "compact_boundary",
    content,
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

describe("MessageList", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });
  });

  afterEach(() => {
    document
      .querySelectorAll(".session-input-inner")
      .forEach((node) => node.remove());
    document.querySelectorAll("textarea").forEach((node) => node.remove());
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

  it("marks queued messages that are blocked behind an edit", () => {
    render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            tempId: "temp-3",
            content: "third",
            timestamp: "2026-04-25T00:00:00.000Z",
            blockedByEdit: true,
          },
        ]}
      />,
    );

    expect(screen.getByText("Queued (after edit)")).toBeTruthy();
  });

  it("marks queued messages as verifying when provider reconciliation is pending", () => {
    render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            tempId: "temp-verifying",
            content: "verifying text",
            timestamp: "2026-04-25T00:00:00.000Z",
            deliveryState: "verifying",
          },
        ]}
      />,
    );

    expect(screen.getByText("Queued (verifying)")).toBeTruthy();
  });

  it("exposes explicit edit and cancel controls for queued messages", () => {
    const onEditDeferred = vi.fn();
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
        onEditDeferred={onEditDeferred}
        onCancelDeferred={onCancelDeferred}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel queued message" }),
    );

    expect(onEditDeferred).toHaveBeenCalledWith("temp-queued");
    expect(onCancelDeferred).toHaveBeenCalledWith("temp-queued");
  });

  it("copies sent user message text", async () => {
    const writeText = stubClipboardWriteText();

    render(<MessageList messages={[userMessage("user-1", "sent text")]} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Copy message text" }),
    );

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

  it("keeps selected queued text from activating edit", () => {
    const onEditDeferred = vi.fn();
    const { container } = render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            tempId: "temp-queued",
            content: "select me",
            timestamp: "2026-04-25T00:00:00.000Z",
          },
        ]}
        onEditDeferred={onEditDeferred}
      />,
    );

    const queuedBubble = container.querySelector(".deferred-message-edit");
    expect(queuedBubble).toBeTruthy();
    const textNode = queuedBubble?.firstChild;
    expect(textNode).toBeTruthy();
    const range = document.createRange();
    range.setStart(textNode as Node, 0);
    range.setEnd(textNode as Node, "select".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.click(queuedBubble as HTMLElement);

    expect(onEditDeferred).not.toHaveBeenCalled();
    selection?.removeAllRanges();

    fireEvent.click(queuedBubble as HTMLElement);
    expect(onEditDeferred).toHaveBeenCalledWith("temp-queued");
  });

  it("renders pending and queued composer-tail items by submit order", () => {
    const { container } = render(
      <MessageList
        messages={[]}
        pendingMessages={[
          {
            tempId: "temp-pending",
            content: "second still posting",
            timestamp: "2026-04-25T00:00:00.000Z",
            clientOrder: 2,
          },
        ]}
        deferredMessages={[
          {
            tempId: "temp-queued",
            content: "first already queued",
            timestamp: "2026-04-25T00:00:10.000Z",
            clientOrder: 1,
          },
        ]}
      />,
    );

    const prompts = Array.from(
      container.querySelectorAll(".message-user-prompt"),
    ).map((node) => node.textContent);
    expect(prompts).toEqual(["first already queued", "second still posting"]);
  });

  it("keeps the latest stale message age visible in the right rail", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:10:00.000Z"));
    const { container } = render(
      <MessageList
        messages={[
          userMessage(
            "user-1",
            "stale request",
            "2026-04-26T12:00:00.000Z",
          ),
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
          userMessage(
            "user-1",
            "older request",
            "2026-04-26T12:00:00.000Z",
          ),
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

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    fireEvent.scroll(container);

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

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    fireEvent.scroll(container);
    const followButton = await screen.findByRole("button", {
      name: "Follow latest session output",
    });
    vi.useFakeTimers();
    fireEvent.click(
      followButton,
    );
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
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.queryByText("look at the first thing")).toBeNull();
    expect(screen.getByText("the assistant found needle text")).toBeTruthy();
    expect(screen.getByText("system compacted needle context")).toBeTruthy();

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
