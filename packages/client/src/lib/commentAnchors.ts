import type { MarkdownSelectionSnippet } from "./markdownSelectionCopy";
import { generateUUID } from "./uuid";

export interface CommentAnchor {
  id: string;
  sourceElement: HTMLElement;
  range: Range;
  selectedText: string;
  quotedText: string;
  lineSignatures: string[];
}

export interface DraftTextChangeMetadata {
  mayAffectQuoteAnchors: boolean;
}

export interface DraftTextEdit {
  start: number;
  end: number;
  insertedText: string;
  inputType?: string;
}

export function quoteMarkdown(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function createCommentAnchor(
  snippet: MarkdownSelectionSnippet,
): CommentAnchor {
  return {
    id: generateUUID(),
    sourceElement: snippet.sourceElement,
    range: snippet.range,
    selectedText: snippet.selectedText,
    quotedText: quoteMarkdown(snippet.markdown),
    lineSignatures: getQuoteLineSignatures(snippet.markdown),
  };
}

export function getCommentAnchorRange(anchor: CommentAnchor): Range | null {
  if (isPaintableRange(anchor.range)) {
    return anchor.range;
  }
  return findTextRange(anchor.sourceElement, anchor.selectedText);
}

export function draftContainsAnchorQuote(
  draft: string,
  anchor: CommentAnchor,
): boolean {
  return draftQuoteSignaturesContainAnchor(
    getDraftQuoteLineSignatures(draft),
    anchor,
  );
}

export function getDraftQuoteLineSignatures(draft: string): Set<string> {
  return new Set(
    draft
      .split("\n")
      .filter(isQuoteLine)
      .map(normalizeQuoteLineSignature)
      .filter(Boolean),
  );
}

export function draftQuoteSignaturesContainAnchor(
  draftSignatures: ReadonlySet<string>,
  anchor: CommentAnchor,
): boolean {
  if (anchor.lineSignatures.length === 0) {
    return false;
  }
  return anchor.lineSignatures.some((signature) =>
    draftSignatures.has(signature),
  );
}

export function getDraftTextChangeMetadata(
  previousText: string,
  nextText: string,
  edit?: DraftTextEdit,
): DraftTextChangeMetadata {
  if (previousText === nextText) {
    return { mayAffectQuoteAnchors: false };
  }
  if (!edit || edit.inputType?.startsWith("history")) {
    return { mayAffectQuoteAnchors: true };
  }
  const start = clampIndex(edit.start, previousText.length);
  const end = Math.max(start, clampIndex(edit.end, previousText.length));
  const insertedText = edit.insertedText;
  return {
    mayAffectQuoteAnchors:
      rangeTouchesQuoteLine(previousText, start, end) ||
      rangeTouchesQuoteLine(nextText, start, start + insertedText.length),
  };
}

function getQuoteLineSignatures(markdown: string): string[] {
  return markdown.split("\n").map(normalizeQuoteLineSignature).filter(Boolean);
}

function isQuoteLine(line: string): boolean {
  return /^[\t ]*>/.test(line);
}

function normalizeQuoteLineSignature(line: string): string {
  return line
    .replace(/^[\t ]*>\s?/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(length, Math.trunc(index)));
}

function rangeTouchesQuoteLine(
  text: string,
  start: number,
  end: number,
): boolean {
  if (!text) {
    return false;
  }
  const from = clampIndex(start, text.length);
  const to = Math.max(from, clampIndex(end, text.length));
  if (lineAtIndexStartsWithQuote(text, from)) {
    return true;
  }
  if (to > from && lineAtIndexStartsWithQuote(text, to - 1)) {
    return true;
  }
  if (to < text.length && lineAtIndexStartsWithQuote(text, to)) {
    return true;
  }
  for (let index = from; index < to; index += 1) {
    if (text[index] === "\n" && lineAtIndexStartsWithQuote(text, index + 1)) {
      return true;
    }
  }
  return false;
}

function lineAtIndexStartsWithQuote(text: string, index: number): boolean {
  if (!text) {
    return false;
  }
  const position = clampIndex(index, text.length);
  const searchFrom = Math.max(0, position - 1);
  const lineStart = text.lastIndexOf("\n", searchFrom) + 1;
  return lineStartsWithQuote(text, lineStart);
}

function lineStartsWithQuote(text: string, lineStart: number): boolean {
  for (let index = lineStart; index < text.length; index += 1) {
    const char = text[index];
    if (char === " " || char === "\t") {
      continue;
    }
    return char === ">";
  }
  return false;
}

function isPaintableRange(range: Range): boolean {
  if (
    range.collapsed ||
    !range.startContainer.isConnected ||
    !range.endContainer.isConnected
  ) {
    return false;
  }
  if (typeof range.getClientRects !== "function") {
    return true;
  }
  return range.getClientRects().length > 0;
}

interface TextPosition {
  node: Text;
  offset: number;
}

interface TextIndex {
  text: string;
  positions: TextPosition[];
}

function buildTextIndex(element: HTMLElement): TextIndex | null {
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.textContent && node.textContent.length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  let text = "";
  const positions: TextPosition[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const value = textNode.textContent ?? "";
    for (let offset = 0; offset <= value.length; offset += 1) {
      positions[text.length + offset] = { node: textNode, offset };
    }
    text += value;
  }
  return text ? { text, positions } : null;
}

function findTextRange(
  sourceElement: HTMLElement,
  selectedText: string,
): Range | null {
  if (!sourceElement.isConnected) {
    return null;
  }
  const index = buildTextIndex(sourceElement);
  if (!index) {
    return null;
  }

  const exactStart = index.text.indexOf(selectedText);
  if (exactStart >= 0) {
    return createTextRange(
      sourceElement,
      index.positions,
      exactStart,
      exactStart + selectedText.length,
    );
  }

  const source = normalizeTextWithMap(index.text);
  const needle = normalizeTextWithMap(selectedText);
  if (!needle.text) {
    return null;
  }
  const normalizedStart = source.text.indexOf(needle.text);
  if (normalizedStart < 0) {
    return null;
  }
  const normalizedEnd = normalizedStart + needle.text.length - 1;
  const start = source.map[normalizedStart];
  const end = source.map[normalizedEnd];
  if (start === undefined || end === undefined) {
    return null;
  }
  return createTextRange(sourceElement, index.positions, start, end + 1);
}

function createTextRange(
  sourceElement: HTMLElement,
  positions: TextPosition[],
  start: number,
  end: number,
): Range | null {
  const startPosition = positions[start];
  const endPosition = positions[end];
  if (!startPosition || !endPosition) {
    return null;
  }
  const range = sourceElement.ownerDocument.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);
  return range;
}

function normalizeTextWithMap(text: string): { text: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  let pendingSpaceIndex: number | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (/\s/.test(char)) {
      if (normalized.length > 0 && pendingSpaceIndex === null) {
        pendingSpaceIndex = index;
      }
      continue;
    }
    if (pendingSpaceIndex !== null) {
      normalized += " ";
      map.push(pendingSpaceIndex);
      pendingSpaceIndex = null;
    }
    normalized += char;
    map.push(index);
  }
  return { text: normalized, map };
}
