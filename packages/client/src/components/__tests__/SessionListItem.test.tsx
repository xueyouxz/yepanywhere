// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { DEFAULT_HOVERCARD_SHOW_DELAY_MS } from "../../hooks/useHoverCardAppearance";
import { I18nProvider } from "../../i18n";
import { SessionListItem } from "../SessionListItem";

const mockWindowOpen = vi.fn();
const originalClipboard = navigator.clipboard;

function LocationProbe() {
  const location = useLocation();
  return (
    <output aria-label="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

describe("SessionListItem links", () => {
  beforeEach(() => {
    mockWindowOpen.mockReset();
    vi.stubGlobal("open", mockWindowOpen);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    vi.unstubAllGlobals();
  });

  function renderItem(onNavigate = vi.fn()) {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Build logs"
              mode="compact"
              onNavigate={onNavigate}
              basePath="/remote/test"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );
    return {
      link: screen.getByRole("link", { name: /Build logs/ }),
      onNavigate,
    };
  }

  it("opens the session in a new window on middle click", () => {
    const { link, onNavigate } = renderItem();

    fireEvent.mouseDown(link, { button: 1 });
    link.dispatchEvent(
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );

    expect(onNavigate).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/projects/project-1/sessions/session-1",
      "_blank",
      "noopener",
    );
  });

  it("opens a new window on modified clicks without closing the current view", () => {
    const { link, onNavigate } = renderItem();

    fireEvent.click(link, { ctrlKey: true });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/projects/project-1/sessions/session-1",
      "_blank",
      "noopener",
    );
  });

  it("labels /btw aside sessions separately from their truncated title text", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="aside-1"
              projectId="project-1"
              title="/btw check the side path"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByText("/btw")).toBeTruthy();
    expect(screen.getByText("check the side path")).toBeTruthy();
  });

  it("opens the parent /btw view when the aside badge is clicked", () => {
    const onNavigate = vi.fn();

    render(
      <I18nProvider>
        <MemoryRouter
          initialEntries={["/remote/test/projects/project-1/sessions/aside-1"]}
        >
          <ul>
            <SessionListItem
              sessionId="aside-1"
              projectId="project-1"
              title="/btw check the side path"
              parentSessionId="parent-1"
              mode="compact"
              onNavigate={onNavigate}
              basePath="/remote/test"
            />
          </ul>
          <LocationProbe />
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("/btw"));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("location").textContent).toBe(
      "/remote/test/projects/project-1/sessions/parent-1?btw=aside-1",
    );
  });

  it("opens the parent /btw view in a new window on modified badge clicks", () => {
    const onNavigate = vi.fn();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="aside-1"
              projectId="project-1"
              title="/btw check the side path"
              parentSessionId="parent-1"
              mode="compact"
              onNavigate={onNavigate}
              basePath="/remote/test"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("/btw"), { ctrlKey: true });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/projects/project-1/sessions/parent-1?btw=aside-1",
      "_blank",
      "noopener",
    );
  });

  it("copies the initial prompt from the session menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="failed-1"
              projectId="project-1"
              title="Custom title"
              fullTitle="Full initial prompt that should be recoverable"
              hasCustomTitle
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Session options"));
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "Full initial prompt that should be recoverable",
      );
    });
  });

  it("uses custom titles for native row tooltips", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Custom title"
              fullTitle="Original first turn"
              hasCustomTitle
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(
      screen.getByRole("link", { name: /Custom title/ }).getAttribute("title"),
    ).toBe("Custom title");
  });

  it("uses custom titles for session hover previews", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Custom title"
              fullTitle="Original first turn"
              initialPrompt="Original first turn"
              hasCustomTitle
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Custom title/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.mouseEnter(item!, { clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS);
    });

    const hoverTurn = document.querySelector(".session-hovercard__turn");
    expect(hoverTurn?.textContent).toBe("Custom title");
  });

  it("delays session hover previews", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Delayed hover"
              initialPrompt="Delayed hover prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Delayed hover/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.mouseEnter(item!, { clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS - 1);
    });
    expect(screen.queryByText("Delayed hover prompt")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Delayed hover prompt")).toBeTruthy();
  });

  it("keeps a session hover preview open while the pointer is over the card", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Selectable hover"
              initialPrompt="Selectable hover prompt"
              lastAgentText="Selectable recap text"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Selectable hover/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.mouseEnter(item!, { clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS);
    });

    const hoverCard = document.querySelector(".session-hovercard");
    expect(hoverCard).toBeTruthy();
    expect(screen.getByText("Selectable recap text")).toBeTruthy();

    fireEvent.mouseLeave(item!, { relatedTarget: hoverCard });
    expect(screen.getByText("Selectable recap text")).toBeTruthy();

    fireEvent.mouseLeave(hoverCard!);
    expect(screen.queryByText("Selectable recap text")).toBeNull();
  });

  it("keeps only one session hover preview visible", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="First session"
              initialPrompt="First session prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
            <SessionListItem
              sessionId="session-2"
              projectId="project-1"
              title="Second session"
              initialPrompt="Second session prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-2" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const firstItem = screen
      .getByRole("link", { name: /First session/ })
      .closest("li");
    const secondItem = screen
      .getByRole("link", { name: /Second session/ })
      .closest("li");
    expect(firstItem).toBeTruthy();
    expect(secondItem).toBeTruthy();

    fireEvent.mouseEnter(firstItem!, { clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("First session prompt")).toBeTruthy();

    fireEvent.mouseEnter(secondItem!, { clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("First session prompt")).toBeNull();
    expect(screen.getByText("Second session prompt")).toBeTruthy();
  });

  it("keeps session hover previews open during unrelated scrolls", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <div data-testid="transcript-scroll" />
          <div data-testid="sidebar-scroll">
            <ul>
              <SessionListItem
                sessionId="session-1"
                projectId="project-1"
                title="Scoped scroll"
                initialPrompt="Scoped scroll prompt"
                provider="claude"
                status={{ owner: "self", processId: "pid-1" }}
                mode="compact"
              />
            </ul>
          </div>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Scoped scroll/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.mouseEnter(item!, { clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("Scoped scroll prompt")).toBeTruthy();

    fireEvent.scroll(screen.getByTestId("transcript-scroll"));
    expect(screen.getByText("Scoped scroll prompt")).toBeTruthy();

    fireEvent.scroll(screen.getByTestId("sidebar-scroll"));
    expect(screen.queryByText("Scoped scroll prompt")).toBeNull();
  });

  it("does not use a native title tooltip for session menu options", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Menu title"
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByLabelText("Session options").getAttribute("title")).toBe(
      null,
    );
  });

  it("does not show a hover card while the session menu is open", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Menu open"
              initialPrompt="Menu open prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen.getByRole("link", { name: /Menu open/ }).closest("li");
    expect(item).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByLabelText("Session options"));
    });
    fireEvent.mouseEnter(item!, { clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS + 50);
    });

    expect(screen.queryByText("Menu open prompt")).toBeNull();
  });

  it("refreshes the preview on hover, before the show delay elapses", () => {
    vi.useFakeTimers();
    const refreshSpy = vi
      .spyOn(api, "refreshSessionPreview")
      .mockResolvedValue(undefined as never);

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Idle row"
              initialPrompt="Idle row prompt"
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen.getByRole("link", { name: /Idle row/ }).closest("li");
    fireEvent.mouseEnter(item!, { clientX: 20 });

    // Fires immediately on hover, not gated behind the show delay.
    expect(refreshSpy).toHaveBeenCalledWith("project-1", "session-1");

    refreshSpy.mockRestore();
  });
});
