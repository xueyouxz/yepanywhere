import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusIndicator } from "../StatusIndicator";

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe("StatusIndicator", () => {
  afterEach(() => {
    cleanup();
  });

  it("maps self-owned status to the existing owned CSS class", () => {
    const { container } = render(
      <StatusIndicator
        status={{ owner: "self", processId: "process-1" }}
        connected={false}
        processState="in-turn"
      />,
    );

    const dot = container.querySelector(".status-dot");
    expect(dot?.classList.contains("status-owned")).toBe(true);
    expect(dot?.classList.contains("process-running")).toBe(true);
    expect(dot?.classList.contains("disconnected")).toBe(true);
  });

  it("keeps waiting-input styling for owned sessions", () => {
    const { container } = render(
      <StatusIndicator
        status={{ owner: "self", processId: "process-1" }}
        connected={true}
        processState="waiting-input"
      />,
    );

    const dot = container.querySelector(".status-dot");
    expect(dot?.classList.contains("status-owned")).toBe(true);
    expect(dot?.classList.contains("process-waiting-input")).toBe(true);
  });

  it("maps external ownership to the external CSS class", () => {
    const { container } = render(
      <StatusIndicator status={{ owner: "external" }} connected={true} />,
    );

    expect(
      container.querySelector(".status-dot")?.classList.contains(
        "status-external",
      ),
    ).toBe(true);
  });
});
