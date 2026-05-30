// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModeSelector } from "../ModeSelector";

const translations: Record<string, string> = {
  modeAcceptEditsLabel: "Edit",
  modeBypassPermissionsLabel: "Bypass",
  modeClickToSelect: "Click to select mode",
  modeDefaultLabel: "Ask",
  modeHold: "Hold",
  modeNextTurnBadge: "Next turn",
  modeNextTurnHint: "Applies to the next user turn",
  modePlanLabel: "Plan",
  modeSelectLabel: "Select mode",
};

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

describe("ModeSelector", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("labels busy mode changes as next-turn changes", () => {
    render(
      <ModeSelector
        mode="plan"
        onModeChange={vi.fn()}
        changesApplyNextTurn
      />,
    );

    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("Next turn")).toBeTruthy();
    expect(
      screen.getByTitle(
        "Click to select mode - Applies to the next user turn",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Plan/ }));

    expect(screen.getByText("Applies to the next user turn")).toBeTruthy();
  });

  it("keeps the normal compact selector when changes are immediate", () => {
    render(<ModeSelector mode="default" onModeChange={vi.fn()} />);

    expect(screen.getByText("Ask")).toBeTruthy();
    expect(screen.queryByText("Next turn")).toBeNull();
    expect(screen.getByTitle("Click to select mode")).toBeTruthy();
  });
});
