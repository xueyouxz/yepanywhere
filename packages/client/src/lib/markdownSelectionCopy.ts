const MARKDOWN_COPY_SOURCE_ATTR = "data-markdown-copy-source";

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

interface VisibleCharSource {
  sourceIndex: number;
  lineIndex: number;
}

interface VisibleLine {
  visibleStart: number;
  visibleEnd: number;
  sourceStart: number;
  sourceEnd: number;
  forceWholeLine: boolean;
}

interface VisibleSourceMap {
  visible: string;
  charSources: Array<VisibleCharSource | null>;
  lines: VisibleLine[];
}

interface NormalizedTextMap {
  text: string;
  map: number[];
}

interface RangeTextWithinElement {
  selectedText: string;
  textBefore: string;
  preferExactSource: boolean;
}

const markdownCopySources = new WeakMap<HTMLElement, string>();

export function registerMarkdownCopySource(
  element: HTMLElement,
  source: string,
): () => void {
  element.setAttribute(MARKDOWN_COPY_SOURCE_ATTR, "true");
  markdownCopySources.set(element, source);

  return () => {
    markdownCopySources.delete(element);
    element.removeAttribute(MARKDOWN_COPY_SOURCE_ATTR);
  };
}

export function copyMarkdownSelectionToClipboard(
  event: ClipboardEvent,
  root: HTMLElement,
): boolean {
  if (event.defaultPrevented || !event.clipboardData) {
    return false;
  }

  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  const snippets: string[] = [];
  const sourceElements = Array.from(
    root.querySelectorAll<HTMLElement>(`[${MARKDOWN_COPY_SOURCE_ATTR}]`),
  );

  for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
    const range = selection.getRangeAt(rangeIndex);
    if (!rangeIntersectsNode(range, root)) {
      continue;
    }

    for (const element of sourceElements) {
      if (!rangeIntersectsNode(range, element)) {
        continue;
      }

      const source = markdownCopySources.get(element);
      if (!source) {
        continue;
      }

      const rangeText = getRangeTextWithinElement(range, element);
      if (!rangeText || !rangeText.selectedText.trim()) {
        continue;
      }

      const markdown =
        getMarkdownForVisibleSelection(source, rangeText.selectedText, {
          textBefore: rangeText.textBefore,
          preferExactSource: rangeText.preferExactSource,
        }) ?? rangeText.selectedText;
      const normalized = trimBoundaryNewlines(markdown);
      if (normalized.trim()) {
        snippets.push(normalized);
      }
    }
  }

  if (snippets.length === 0) {
    return false;
  }

  event.clipboardData.setData("text/plain", snippets.join("\n\n"));
  event.preventDefault();
  return true;
}

export function getMarkdownForVisibleSelection(
  source: string,
  selectedText: string,
  options: {
    textBefore?: string;
    preferExactSource?: boolean;
  } = {},
): string | null {
  const normalizedSource = normalizeLineEndings(source);
  const normalizedSelection = normalizeLineEndings(selectedText);
  if (!normalizedSelection.trim()) {
    return null;
  }

  const exactSelection = findExactSourceSelection(
    normalizedSource,
    normalizedSelection,
  );
  if (options.preferExactSource && exactSelection !== null) {
    return exactSelection;
  }

  const sourceMap = buildVisibleSourceMap(normalizedSource);
  const selectionMap = buildVisibleSourceMap(normalizedSelection);
  const sourceMatch = normalizeTextForMatchWithMap(sourceMap.visible);
  const targetMatch = normalizeTextForMatch(selectionMap.visible);
  if (!targetMatch) {
    return exactSelection;
  }

  const preferredStart = options.textBefore
    ? normalizeTextForMatch(buildVisibleSourceMap(options.textBefore).visible)
        .length
    : 0;
  const matchIndex = findBestMatchIndex(
    sourceMatch.text,
    targetMatch,
    preferredStart,
  );
  if (matchIndex === -1) {
    return exactSelection;
  }

  const matchEndIndex = matchIndex + targetMatch.length - 1;
  const visibleStart = sourceMatch.map[matchIndex];
  const visibleEndChar = sourceMatch.map[matchEndIndex];
  if (visibleStart === undefined || visibleEndChar === undefined) {
    return exactSelection;
  }

  const visibleEnd = visibleEndChar + 1;
  let sourceStart = Number.POSITIVE_INFINITY;
  let sourceEnd = -1;
  const touchedLineIndexes = new Set<number>();

  for (
    let visibleIndex = visibleStart;
    visibleIndex < visibleEnd && visibleIndex < sourceMap.charSources.length;
    visibleIndex += 1
  ) {
    const charSource = sourceMap.charSources[visibleIndex];
    if (!charSource) {
      continue;
    }
    sourceStart = Math.min(sourceStart, charSource.sourceIndex);
    sourceEnd = Math.max(sourceEnd, charSource.sourceIndex + 1);
    touchedLineIndexes.add(charSource.lineIndex);
  }

  if (!Number.isFinite(sourceStart) || sourceEnd < sourceStart) {
    return exactSelection;
  }

  for (const lineIndex of touchedLineIndexes) {
    const line = sourceMap.lines[lineIndex];
    if (!line?.forceWholeLine) {
      continue;
    }
    sourceStart = Math.min(sourceStart, line.sourceStart);
    sourceEnd = Math.max(sourceEnd, line.sourceEnd);
  }

  return trimBoundaryNewlines(normalizedSource.slice(sourceStart, sourceEnd));
}

