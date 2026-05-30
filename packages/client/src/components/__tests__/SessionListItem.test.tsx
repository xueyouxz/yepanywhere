// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    vi.unstubAllGlobals();
  });

  function renderItem(onNavigate = vi.fn()) {
    render(
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
      </MemoryRouter>,
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
      <MemoryRouter>
        <ul>
          <SessionListItem
            sessionId="aside-1"
            projectId="project-1"
            title="/btw check the side path"
            mode="compact"
          />
        </ul>
      </MemoryRouter>,
    );

    expect(screen.getByText("/btw")).toBeTruthy();
    expect(screen.getByText("check the side path")).toBeTruthy();
  });

  it("opens the parent /btw view when the aside badge is clicked", () => {
    const onNavigate = vi.fn();

    render(
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
      </MemoryRouter>,
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
      </MemoryRouter>,
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
              title="Short title"
              fullTitle="Full initial prompt that should be recoverable"
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
});
