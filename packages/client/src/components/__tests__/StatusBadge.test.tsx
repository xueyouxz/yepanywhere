import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveCountBadge, SessionStatusBadge } from "../StatusBadge";

describe("SessionStatusBadge", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows Thinking badge when activity is in-turn", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        activity="in-turn"
      />,
    );

    // ThinkingIndicator renders a pill with .thinking-indicator-pill class
    const badge = container.querySelector(".thinking-indicator-pill");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Thinking");
  });

  it("shows nothing when owned but not in-turn", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
      />,
    );

    // No indicator for owned sessions - "Thinking" badge shows when actually in-turn
    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("shows nothing when unowned", () => {
    const { container } = render(
      <SessionStatusBadge status={{ owner: "none" }} />,
    );

    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("prioritizes needs-input over in-turn", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        activity="in-turn"
        pendingInputType="tool-approval"
      />,
    );

    const badge = container.querySelector(
      ".status-badge.notification-needs-input",
    );
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Approval Needed");

    const thinkingBadge = container.querySelector(".thinking-indicator-pill");
    expect(thinkingBadge).toBeNull();
  });

  it("shows Thinking badge even when hasUnread is true", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        activity="in-turn"
        hasUnread={true}
      />,
    );

    // ThinkingIndicator renders a pill with .thinking-indicator-pill class
    const thinkingBadge = container.querySelector(".thinking-indicator-pill");
    expect(thinkingBadge).not.toBeNull();
    expect(thinkingBadge?.textContent).toBe("Thinking");
  });

  it("shows nothing for unowned sessions (unread handled via CSS class)", () => {
    const { container } = render(
      <SessionStatusBadge status={{ owner: "none" }} hasUnread={true} />,
    );

    // No badge - unread is now handled via CSS class on parent element
    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("shows nothing for owned sessions with unread (unread handled via CSS class)", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        hasUnread={true}
      />,
    );

    // No badge or indicator - unread is handled via CSS class on parent
    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("maps self count badges to the existing owned CSS class", () => {
    const { container } = render(<ActiveCountBadge variant="self" count={2} />);

    const badge = container.querySelector(".status-badge");
    expect(badge?.classList.contains("status-owned")).toBe(true);
    expect(badge?.textContent).toBe("2 Active");
  });
});
