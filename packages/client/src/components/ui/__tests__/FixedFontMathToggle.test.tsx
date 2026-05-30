import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  FixedFontMathToggle,
  mayHaveFixedFontRichContent,
} from "../FixedFontMathToggle";

describe("FixedFontMathToggle", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses a precomputed render result for toggle state and display", () => {
    render(
      <FixedFontMathToggle
        sourceText="plain text"
        precomputedRendered={{
          html: "<strong>precomputed</strong>",
          changed: true,
        }}
        sourceView={<pre>plain text</pre>}
        renderRenderedView={(html) => (
          <div
            // biome-ignore lint/security/noDangerouslySetInnerHtml: test-controlled precomputed HTML
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      />,
    );

    expect(screen.getByText("precomputed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show source" })).toBeTruthy();
  });
});

describe("mayHaveFixedFontRichContent", () => {
  it("rejects plain output without running the rich renderer", () => {
    expect(mayHaveFixedFontRichContent("plain output\nwithout markup")).toBe(
      false,
    );
  });

  it("accepts common markdown and math candidates conservatively", () => {
    expect(mayHaveFixedFontRichContent("## Heading")).toBe(true);
    expect(mayHaveFixedFontRichContent("value is $x^2$")).toBe(true);
    expect(mayHaveFixedFontRichContent("| a | b |\n| - | - |")).toBe(true);
  });
});
