// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  captureTextareaAppendSelection,
  restoreTextareaAppendSelection,
  restoreTextareaInsertionSelection,
  restoreTextareaReplacementSelection,
} from "../textareaSelection";

function makeTextarea(value: string): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  document.body.append(textarea);
  textarea.focus();
  return textarea;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("textarea append selection", () => {
  it("preserves a mid-draft cursor when text is appended", () => {
    const textarea = makeTextarea("alpha beta");
    textarea.setSelectionRange(3, 3);
    textarea.scrollTop = 7;

    const selection = captureTextareaAppendSelection(textarea, textarea.value);
    textarea.value = "alpha beta gamma";
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    restoreTextareaAppendSelection(textarea, selection, textarea.value);

    expect(textarea.selectionStart).toBe(3);
    expect(textarea.selectionEnd).toBe(3);
    expect(textarea.scrollTop).toBe(7);
  });

  it("moves an old-end cursor to the new end", () => {
    const textarea = makeTextarea("alpha");
    textarea.setSelectionRange(5, 5);

    const selection = captureTextareaAppendSelection(textarea, textarea.value);
    textarea.value = "alpha beta";

    restoreTextareaAppendSelection(textarea, selection, textarea.value);

    expect(textarea.selectionStart).toBe(10);
    expect(textarea.selectionEnd).toBe(10);
  });

  it("ignores unfocused textareas", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "alpha";
    document.body.append(textarea);

    expect(captureTextareaAppendSelection(textarea, textarea.value)).toBeNull();
  });
});

describe("textarea speech edit selection", () => {
  it("preserves a cursor before a speech insertion", () => {
    const textarea = makeTextarea("alpha beta");
    textarea.setSelectionRange(3, 3);

    const selection = captureTextareaAppendSelection(textarea, textarea.value);
    textarea.value = "alpha speech beta";

    restoreTextareaInsertionSelection(textarea, selection, textarea.value, 6, 7);

    expect(textarea.selectionStart).toBe(3);
    expect(textarea.selectionEnd).toBe(3);
  });

  it("moves a cursor at the speech insertion point after inserted text", () => {
    const textarea = makeTextarea("alpha beta");
    textarea.setSelectionRange(6, 6);

    const selection = captureTextareaAppendSelection(textarea, textarea.value);
    textarea.value = "alpha speech beta";

    restoreTextareaInsertionSelection(textarea, selection, textarea.value, 6, 7);

    expect(textarea.selectionStart).toBe(13);
    expect(textarea.selectionEnd).toBe(13);
  });

  it("maps a cursor inside a cancelled speech range back to the range start", () => {
    const textarea = makeTextarea("alpha speech beta");
    textarea.setSelectionRange(9, 9);

    const selection = captureTextareaAppendSelection(textarea, textarea.value);
    textarea.value = "alpha  beta";

    restoreTextareaReplacementSelection(
      textarea,
      selection,
      textarea.value,
      6,
      12,
      0,
    );

    expect(textarea.selectionStart).toBe(6);
    expect(textarea.selectionEnd).toBe(6);
  });
});
