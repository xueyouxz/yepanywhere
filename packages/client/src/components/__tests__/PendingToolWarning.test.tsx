// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { PendingToolWarning } from "../PendingToolWarning";

afterEach(cleanup);

function renderBanner(props: {
  toolName?: string;
  toolInput?: unknown;
  pendingSinceMs?: number | null;
  onDismiss?: () => void;
}) {
  return render(
    <I18nProvider>
      <PendingToolWarning
        toolName={props.toolName ?? "Bash"}
        toolInput={props.toolInput ?? { command: "npm test" }}
        pendingSinceMs={props.pendingSinceMs ?? Date.now() - 5000}
        onDismiss={props.onDismiss ?? (() => {})}
      />
    </I18nProvider>,
  );
}

describe("PendingToolWarning", () => {
  it("names the unfinished tool in the waiting copy when recent", () => {
    renderBanner({ toolName: "Edit", pendingSinceMs: Date.now() - 5000 });
    expect(
      screen.getByText(/Unfinished Edit call in this session/),
    ).toBeTruthy();
  });

  it("switches to the discard-risk copy once the call is stale", () => {
    renderBanner({ pendingSinceMs: Date.now() - 20 * 60 * 1000 });
    expect(
      screen.getByText(/Unfinished Bash call, possibly abandoned/),
    ).toBeTruthy();
  });

  it("calls onDismiss when the close button is clicked", () => {
    const onDismiss = vi.fn();
    renderBanner({ onDismiss });
    fireEvent.click(screen.getByRole("button", { name: /Dismiss warning/ }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("opens the risk explanation modal from the elapsed-time affordance", () => {
    renderBanner({});
    // The modal title only renders inside the Modal, not the always-present
    // hover tooltip, so it is an unambiguous signal the modal opened.
    expect(screen.queryByText(/Why check the other process/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Last activity/ }));
    expect(screen.getByText(/Why check the other process/)).toBeTruthy();
  });
});
