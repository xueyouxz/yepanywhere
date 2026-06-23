// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ForkSummaryIndicator,
  type ForkSummaryJob,
} from "../ForkSummaryIndicator";

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("ForkSummaryIndicator", () => {
  it("shows progress and cancels while generating", () => {
    const onCancel = vi.fn();
    render(
      <ForkSummaryIndicator
        job={{ status: "generating", startedAt: Date.now() }}
        onCancel={onCancel}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("forkSummaryProgress")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "forkSummaryCancelInFlight" }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("links to the forked session (new tab) when the popup was blocked", () => {
    const onDismiss = vi.fn();
    const job: ForkSummaryJob = {
      status: "ready",
      startedAt: Date.now(),
      title: "Resume zh-en eval",
      targetHref: "https://example.test/projects/p/sessions/s2",
      targetUrl: "/projects/p/sessions/s2",
      autoOpened: false,
    };
    render(
      <ForkSummaryIndicator job={job} onCancel={vi.fn()} onDismiss={onDismiss} />,
    );
    expect(screen.getByText("forkSummaryReadyOpen")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Resume zh-en eval/ });
    expect(link.getAttribute("href")).toBe(job.targetHref);
    expect(link.getAttribute("target")).toBe("_blank");
    fireEvent.click(link);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("notes auto-open when the new tab opened", () => {
    render(
      <ForkSummaryIndicator
        job={{
          status: "ready",
          startedAt: Date.now(),
          title: "T",
          targetHref: "https://example.test/x",
          autoOpened: true,
        }}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("forkSummaryOpenedNewTab")).toBeTruthy();
  });

  it("shows the error and dismisses", () => {
    const onDismiss = vi.fn();
    render(
      <ForkSummaryIndicator
        job={{ status: "error", startedAt: Date.now(), error: "boom" }}
        onCancel={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByText(/forkSummaryFailed: boom/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "forkSummaryDismiss" }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
