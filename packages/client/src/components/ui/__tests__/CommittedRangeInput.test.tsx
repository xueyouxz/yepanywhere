// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommittedRangeInput } from "../CommittedRangeInput";

afterEach(() => {
  cleanup();
});

function RangeHarness({ onCommit }: { onCommit: (value: number) => void }) {
  const [value, setValue] = useState(10);
  const [draft, setDraft] = useState(10);

  return (
    <>
      <CommittedRangeInput
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label="Width"
        onDraftChange={setDraft}
        onCommit={(next) => {
          onCommit(next);
          setValue(next);
        }}
      />
      <output data-testid="committed">{value}</output>
      <output data-testid="draft">{draft}</output>
    </>
  );
}

describe("CommittedRangeInput", () => {
  it("updates the local draft during drag but commits on release", () => {
    const onCommit = vi.fn();
    render(<RangeHarness onCommit={onCommit} />);

    const slider = screen.getByLabelText<HTMLInputElement>("Width");
    fireEvent.change(slider, { target: { value: "42" } });

    expect(slider.value).toBe("42");
    expect(screen.getByTestId("draft").textContent).toBe("42");
    expect(screen.getByTestId("committed").textContent).toBe("10");
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider);

    expect(onCommit).toHaveBeenCalledWith(42);
    expect(screen.getByTestId("committed").textContent).toBe("42");
  });

  it("commits keyboard changes on key release", () => {
    const onCommit = vi.fn();
    render(<RangeHarness onCommit={onCommit} />);

    const slider = screen.getByLabelText<HTMLInputElement>("Width");
    fireEvent.change(slider, { target: { value: "25" } });
    fireEvent.keyUp(slider, { key: "ArrowRight" });

    expect(onCommit).toHaveBeenCalledWith(25);
    expect(screen.getByTestId("committed").textContent).toBe("25");
  });
});
