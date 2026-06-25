import { describe, expect, it } from "vitest";
import {
  createCommentAnchor,
  draftContainsAnchorQuote,
  draftQuoteSignaturesContainAnchor,
  getCommentAnchorRange,
  getDraftQuoteLineSignatures,
  getDraftTextChangeMetadata,
} from "../commentAnchors";

describe("comment anchors", () => {
  it("resolves a fresh source range after rendered paragraph text is replaced", () => {
    const sourceElement = document.createElement("div");
    const replacementParagraph = document.createElement("p");
    replacementParagraph.textContent = "Quoted paragraph text.";
    sourceElement.append(replacementParagraph);
    document.body.append(sourceElement);

    const staleParagraph = document.createElement("p");
    staleParagraph.textContent = "Quoted paragraph text.";
    const range = document.createRange();
    range.setStart(staleParagraph.firstChild as Text, 0);
    range.setEnd(
      staleParagraph.firstChild as Text,
      staleParagraph.textContent.length,
    );
    const anchor = createCommentAnchor({
      markdown: "Quoted paragraph text.",
      selectedText: "Quoted paragraph text.",
      sourceElement,
      range,
    });

    const resolved = getCommentAnchorRange(anchor);
    expect(anchor.range.startContainer.isConnected).toBe(false);
    expect(resolved?.startContainer.isConnected).toBe(true);
    expect(resolved?.endContainer.isConnected).toBe(true);
    expect(resolved?.toString()).toBe("Quoted paragraph text.");

    sourceElement.remove();
  });

  it("keeps anchors live while a matching quoted line remains", () => {
    const sourceElement = document.createElement("div");
    const range = document.createRange();
    range.selectNodeContents(sourceElement);
    const anchor = createCommentAnchor({
      markdown: "Quoted paragraph text.",
      selectedText: "Quoted paragraph text.",
      sourceElement,
      range,
    });

    expect(draftContainsAnchorQuote("> Quoted paragraph text.", anchor)).toBe(
      true,
    );
    expect(draftContainsAnchorQuote("Quoted paragraph text.", anchor)).toBe(
      false,
    );
  });

  it("reuses one draft quote signature set for anchor checks", () => {
    const sourceElement = document.createElement("div");
    const range = document.createRange();
    range.selectNodeContents(sourceElement);
    const anchor = createCommentAnchor({
      markdown: "Quoted paragraph text.",
      selectedText: "Quoted paragraph text.",
      sourceElement,
      range,
    });
    const signatures = getDraftQuoteLineSignatures(
      "ordinary text\n> Quoted paragraph text.\n  > another quote",
    );

    expect(draftQuoteSignaturesContainAnchor(signatures, anchor)).toBe(true);
  });

  it("skips quote-anchor reconciliation for ordinary non-quote edits", () => {
    const previousText = "> quote\n\ncomment";

    expect(
      getDraftTextChangeMetadata(previousText, `${previousText}!`, {
        start: previousText.length,
        end: previousText.length,
        insertedText: "!",
      }).mayAffectQuoteAnchors,
    ).toBe(false);
    expect(
      getDraftTextChangeMetadata(previousText, "> quote\n\ncommen", {
        start: previousText.length - 1,
        end: previousText.length,
        insertedText: "",
      }).mayAffectQuoteAnchors,
    ).toBe(false);
  });

  it("runs quote-anchor reconciliation for quote-line edits", () => {
    expect(
      getDraftTextChangeMetadata("> quote\n\ncomment", " quote\n\ncomment", {
        start: 0,
        end: 1,
        insertedText: "",
      }).mayAffectQuoteAnchors,
    ).toBe(true);
    expect(
      getDraftTextChangeMetadata("quote", "> quote", {
        start: 0,
        end: 0,
        insertedText: "> ",
      }).mayAffectQuoteAnchors,
    ).toBe(true);
    expect(
      getDraftTextChangeMetadata("comment\nquote", "comment\n> quote", {
        start: "comment\n".length,
        end: "comment\n".length,
        insertedText: "> ",
      }).mayAffectQuoteAnchors,
    ).toBe(true);
  });

  it("keeps undo and unknown edits conservative", () => {
    expect(
      getDraftTextChangeMetadata("> quote", "quote", {
        start: 0,
        end: 1,
        insertedText: "",
        inputType: "historyUndo",
      }).mayAffectQuoteAnchors,
    ).toBe(true);
    expect(
      getDraftTextChangeMetadata("> quote", "quote").mayAffectQuoteAnchors,
    ).toBe(true);
  });
});
