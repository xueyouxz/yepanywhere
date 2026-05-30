import { describe, expect, it } from "vitest";
import {
  hasAnsiEscapes,
  renderAnsiToHtml,
} from "../src/ansi-renderer.js";

describe("hasAnsiEscapes", () => {
  it("detects CSI introducer", () => {
    expect(hasAnsiEscapes("\x1b[31mred\x1b[0m")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(hasAnsiEscapes("just text, no escapes")).toBe(false);
  });

  it("returns false for bare ESC without bracket", () => {
    expect(hasAnsiEscapes("\x1bfoo")).toBe(false);
  });
});

describe("renderAnsiToHtml", () => {
  it("passes plain text through, HTML-escaped", () => {
    expect(renderAnsiToHtml("a <b> & c")).toBe("a &lt;b&gt; &amp; c");
  });

  it("wraps SGR-colored runs in spans with class", () => {
    const html = renderAnsiToHtml("\x1b[31mred\x1b[0m plain");
    expect(html).toBe(
      '<span class="ansi-fg-red">red</span> plain',
    );
  });

  it("combines fg, bg, and attribute classes", () => {
    const html = renderAnsiToHtml("\x1b[1;31;42mhot\x1b[0m");
    expect(html).toBe(
      '<span class="ansi-fg-red ansi-bg-green ansi-bold">hot</span>',
    );
  });

  it("emits bright color class for 90-series", () => {
    const html = renderAnsiToHtml("\x1b[92mok\x1b[0m");
    expect(html).toBe('<span class="ansi-fg-bright-green">ok</span>');
  });

  it("resets individual attributes", () => {
    const html = renderAnsiToHtml("\x1b[1mB\x1b[22m\x1b[31mR\x1b[0m");
    expect(html).toBe(
      '<span class="ansi-bold">B</span><span class="ansi-fg-red">R</span>',
    );
  });

  it("strips non-SGR CSI sequences (cursor moves, clears)", () => {
    const html = renderAnsiToHtml("a\x1b[2Kb\x1b[3;4Hc");
    expect(html).toBe("abc");
  });

  it("strips OSC sequences terminated by BEL", () => {
    const html = renderAnsiToHtml("before\x1b]0;title\x07after");
    expect(html).toBe("beforeafter");
  });

  it("strips OSC sequences terminated by ST (ESC backslash)", () => {
    const html = renderAnsiToHtml("pre\x1b]0;title\x1b\\post");
    expect(html).toBe("prepost");
  });

  it("advances past 256-color parameters without coloring", () => {
    // `38;5;202` then bold — bold should still take effect, color falls back.
    const html = renderAnsiToHtml("\x1b[38;5;202;1mX\x1b[0m");
    expect(html).toBe('<span class="ansi-bold">X</span>');
  });

  it("advances past truecolor parameters without coloring", () => {
    const html = renderAnsiToHtml("\x1b[38;2;10;20;30;4mU\x1b[0m");
    expect(html).toBe('<span class="ansi-underline">U</span>');
  });

  it("treats reset parameter as a full clear", () => {
    const html = renderAnsiToHtml("\x1b[1;31mA\x1b[mB");
    expect(html).toBe('<span class="ansi-fg-red ansi-bold">A</span>B');
  });

  it("swaps fg/bg for inverse (reverse video)", () => {
    const html = renderAnsiToHtml("\x1b[7;31mi\x1b[0m");
    // inverse + red fg -> red becomes bg slot
    expect(html).toBe('<span class="ansi-bg-red">i</span>');
  });

  it("escapes HTML characters inside styled runs", () => {
    const html = renderAnsiToHtml("\x1b[31m<b>&</b>\x1b[0m");
    expect(html).toBe(
      '<span class="ansi-fg-red">&lt;b&gt;&amp;&lt;/b&gt;</span>',
    );
  });

  it("handles unclosed runs at end of input", () => {
    const html = renderAnsiToHtml("\x1b[31mred-to-eof");
    expect(html).toBe('<span class="ansi-fg-red">red-to-eof</span>');
  });

  it("is a no-op for text without any escapes", () => {
    const plain = "line 1\nline 2\n";
    expect(renderAnsiToHtml(plain)).toBe("line 1\nline 2\n");
  });
});
