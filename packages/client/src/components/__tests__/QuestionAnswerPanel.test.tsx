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
});
