import { useCallback, useEffect, useRef, useState } from "react";
import { useQuestionOtherDrafts } from "../hooks/useDrafts";
import { useI18n } from "../i18n";
import type { InputRequest, UserQuestionAnswers } from "../types";
import type { AskUserQuestionInput } from "./renderers/tools/types";

const OTHER_ANSWER = "__other__";
type SelectedAnswers = Record<string, string[]>;

function getSelections(
  answers: SelectedAnswers,
  question: string | undefined,
): string[] {
  return question ? (answers[question] ?? []) : [];
}

function isQuestionAnswered(
  question: string,
  selected: string[],
  otherTexts: Record<string, string>,
): boolean {
  if (selected.length === 0) return false;
  const hasOther = selected.includes(OTHER_ANSWER);
  const hasRegularAnswer = selected.some((answer) => answer !== OTHER_ANSWER);
  if (hasOther && !(otherTexts[question] || "").trim()) {
    return false;
  }
  return hasRegularAnswer || hasOther;
}

interface Props {
  request: InputRequest;
  sessionId: string;
  onSubmit: (answers: UserQuestionAnswers) => Promise<void>;
  onDeny: () => Promise<void>;
}

/**
 * Panel for answering AskUserQuestion tool calls.
 * Shows one question at a time with tabs to navigate between them.
 */
