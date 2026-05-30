function quote(text: string): string {
  return JSON.stringify(text);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) return count;
    count += 1;
    index = next + needle.length;
  }
}

function commonPrefixLength(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(a: string, b: string, prefixLength: number): number {
  let length = 0;
  while (
    length + prefixLength < a.length &&
    length + prefixLength < b.length &&
    a[a.length - 1 - length] === b[b.length - 1 - length]
  ) {
    length += 1;
  }
  return length;
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /^[\p{L}\p{N}_]$/u.test(char);
}

function splitsWordAt(text: string, index: number): boolean {
  return isWordChar(text[index - 1]) && isWordChar(text[index]);
}

function expandedMiddleRange(
  original: string,
  corrected: string,
  prefixLength: number,
  suffixLength: number,
): {
  beforeMiddle: string;
  afterMiddle: string;
} {
  let beforeStart = prefixLength;
  let afterStart = prefixLength;
  let beforeEnd = original.length - suffixLength;
  let afterEnd = corrected.length - suffixLength;

  while (
    beforeStart > 0 &&
    afterStart > 0 &&
    (splitsWordAt(original, beforeStart) || splitsWordAt(corrected, afterStart))
  ) {
    beforeStart -= 1;
    afterStart -= 1;
  }

  while (
    beforeEnd < original.length &&
    afterEnd < corrected.length &&
    (splitsWordAt(original, beforeEnd) || splitsWordAt(corrected, afterEnd))
  ) {
    beforeEnd += 1;
    afterEnd += 1;
  }

  return {
    beforeMiddle: original.slice(beforeStart, beforeEnd),
    afterMiddle: corrected.slice(afterStart, afterEnd),
  };
}

function trailingAnchor(text: string, source: string): string | null {
  const words = text.trim().match(/\S+/g);
  if (!words?.length) return null;
  for (let size = 1; size <= Math.min(5, words.length); size += 1) {
    const anchor = words.slice(words.length - size).join(" ");
    if (anchor.length <= 80 && countOccurrences(source, anchor) === 1) {
      return anchor;
    }
  }
  return null;
}

function leadingAnchor(text: string, source: string): string | null {
  const words = text.trim().match(/\S+/g);
  if (!words?.length) return null;
  for (let size = 1; size <= Math.min(5, words.length); size += 1) {
    const anchor = words.slice(0, size).join(" ");
    if (anchor.length <= 80 && countOccurrences(source, anchor) === 1) {
      return anchor;
    }
  }
  return null;
}

function correctionMessage(corrected: string, change?: string): string {
  const message = `Correction to previous message:\n${corrected}`;
  return change ? `${message}\n\nChange: ${change}` : message;
}

export function buildCorrectionText(before: string, after: string): string | null {
  const original = before.trim();
  const corrected = after.trim();
  if (!corrected || original === corrected) {
    return null;
  }

  const prefixLength = commonPrefixLength(original, corrected);
  const suffixLength = commonSuffixLength(original, corrected, prefixLength);
  const { beforeMiddle, afterMiddle } = expandedMiddleRange(
    original,
    corrected,
    prefixLength,
    suffixLength,
  );

  const smallBefore = beforeMiddle.length > 0 && beforeMiddle.length <= 80;
  const smallAfter = afterMiddle.length > 0 && afterMiddle.length <= 80;

  if (smallBefore && smallAfter && countOccurrences(original, beforeMiddle) === 1) {
    return correctionMessage(
      corrected,
      `replace ${quote(beforeMiddle)} with ${quote(afterMiddle)}.`,
    );
  }

  if (smallBefore && !afterMiddle && countOccurrences(original, beforeMiddle) === 1) {
    return correctionMessage(corrected, `delete ${quote(beforeMiddle)}.`);
  }

  if (!beforeMiddle && smallAfter) {
    const prefix = original.slice(0, prefixLength);
    const suffix = original.slice(prefixLength);
    const afterAnchor = trailingAnchor(prefix, original);
    if (afterAnchor) {
      return correctionMessage(
        corrected,
        `insert ${quote(afterMiddle)} after ${quote(afterAnchor)}.`,
      );
    }
    const beforeAnchor = leadingAnchor(suffix, original);
    if (beforeAnchor) {
      return correctionMessage(
        corrected,
        `insert ${quote(afterMiddle)} before ${quote(beforeAnchor)}.`,
      );
    }
  }

  return correctionMessage(corrected);
}