function findExactSourceSelection(
  source: string,
  selectedText: string,
): string | null {
  if (source.includes(selectedText)) {
    return selectedText;
  }

  const trimmed = trimBoundaryNewlines(selectedText);
  if (trimmed !== selectedText && source.includes(trimmed)) {
    return trimmed;
  }

  return null;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function trimBoundaryNewlines(value: string): string {
  return normalizeLineEndings(value).replace(/^\n+|\n+$/g, "");
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function getRangeTextWithinElement(
  range: Range,
  element: HTMLElement,
): RangeTextWithinElement | null {
  const elementRange = element.ownerDocument.createRange();
  elementRange.selectNodeContents(element);
  if (!rangeIntersectsNode(range, element)) {
    return null;
  }

  const clippedRange = range.cloneRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, elementRange) < 0) {
    clippedRange.setStart(
      elementRange.startContainer,
      elementRange.startOffset,
    );
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, elementRange) > 0) {
    clippedRange.setEnd(elementRange.endContainer, elementRange.endOffset);
  }

  const beforeRange = element.ownerDocument.createRange();
  beforeRange.setStart(elementRange.startContainer, elementRange.startOffset);
  beforeRange.setEnd(clippedRange.startContainer, clippedRange.startOffset);

  const sourceModeElements = Array.from(
    element.querySelectorAll<HTMLElement>(".text-block-source"),
  );

  return {
    selectedText: clippedRange.toString(),
    textBefore: beforeRange.toString(),
    preferExactSource: sourceModeElements.some((sourceElement) =>
      rangeIntersectsNode(clippedRange, sourceElement),
    ),
  };
}

function splitSourceLines(source: string): SourceLine[] {
  const lines = source.split("\n");
  let start = 0;
  return lines.map((text) => {
    const end = start + text.length;
    const line = { text, start, end };
    start = end + 1;
    return line;
  });
}

function buildVisibleSourceMap(source: string): VisibleSourceMap {
  const normalizedSource = normalizeLineEndings(source);
  const sourceLines = splitSourceLines(normalizedSource);
  const lines: VisibleLine[] = [];
  const charSources: Array<VisibleCharSource | null> = [];
  let visible = "";

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const sourceLine = sourceLines[lineIndex];
    if (!sourceLine) {
      continue;
    }

    const visibleStart = visible.length;
    const lineMap = buildVisibleLineMap(sourceLine.text, sourceLine.start);
    visible += lineMap.visible;
    charSources.push(...lineMap.charSources.map((sourceIndex) => ({
      sourceIndex,
      lineIndex,
    })));
    const visibleEnd = visible.length;
    lines.push({
      visibleStart,
      visibleEnd,
      sourceStart: sourceLine.start,
      sourceEnd: sourceLine.end,
      forceWholeLine: lineMap.forceWholeLine,
    });

    if (lineIndex < sourceLines.length - 1) {
      visible += "\n";
      charSources.push({ sourceIndex: sourceLine.end, lineIndex });
    }
  }

  return { visible, charSources, lines };
}

function buildVisibleLineMap(
  line: string,
  sourceLineStart: number,
): {
  visible: string;
  charSources: number[];
  forceWholeLine: boolean;
} {
  const blockPrefix = getMarkdownBlockPrefix(line);
  const visibleParts: string[] = [];
  const charSources: number[] = [];

  const appendSourceChar = (index: number) => {
    visibleParts.push(line[index] ?? "");
    charSources.push(sourceLineStart + index);
  };

  for (let index = blockPrefix.contentStart; index < line.length; index += 1) {
    const escapedIndex = getEscapedMarkdownCharIndex(line, index);
    if (escapedIndex !== null) {
      appendSourceChar(escapedIndex);
      index = escapedIndex;
      continue;
    }

    const link = getInlineLinkSpan(line, index);
    if (link) {
      for (
        let textIndex = link.textStart;
        textIndex < link.textEnd;
        textIndex += 1
      ) {
        appendSourceChar(textIndex);
      }
      index = link.end;
      continue;
    }

    if (isInlineMarkdownDelimiter(line[index] ?? "")) {
      continue;
    }

    appendSourceChar(index);
  }

  return {
    visible: visibleParts.join(""),
    charSources,
    forceWholeLine: blockPrefix.forceWholeLine,
  };
}

