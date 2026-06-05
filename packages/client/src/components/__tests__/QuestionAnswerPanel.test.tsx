// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputRequest, UserQuestionAnswers } from "../../types";
import { QuestionAnswerPanel } from "../QuestionAnswerPanel";

const translations: Record<string, string> = {
  questionPanelCancel: "Cancel",
  questionPanelCollapse: "Collapse question panel",
  questionPanelExpand: "Expand question panel",
  questionPanelNext: "Next",
  questionPanelNoQuestions: "No questions to answer",
  questionPanelOther: "Other",
  questionPanelSubmit: "Submit",
  questionPanelTypeAnswer: "Type your answer...",
};

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

describe("QuestionAnswerPanel", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("submits multi-select answers and highlights selected options", async () => {
    const request: InputRequest = {
      id: "req-1",
      sessionId: "sess-1",
      type: "question",
      prompt: "Which checks?",
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [
          {
            question: "Which checks?",
            header: "Checks",
            options: [
              { label: "Unit", description: "Run unit tests" },
              { label: "Types", description: "Run typecheck" },
            ],
            multiSelect: true,
          },
        ],
      },
      timestamp: "2026-06-05T00:00:00.000Z",
    };
    const onSubmit = vi.fn<(_: UserQuestionAnswers) => Promise<void>>(
      async () => {},
    );

    render(
      <QuestionAnswerPanel
        request={request}
        sessionId="sess-1"
        onSubmit={onSubmit}
        onDeny={vi.fn()}
      />,
    );

    const unit = screen.getByRole("button", { name: /Unit/ });
    fireEvent.click(unit);
    expect(unit.classList.contains("selected")).toBe(true);

    const other = screen.getByRole("button", { name: /Other/ });
    fireEvent.click(other);
    expect(other.classList.contains("selected")).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Type your answer..."), {
      target: { value: "Manual smoke" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        "Which checks?": ["Unit", "Manual smoke"],
      });
    });
  });

  it("hides the tab bar for a single question and reveals an option preview on select", () => {
    const request: InputRequest = {
      id: "req-2",
      sessionId: "sess-2",
      type: "question",
      prompt: "Pick one",
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [
          {
            question: "Pick one",
            header: "OnlyTab",
            options: [
              { label: "Alpha", description: "first", preview: "PREVIEW-ALPHA" },
              { label: "Beta", description: "second" },
            ],
            multiSelect: false,
          },
        ],
      },
      timestamp: "2026-06-05T00:00:00.000Z",
    };

    render(
      <QuestionAnswerPanel
        request={request}
        sessionId="sess-2"
        onSubmit={vi.fn()}
        onDeny={vi.fn()}
      />,
    );

    // A lone question renders no tab bar (the header is not shown as a tab).
    expect(screen.queryByRole("button", { name: /OnlyTab/ })).toBeNull();

    // Preview stays hidden until its option is selected (focused).
    expect(screen.queryByText("PREVIEW-ALPHA")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(screen.getByText("PREVIEW-ALPHA")).toBeTruthy();

    // Switching to an option without a preview hides the previous one.
    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
    expect(screen.queryByText("PREVIEW-ALPHA")).toBeNull();
  });
});
