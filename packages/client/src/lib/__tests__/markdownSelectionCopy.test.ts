import { describe, expect, it } from "vitest";
import { getMarkdownForVisibleSelection } from "../markdownSelectionCopy";

describe("getMarkdownForVisibleSelection", () => {
  it("preserves original ordered-list markers for rendered selections", () => {
    expect(
      getMarkdownForVisibleSelection(
        "1. First item\n1. Second item",
        "First item\nSecond item",
      ),
    ).toBe("1. First item\n1. Second item");
  });

  it("uses the source numbering when copied browser text was renumbered", () => {
    expect(
      getMarkdownForVisibleSelection(
        "1. First item\n1. Second item",
        "1. First item\n2. Second item",
      ),
    ).toBe("1. First item\n1. Second item");
  });

  it("uses rendered prefix context to pick repeated list items", () => {
    expect(
      getMarkdownForVisibleSelection(
        "1. Same\n2. Same",
        "Same",
        { textBefore: "Same\n" },
      ),
    ).toBe("2. Same");
  });

  it("keeps plain partial selections narrow", () => {
    expect(
      getMarkdownForVisibleSelection("alpha beta gamma", "beta"),
    ).toBe("beta");
  });

  it("preserves exact source-mode selections", () => {
    expect(
      getMarkdownForVisibleSelection("The **bold** word", "**bold**", {
        preferExactSource: true,
      }),
    ).toBe("**bold**");
  });
});
