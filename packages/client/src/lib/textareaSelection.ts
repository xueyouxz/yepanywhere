export interface TextareaAppendSelection {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
  scrollTop: number;
  followEnd: boolean;
}

export function captureTextareaAppendSelection(
  textarea: HTMLTextAreaElement | null,
  previousValue: string,
): TextareaAppendSelection | null {
  if (
    !textarea ||
    typeof document === "undefined" ||
    document.activeElement !== textarea
  ) {
    return null;
  }

  const { selectionStart, selectionEnd, selectionDirection, scrollTop } =
    textarea;
  return {
    start: selectionStart,
    end: selectionEnd,
    direction: selectionDirection,
    scrollTop,
    followEnd:
      selectionStart === previousValue.length &&
      selectionEnd === previousValue.length,
  };
}

export function restoreTextareaAppendSelection(
  textarea: HTMLTextAreaElement | null,
  selection: TextareaAppendSelection | null,
  nextValue: string,
): void {
  if (!textarea || !selection) return;

  const nextLength = nextValue.length;
  const start = selection.followEnd
    ? nextLength
    : Math.min(selection.start, nextLength);
  const end = selection.followEnd
    ? nextLength
    : Math.min(selection.end, nextLength);

  textarea.setSelectionRange(start, end, selection.direction);
  textarea.scrollTop = selection.followEnd
    ? textarea.scrollHeight
    : selection.scrollTop;
}

export function restoreTextareaInsertionSelection(
  textarea: HTMLTextAreaElement | null,
  selection: TextareaAppendSelection | null,
  nextValue: string,
  insertionStart: number,
  insertedLength: number,
): void {
  restoreTextareaReplacementSelection(
    textarea,
    selection,
    nextValue,
    insertionStart,
    insertionStart,
    insertedLength,
  );
}

export function restoreTextareaReplacementSelection(
  textarea: HTMLTextAreaElement | null,
  selection: TextareaAppendSelection | null,
  nextValue: string,
  replacementStart: number,
  replacementEnd: number,
  insertedLength: number,
): void {
  if (!textarea || !selection) return;

  const nextLength = nextValue.length;
  const start = Math.max(0, Math.min(replacementStart, nextLength));
  const end = Math.max(start, replacementEnd);
  const delta = insertedLength - (end - start);
  const mapPosition = (position: number): number => {
    if (selection.followEnd) return nextLength;
    if (position < start) return Math.max(0, Math.min(position, nextLength));
    if (start === end) {
      return Math.max(0, Math.min(position + insertedLength, nextLength));
    }
    if (position > end) {
      return Math.max(0, Math.min(position + delta, nextLength));
    }
    return Math.max(0, Math.min(start + insertedLength, nextLength));
  };

  textarea.setSelectionRange(
    mapPosition(selection.start),
    mapPosition(selection.end),
    selection.direction,
  );
  textarea.scrollTop = selection.followEnd
    ? textarea.scrollHeight
    : selection.scrollTop;
}