function getMarkdownBlockPrefix(line: string): {
  contentStart: number;
  forceWholeLine: boolean;
} {
  let contentStart = line.match(/^[ \t]{0,3}/)?.[0].length ?? 0;
  let forceWholeLine = false;

  while (contentStart < line.length) {
    const rest = line.slice(contentStart);
    const blockquote = /^>\s?/.exec(rest);
    if (blockquote) {
      contentStart += blockquote[0].length;
      forceWholeLine = true;
      continue;
    }

    const heading = /^#{1,6}(?:\s+|$)/.exec(rest);
    if (heading) {
      contentStart += heading[0].length;
      forceWholeLine = true;
      continue;
    }

    const taskList = /^[-+*]\s+\[[ xX]\]\s+/.exec(rest);
    if (taskList) {
      contentStart += taskList[0].length;
      forceWholeLine = true;
      continue;
    }

    const orderedList = /^\d{1,9}[.)]\s+/.exec(rest);
    if (orderedList) {
      contentStart += orderedList[0].length;
      forceWholeLine = true;
      continue;
    }

    const unorderedList = /^(?:[-+*]|[•‣⁃])\s+/.exec(rest);
    if (unorderedList) {
      contentStart += unorderedList[0].length;
      forceWholeLine = true;
      continue;
    }

    break;
  }

  return { contentStart, forceWholeLine };
}

function getEscapedMarkdownCharIndex(
  line: string,
  index: number,
): number | null {
  if (line[index] !== "\\") {
    return null;
  }
  const nextIndex = index + 1;
  if (nextIndex >= line.length) {
    return null;
  }
  return "\\`*_{}[]()#+-.!~|>".includes(line[nextIndex] ?? "")
    ? nextIndex
    : null;
}

function getInlineLinkSpan(
  line: string,
  index: number,
): { textStart: number; textEnd: number; end: number } | null {
  const hasImageBang = line[index] === "!" && line[index + 1] === "[";
  const bracketIndex = hasImageBang ? index + 1 : index;
  if (line[bracketIndex] !== "[") {
    return null;
  }

  const textEnd = line.indexOf("]", bracketIndex + 1);
  if (textEnd === -1 || line[textEnd + 1] !== "(") {
    return null;
  }

  const urlEnd = line.indexOf(")", textEnd + 2);
  if (urlEnd === -1) {
    return null;
  }

  return {
    textStart: bracketIndex + 1,
    textEnd,
    end: urlEnd,
  };
}

function isInlineMarkdownDelimiter(char: string): boolean {
  return char === "`" || char === "*" || char === "_" || char === "~";
}

function normalizeTextForMatch(value: string): string {
  return normalizeTextForMatchWithMap(value).text;
}

function normalizeTextForMatchWithMap(value: string): NormalizedTextMap {
  const normalized = normalizeLineEndings(value).replace(/\u00a0/g, " ");
  const chars: string[] = [];
  const map: number[] = [];

  const removeTrailingHorizontalSpace = () => {
    if (chars[chars.length - 1] === " ") {
      chars.pop();
      map.pop();
    }
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    if (char === "\n") {
      removeTrailingHorizontalSpace();
      if (chars.length > 0 && chars[chars.length - 1] !== "\n") {
        chars.push("\n");
        map.push(index);
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (chars.length > 0) {
        const previous = chars[chars.length - 1];
        if (previous !== " " && previous !== "\n") {
          chars.push(" ");
          map.push(index);
        }
      }
      continue;
    }

    chars.push(char);
    map.push(index);
  }

  while (chars.length > 0 && /\s/.test(chars[chars.length - 1] ?? "")) {
    chars.pop();
    map.pop();
  }

  return { text: chars.join(""), map };
}

function findBestMatchIndex(
  source: string,
  target: string,
  preferredStart: number,
): number {
  let fallback = -1;
  let searchFrom = 0;
  const minimumPreferredStart = Math.max(0, preferredStart - 2);

  while (searchFrom <= source.length) {
    const index = source.indexOf(target, searchFrom);
    if (index === -1) {
      break;
    }
    if (fallback === -1) {
      fallback = index;
    }
    if (index >= minimumPreferredStart) {
      return index;
    }
    searchFrom = index + Math.max(1, target.length);
  }

  return fallback;
}
