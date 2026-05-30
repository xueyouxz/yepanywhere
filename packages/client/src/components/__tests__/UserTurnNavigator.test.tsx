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
import { UserTurnNavigator } from "../UserTurnNavigator";

function rect({
  top,
  height,
  right = 500,
  width = 400,
}: {
  top: number;
  height: number;
  right?: number;
  width?: number;
}): DOMRect {
  return {
    x: right - width,
    y: top,
    top,
    right,
    bottom: top + height,
    left: right - width,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setReadonlyNumber(
  element: HTMLElement,
  key: "clientHeight" | "clientWidth" | "offsetWidth" | "scrollHeight",
  value: number,
) {
  Object.defineProperty(element, key, {
    configurable: true,
    value,
  });
}

function dispatchPointerMove(
  element: HTMLElement,
  clientX: number,
  clientY: number,
) {
  const event = new Event("pointermove", { bubbles: true });
  Object.defineProperty(event, "clientX", { configurable: true, value: clientX });
  Object.defineProperty(event, "clientY", { configurable: true, value: clientY });
  element.dispatchEvent(event);
}

describe("UserTurnNavigator", () => {
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
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows user turn previews and scrolls to the selected turn", async () => {
    let scrollTop = 0;
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const firstRow = document.createElement("div");
    const secondRow = document.createElement("div");
    const scrollTo = vi.fn(
      (optionsOrX?: ScrollToOptions | number, y?: number) => {
        scrollTop =
          typeof optionsOrX === "number"
            ? optionsOrX
            : Number(optionsOrX?.top ?? y ?? 0);
        scrollContainer.dispatchEvent(new Event("scroll"));
      },
    );

    firstRow.dataset.renderId = "user-1";
    secondRow.dataset.renderId = "user-2";
    messageList.append(firstRow, secondRow);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Number(value);
      },
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    firstRow.getBoundingClientRect = () =>
      rect({ top: 100 + 20 - scrollTop, height: 30 });
    secondRow.getBoundingClientRect = () =>
      rect({ top: 100 + 620 - scrollTop, height: 30 });
    scrollContainer.scrollTo = scrollTo as typeof scrollContainer.scrollTo;

    render(
      <UserTurnNavigator
        anchors={[
          { id: "user-1", preview: "First request" },
          { id: "user-2", preview: "Second request with more context" },
        ]}
        messageListRef={{ current: messageList }}
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: "Jump to turn: Second request with more context",
      }),
    ).toBeNull();

    act(() => {
      dispatchPointerMove(scrollContainer, 492, 150);
    });

    const secondMarker = await screen.findByRole("button", {
      name: "Jump to turn: Second request with more context",
    });

    fireEvent.pointerEnter(secondMarker);
    expect(screen.getByText("Second request with more context")).toBeTruthy();

    fireEvent.click(secondMarker);
    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({
        top: 608,
        behavior: "auto",
      });
    });
    expect(
      document.querySelector(".user-turn-nav-motion-cue.is-down"),
    ).toBeTruthy();
  });

  it("does not build normal rail anchors until the scrollbar hotzone is active", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const firstRow = document.createElement("div");
    const secondRow = document.createElement("div");
    const getAnchors = vi.fn(() => [
      { id: "user-1", preview: "First request" },
      { id: "user-2", preview: "Second request" },
    ]);

    firstRow.dataset.renderId = "user-1";
    secondRow.dataset.renderId = "user-2";
    messageList.append(firstRow, secondRow);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    firstRow.getBoundingClientRect = () => rect({ top: 120, height: 30 });
    secondRow.getBoundingClientRect = () => rect({ top: 520, height: 30 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    render(
      <UserTurnNavigator
        getAnchors={getAnchors}
        messageListRef={{ current: messageList }}
      />,
    );

    expect(getAnchors).not.toHaveBeenCalled();

    act(() => {
      dispatchPointerMove(scrollContainer, 492, 150);
    });

    await waitFor(() => {
      expect(getAnchors).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByRole("button", {
        name: "Jump to turn: Second request",
      }),
    ).toBeTruthy();
  });

  it("shows compact previews for every matching search marker when crowded", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = ["user-1", "assistant-1", "system-1"].map((id) => {
      const row = document.createElement("div");
      row.dataset.renderId = id;
      return row;
    });

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 160);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 160 });
    rows[0]!.getBoundingClientRect = () => rect({ top: 120, height: 24 });
    rows[1]!.getBoundingClientRect = () => rect({ top: 180, height: 24 });
    rows[2]!.getBoundingClientRect = () => rect({ top: 240, height: 24 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={[
          { id: "user-1", preview: "User request" },
          { id: "assistant-1", preview: "Assistant response" },
          { id: "system-1", preview: "System note" },
        ]}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "assistant-1",
          matchIds: new Set(["user-1", "assistant-1", "system-1"]),
          preview: "assistant match snippet",
          query: "match",
          previewsById: new Map([
            ["user-1", "user match snippet"],
            ["assistant-1", "assistant match snippet"],
            ["system-1", "system match snippet"],
          ]),
        }}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelectorAll(".user-turn-nav-preview"),
      ).toHaveLength(3);
    });
    const previews = Array.from(
      container.querySelectorAll(".user-turn-nav-preview"),
    );
    expect(previews.map((preview) => preview.textContent)).toEqual([
      "user match snippet",
      "assistant match snippet",
      "system match snippet",
    ]);
    expect(
      container.querySelectorAll(".user-turn-nav-preview-match"),
    ).toHaveLength(3);
    expect(
      previews.every((preview) => preview.classList.contains("is-compact")),
    ).toBe(true);
  });

  it("pulses the preview for one remaining search match", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const row = document.createElement("div");

    row.dataset.renderId = "user-1";
    messageList.append(row);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    row.getBoundingClientRect = () => rect({ top: 180, height: 24 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={[{ id: "user-1", preview: "Only matching request" }]}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "user-1",
          matchIds: new Set(["user-1"]),
          preview: "Only matching request",
          query: "only",
          previewsById: new Map([["user-1", "Only matching request"]]),
        }}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".user-turn-nav-preview")).toBeTruthy();
    });
    const preview = container.querySelector(".user-turn-nav-preview");
    expect(preview?.classList.contains("is-single-search-match")).toBe(true);
    expect(preview?.textContent).toBe("Only matching request");
  });

  it("keeps spaced search previews multi-line when there is room", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = ["user-1", "assistant-1", "system-1"].map((id) => {
      const row = document.createElement("div");
      row.dataset.renderId = id;
      return row;
    });

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 600);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 600 });
    rows[0]!.getBoundingClientRect = () => rect({ top: 120, height: 24 });
    rows[1]!.getBoundingClientRect = () => rect({ top: 600, height: 24 });
    rows[2]!.getBoundingClientRect = () => rect({ top: 1000, height: 24 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={[
          { id: "user-1", preview: "User request" },
          { id: "assistant-1", preview: "Assistant response" },
          { id: "system-1", preview: "System note" },
        ]}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "assistant-1",
          matchIds: new Set(["user-1", "assistant-1", "system-1"]),
          preview: "assistant match snippet with enough surrounding detail",
          query: "match",
          previewsById: new Map([
            ["user-1", "user match snippet with enough surrounding detail"],
            [
              "assistant-1",
              "assistant match snippet with enough surrounding detail",
            ],
            ["system-1", "system match snippet with enough surrounding detail"],
          ]),
        }}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".user-turn-nav-preview")).toHaveLength(
        3,
      );
    });
    const previews = Array.from(
      container.querySelectorAll(".user-turn-nav-preview"),
    );
    expect(
      previews.some((preview) => preview.classList.contains("is-compact")),
    ).toBe(false);
  });

  it("keeps search previews near the active match instead of rendering every match", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = Array.from({ length: 14 }, (_, index) => {
      const row = document.createElement("div");
      row.dataset.renderId = `match-${index + 1}`;
      return row;
    });

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 2000);
    setReadonlyNumber(scrollContainer, "clientHeight", 240);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 240 });
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () =>
        rect({ top: 110 + index * 8, height: 20 });
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={rows.map((row, index) => ({
          id: row.dataset.renderId ?? "",
          preview: `match snippet ${index + 1}`,
        }))}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "match-13",
          matchIds: new Set(
            rows.map((row) => row.dataset.renderId).filter(Boolean) as string[],
          ),
          preview: "active match snippet",
          query: "match",
          previewsById: new Map(
            rows.map((row, index) => [
              row.dataset.renderId ?? "",
              `match snippet ${index + 1}`,
            ]),
          ),
        }}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelectorAll(".user-turn-nav-preview").length,
      ).toBeGreaterThan(1);
    });

    const previewTexts = Array.from(
      container.querySelectorAll(".user-turn-nav-preview"),
      (preview) => preview.textContent,
    );
    expect(previewTexts.length).toBeLessThan(rows.length);
    expect(previewTexts).not.toContain("match snippet 1");
    expect(previewTexts).toContain("match snippet 13");
  });
});
