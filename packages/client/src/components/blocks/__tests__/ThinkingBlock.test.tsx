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
    const { container } = render(
      <ThinkingBlock
        thinking="Working through the plan"
        status="complete"
        isExpanded={false}
        onToggle={onToggle}
      />,
    );

    const dot = container.querySelector(".thinking-dot-btn");
    if (!dot) {
      throw new Error("Missing thinking timeline dot");
    }
    fireEvent.click(dot);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeline dot inside the collapsed summary", () => {
    render(
      <ThinkingBlock
        thinking="Working through the plan"
        status="complete"
        isExpanded={false}
        onToggle={vi.fn()}
      />,
    );

    const dot = document.querySelector(".thinking-dot-btn");
    if (!dot) {
      throw new Error("Missing thinking timeline dot");
    }
    expect(dot.closest("summary")).not.toBeNull();
  });
});
