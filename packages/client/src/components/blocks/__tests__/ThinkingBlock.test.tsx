import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingBlock } from "../ThinkingBlock";

describe("ThinkingBlock", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows a rounded thinking duration", () => {
    render(
      <ThinkingBlock
        thinking="Working through the plan"
        status="complete"
        isExpanded={false}
        onToggle={vi.fn()}
        durationMs={1345.3298}
      />,
    );

    expect(screen.getByText("for 1.3 sec")).toBeDefined();
  });

  it("toggles from the timeline dot button", () => {
    const onToggle = vi.fn();
    render(
      <ThinkingBlock
        thinking="Working through the plan"
        status="complete"
        isExpanded={false}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand thinking" }));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("keeps the summary toggle visible when collapsed", () => {
    render(
      <ThinkingBlock
        thinking="Working through the plan"
        status="complete"
        isExpanded={false}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("Thinking")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Expand thinking" }),
    ).toBeDefined();
  });
});
