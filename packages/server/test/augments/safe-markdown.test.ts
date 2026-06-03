import { describe, expect, it } from "vitest";
import {
  isLocalFilePath,
  localMediaApiUrl,
  renderSafeMarkdown,
} from "../../src/augments/safe-markdown.js";

describe("renderSafeMarkdown — math", () => {
  it("renders inline $…$ through katex", () => {
    const html = renderSafeMarkdown("price: $x^2 + 1$ end");
    // placeholder is substituted with katex HTML
    expect(html).not.toContain("yepkatex-placeholder");
    expect(html).toContain('class="katex"');
    expect(html).toContain("end</p>");
  });

  it("renders block $$…$$ in display mode", () => {
    const html = renderSafeMarkdown("$$\n\\frac{1}{2}\n$$");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("yepkatex-placeholder");
  });

  it("does not treat currency-like $100 and $200 as math", () => {
    const html = renderSafeMarkdown("price is $100 and $200 total");
    expect(html).not.toContain("katex");
    expect(html).toContain("$100");
    expect(html).toContain("$200");
  });

  it("does not treat $ with trailing space as inline math", () => {
    const html = renderSafeMarkdown("single dollar $ followed by text$");
    expect(html).not.toContain("katex");
  });

  it("escapes katex-invalid input as an error span rather than crashing", () => {
    const html = renderSafeMarkdown("bad: $\\undefinedmacro{x}$ done");
    // katex prints the error span itself (has class "katex-error") when
    // throwOnError: false; our sanitize pass strips style attrs it
    // disallows but keeps span+class.
    expect(html).toContain("done");
  });

  it("blocks javascript: hrefs in katex \\href (trust: false)", () => {
    // If trust were left enabled, \href could emit a dangerous link.
    const html = renderSafeMarkdown("$\\href{javascript:alert(1)}{x}$");
    // The rendered output must not produce an executable link href.
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("still renders non-math markdown unchanged", () => {
    const html = renderSafeMarkdown("**bold** and `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("strips inline HTML in surrounding prose", () => {
    const html = renderSafeMarkdown("plain <script>bad()</script> $y$ end");
    expect(html).not.toContain("<script>");
    expect(html).toContain('class="katex"');
  });

  it("handles multiple inline math spans in a single call", () => {
    const html = renderSafeMarkdown("$a$ and $b$ and $c$");
    // three independent katex renders
    const count = (html.match(/class="katex"/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("renders inline math inside markdown list items", () => {
    const html = renderSafeMarkdown("- first $x^2$\n- second $y^2$");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>first ");
    const count = (html.match(/class="katex"/g) ?? []).length;
    expect(count).toBe(2);
  });

  it("renders inline math inside markdown table cells", () => {
    const html = renderSafeMarkdown(
      "| expr | value |\n| --- | --- |\n| $x^2$ | $\\frac{1}{2}$ |",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<td>");
    const count = (html.match(/class="katex"/g) ?? []).length;
    expect(count).toBe(2);
  });

  it("does not leave rendered formulas HTML-escaped in markdown output", () => {
    const html = renderSafeMarkdown("row: $x^2$");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("&lt;span class=&quot;katex&quot;");
    expect(html).not.toContain("$x^2$");
  });
});

describe("renderSafeMarkdown — local file links", () => {
  it("routes local markdown links through the rendered text file endpoint", () => {
    const html = renderSafeMarkdown("[notes](/tmp/session-notes.md)");

    expect(html).toContain(
      'href="/api/local-file?path=%2Ftmp%2Fsession-notes.md&amp;render=1"',
    );
    expect(html).toContain('data-ya-resource="local-file"');
    expect(html).toContain('data-ya-path="/tmp/session-notes.md"');
    expect(html).toContain('data-ya-render-markdown="true"');
    expect(html).not.toContain("/api/local-image");
  });

  it("keeps line hints out of local markdown link paths", () => {
    const html = renderSafeMarkdown("[notes](/tmp/session-notes.md:8)");

    expect(html).toContain(
      'href="/api/local-file?path=%2Ftmp%2Fsession-notes.md&amp;render=1&amp;line=8"',
    );
    expect(html).toContain('title="/tmp/session-notes.md:8"');
    expect(html).toContain('data-ya-line="8"');
    expect(html).not.toContain("session-notes.md%3A8");
  });

  it("adds semantic metadata to local text file links", () => {
    const html = renderSafeMarkdown(
      "[probe json](C:/tmp/playbox-zero-g-compare.json:12:4)",
    );

    expect(html).toContain(
      'href="/api/local-file?path=C%3A%2Ftmp%2Fplaybox-zero-g-compare.json&amp;line=12&amp;column=4"',
    );
    expect(html).toContain('data-ya-resource="local-file"');
    expect(html).toContain('data-ya-path="C:/tmp/playbox-zero-g-compare.json"');
    expect(html).toContain('data-ya-line="12"');
    expect(html).toContain('data-ya-column="4"');
    expect(html).toContain('data-ya-render-markdown="false"');
  });

  it("keeps local media links on the media endpoint", () => {
    const html = renderSafeMarkdown("[shot](/tmp/screenshot.png)");

    expect(html).toContain(
      'href="/api/local-image?path=%2Ftmp%2Fscreenshot.png"',
    );
    expect(html).toContain('class="local-media-link"');
    expect(html).toContain('class="local-media-inline-toggle"');
    expect(html).toContain('class="local-media-inline-preview"');
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('aria-label="Expand image"');
    expect(html).toContain('data-ya-resource="local-media"');
    expect(html).toContain('data-ya-path="/tmp/screenshot.png"');
    expect(html).toContain('data-ya-media-type="image"');
  });

  it("resolves relative local file links against a base directory", () => {
    const html = renderSafeMarkdown("[peer](docs/peer.md)", {
      localFileBasePath: "/workspace/project",
    });

    expect(html).toContain(
      'href="/api/local-file?path=%2Fworkspace%2Fproject%2Fdocs%2Fpeer.md&amp;render=1"',
    );
    expect(html).toContain('title="/workspace/project/docs/peer.md"');
    expect(html).toContain('data-ya-path="/workspace/project/docs/peer.md"');
  });

  it("preserves line hints on relative local file links", () => {
    const html = renderSafeMarkdown("[peer](docs/peer.md:12)", {
      localFileBasePath: "/workspace/project",
    });

    expect(html).toContain(
      'href="/api/local-file?path=%2Fworkspace%2Fproject%2Fdocs%2Fpeer.md&amp;render=1&amp;line=12"',
    );
    expect(html).toContain('title="/workspace/project/docs/peer.md:12"');
  });

  it("resolves relative local images as inline media placeholders", () => {
    const html = renderSafeMarkdown("![diagram](assets/diagram.svg)", {
      localFileBasePath: "/workspace/project/docs",
    });

    expect(html).toContain(
      'href="/api/local-image?path=%2Fworkspace%2Fproject%2Fdocs%2Fassets%2Fdiagram.svg"',
    );
    expect(html).toContain(
      'data-media-path="/workspace/project/docs/assets/diagram.svg"',
    );
    expect(html).toContain('class="local-media-inline-preview"');
  });

  it("can emit direct local images for standalone rendered documents", () => {
    const html = renderSafeMarkdown("![diagram](assets/diagram.svg)", {
      localFileBasePath: "/workspace/project/docs",
      inlineLocalImages: true,
    });

    expect(html).toContain(
      '<img src="/api/local-image?path=%2Fworkspace%2Fproject%2Fdocs%2Fassets%2Fdiagram.svg" alt="diagram"',
    );
    expect(html).toContain(
      'data-ya-path="/workspace/project/docs/assets/diagram.svg"',
    );
    expect(html).toContain('data-ya-resource="local-media"');
    expect(html).not.toContain("local-media-inline-preview");
  });

  it("rewrites Windows drive paths with forward slashes to local media links", () => {
    const html = renderSafeMarkdown(
      "[Sample image](C:/tmp/playbox-autocollider-provider-fit.png)",
    );

    expect(html).toContain('class="local-media-link"');
    expect(html).toContain('data-media-type="image"');
    expect(html).toContain(
      "path=C%3A%2Ftmp%2Fplaybox-autocollider-provider-fit.png",
    );
  });

  it("recognizes Windows drive paths with backslashes", () => {
    const filePath = String.raw`C:\tmp\playbox-autocollider-provider-fit.png`;

    expect(isLocalFilePath(filePath)).toBe(true);
    expect(localMediaApiUrl(filePath)).toBe(
      "/api/local-image?path=C%3A%5Ctmp%5Cplaybox-autocollider-provider-fit.png",
    );
  });
});