export function QuestionAnswerPanel({
  request,
  sessionId,
  onSubmit,
  onDeny,
}: Props) {
  const { t } = useI18n();
  const input = request.toolInput as AskUserQuestionInput;
  const questions = input?.questions || [];

  const [currentTab, setCurrentTab] = useState(0);
  const [answers, setAnswers] = useState<SelectedAnswers>({});
  // Persist "Other" text inputs to localStorage keyed by sessionId
  const [otherTexts, setOtherText, clearOtherTexts] =
    useQuestionOtherDrafts(sessionId);
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const otherInputRef = useRef<HTMLInputElement>(null);

  const currentQuestion = questions[currentTab];
  const isLastQuestion = currentTab === questions.length - 1;
  const currentSelections = getSelections(answers, currentQuestion?.question);
  const isOtherSelected = currentSelections.includes(OTHER_ANSWER);
  const currentQuestionAnswered = currentQuestion
    ? isQuestionAnswered(
        currentQuestion.question,
        currentSelections,
        otherTexts,
      )
    : false;

  // Check if all questions are answered
  const allAnswered = questions.every((q) => {
    return isQuestionAnswered(
      q.question,
      getSelections(answers, q.question),
      otherTexts,
    );
  });

  // Focus the "other" input when it's selected and scroll it into view
  useEffect(() => {
    if (isOtherSelected && otherInputRef.current) {
      otherInputRef.current.focus();
      // Scroll input into view after a short delay to allow keyboard to open
      setTimeout(() => {
        otherInputRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 100);
    }
  }, [isOtherSelected]);

  const handleSelectOption = useCallback(
    (optionLabel: string) => {
      if (!currentQuestion) return;
      setAnswers((prev) => ({
        ...prev,
        [currentQuestion.question]: currentQuestion.multiSelect
          ? getSelections(prev, currentQuestion.question).includes(optionLabel)
            ? getSelections(prev, currentQuestion.question).filter(
                (answer) => answer !== optionLabel,
              )
            : [...getSelections(prev, currentQuestion.question), optionLabel]
          : [optionLabel],
      }));
    },
    [currentQuestion],
  );

  const handleOtherTextChange = useCallback(
    (text: string) => {
      if (!currentQuestion) return;
      setOtherText(currentQuestion.question, text);
    },
    [currentQuestion, setOtherText],
  );

  const advanceToNext = useCallback(() => {
    if (!isLastQuestion) {
      setCurrentTab((prev) => prev + 1);
    }
  }, [isLastQuestion]);

  const handleSubmit = useCallback(async () => {
    if (!allAnswered || submitting) return;

    const finalAnswers: UserQuestionAnswers = {};
    for (const q of questions) {
      const selectedValues = getSelections(answers, q.question).flatMap(
        (answer) => {
          if (answer === OTHER_ANSWER) {
            const otherAnswer = (otherTexts[q.question] || "").trim();
            return otherAnswer ? [otherAnswer] : [];
          }
          return [answer];
        },
      );
      if (selectedValues.length > 0) {
        finalAnswers[q.question] = q.multiSelect
          ? selectedValues
          : (selectedValues[0] ?? "");
      }
    }

    setSubmitting(true);
    try {
      await onSubmit(finalAnswers);
      // Clear "Other" drafts from localStorage on successful submit
      clearOtherTexts();
    } finally {
      setSubmitting(false);
    }
  }, [
    allAnswered,
    submitting,
    questions,
    answers,
    otherTexts,
    onSubmit,
    clearOtherTexts,
  ]);

  const handleDeny = useCallback(async () => {
    setSubmitting(true);
    try {
      await onDeny();
    } finally {
      setSubmitting(false);
    }
  }, [onDeny]);

  // Keyboard handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (submitting) return;

      // Escape to deny
      if (e.key === "Escape") {
        e.preventDefault();
        handleDeny();
        return;
      }

      // Enter behavior depends on context
      if (e.key === "Enter" && !e.shiftKey) {
        // If "other" is selected and has text, or a regular option is selected
        if (currentQuestionAnswered) {
          e.preventDefault();
          if (isLastQuestion && allAnswered) {
            handleSubmit();
          } else {
            advanceToNext();
          }
        }
      }

      // Tab/Shift+Tab to navigate between question tabs (when not in input)
      if (e.key === "Tab" && !isOtherSelected) {
        e.preventDefault();
        if (e.shiftKey) {
          setCurrentTab((prev) => Math.max(0, prev - 1));
        } else {
          setCurrentTab((prev) => Math.min(questions.length - 1, prev + 1));
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    submitting,
    currentQuestionAnswered,
    currentQuestion,
    isLastQuestion,
    allAnswered,
    isOtherSelected,
    questions.length,
    handleDeny,
    handleSubmit,
    advanceToNext,
  ]);

  if (!questions.length) {
    return (
      <div className="question-panel-wrapper">
        <div className="question-panel">
          <div className="question-panel-empty">
            {t("questionPanelNoQuestions")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="question-panel-wrapper">
      {/* Floating toggle button */}
      <button
        type="button"
        className="question-panel-toggle"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={
          collapsed ? t("questionPanelExpand") : t("questionPanelCollapse")
        }
        aria-expanded={!collapsed}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={collapsed ? "chevron-up" : "chevron-down"}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {!collapsed && (
        <div className="question-panel">
          {/* Tab bar — only meaningful with more than one question; a lone
              tab is just noise (and an awkward "active" pill), so hide it. */}
          {questions.length > 1 && (
            <div className="question-tabs">
              {questions.map((q, idx) => {
                const isActive = idx === currentTab;
                const isAnswered = isQuestionAnswered(
                  q.question,
                  getSelections(answers, q.question),
                  otherTexts,
                );
                return (
                  <button
                    key={q.question}
                    type="button"
                    className={`question-tab ${isActive ? "active" : ""} ${isAnswered ? "answered" : ""}`}
                    onClick={() => setCurrentTab(idx)}
                  >
                    {isAnswered && (
                      <span className="question-tab-check">✓</span>
                    )}
                    {q.header}
                  </button>
                );
              })}
            </div>
          )}

          {/* Current question */}
          {currentQuestion && (
            <div className="question-content">
              <div className="question-text">{currentQuestion.question}</div>

              <div className="question-options-list">
                {currentQuestion.options.map((option) => {
                  const isSelected = currentSelections.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`question-option-btn ${isSelected ? "selected" : ""} ${
                        isSelected && option.preview ? "has-preview" : ""
                      }`}
                      aria-pressed={isSelected}
                      onClick={() => handleSelectOption(option.label)}
                    >
                      <span className="question-option-radio">
                        {currentQuestion.multiSelect
                          ? isSelected
                            ? "☑"
                            : "☐"
                          : isSelected
                            ? "●"
                            : "○"}
                      </span>
                      <div className="question-option-text">
                        <span className="question-option-label">
                          {option.label}
                        </span>
                        {option.description && (
                          <span className="question-option-desc">
                            {option.description}
                          </span>
                        )}
                      </div>
                      {/* Preview is revealed for the focused (selected) option.
                          stopPropagation lets the user select/copy its text
                          without toggling the option off. */}
                      {isSelected && option.preview && (
                        <div
                          className="question-option-preview"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {option.preview}
                        </div>
                      )}
                    </button>
                  );
                })}

                {/* Other option */}
                <button
                  type="button"
                  className={`question-option-btn other ${isOtherSelected ? "selected" : ""}`}
                  aria-pressed={isOtherSelected}
                  onClick={() => handleSelectOption(OTHER_ANSWER)}
                >
                  <span className="question-option-radio">
                    {currentQuestion.multiSelect
                      ? isOtherSelected
                        ? "☑"
                        : "☐"
                      : isOtherSelected
                        ? "●"
                        : "○"}
                  </span>
                  <div className="question-option-text">
                    <span className="question-option-label">
                      {t("questionPanelOther")}
                    </span>
                  </div>
                </button>

                {/* Other text input */}
                {isOtherSelected && (
                  <div className="question-other-input">
                    <input
                      ref={otherInputRef}
                      type="text"
                      placeholder={t("questionPanelTypeAnswer")}
                      value={otherTexts[currentQuestion.question] || ""}
                      onChange={(e) => handleOtherTextChange(e.target.value)}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="question-actions">
            <button
              type="button"
              className="question-btn deny"
              onClick={handleDeny}
              disabled={submitting}
            >
              {t("questionPanelCancel")}
              <kbd>esc</kbd>
            </button>

            {isLastQuestion ? (
              <button
                type="button"
                className="question-btn submit"
                onClick={handleSubmit}
                disabled={!allAnswered || submitting}
              >
                {t("questionPanelSubmit")}
                <kbd>↵</kbd>
              </button>
            ) : (
              <button
                type="button"
                className="question-btn next"
                onClick={advanceToNext}
                disabled={!currentQuestionAnswered || submitting}
              >
                {t("questionPanelNext")}
                <kbd>↵</kbd>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
