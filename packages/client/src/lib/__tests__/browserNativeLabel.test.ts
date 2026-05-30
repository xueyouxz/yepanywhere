import { describe, expect, it } from "vitest";
import {
  detectBrowserNativeLabel,
  formatBrowserNativeLabel,
} from "../speechProviders/browserNativeLabel";

describe("detectBrowserNativeLabel", () => {
  it("identifies Chrome on desktop", () => {
    const label = detectBrowserNativeLabel(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    expect(label.browser).toBe("Chrome");
    expect(label.recognizerGuess).toBe("Google STT");
    expect(label.likelySupported).toBe(true);
  });

  it("identifies Edge before falling through to Chrome", () => {
    const label = detectBrowserNativeLabel(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    );
    expect(label.browser).toBe("Edge");
    expect(label.recognizerGuess).toBe("Microsoft / Bing");
  });

  it("identifies Samsung Internet before falling through to Chrome", () => {
    const label = detectBrowserNativeLabel(
      "Mozilla/5.0 (Linux; Android 14; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
    );
    expect(label.browser).toBe("Samsung Internet");
    expect(label.recognizerGuess).toBe("Samsung");
  });

  it("identifies Safari (and not as Chrome)", () => {
    const label = detectBrowserNativeLabel(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    );
    expect(label.browser).toBe("Safari");
    expect(label.recognizerGuess).toBe("Apple");
  });

  it("flags Firefox as unsupported", () => {
    const label = detectBrowserNativeLabel(
      "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
    );
    expect(label.browser).toBe("Firefox");
    expect(label.likelySupported).toBe(false);
  });

  it("returns empty browser for unknown UA", () => {
    const label = detectBrowserNativeLabel("SomeRandomUserAgent/1.0");
    expect(label.browser).toBe("");
    expect(label.likelySupported).toBe(false);
  });

  it("returns empty browser when UA is empty string", () => {
    const label = detectBrowserNativeLabel("");
    expect(label.browser).toBe("");
    expect(label.likelySupported).toBe(false);
  });
});

describe("formatBrowserNativeLabel", () => {
  it("formats supported browser with recognizer guess and trailing ?", () => {
    expect(
      formatBrowserNativeLabel({
        prefix: "Browser",
        browser: "Chrome",
        recognizerGuess: "Google STT",
        likelySupported: true,
      }),
    ).toBe("Browser (Chrome → Google STT?)");
  });

  it("formats Firefox as unsupported", () => {
    expect(
      formatBrowserNativeLabel({
        prefix: "Browser",
        browser: "Firefox",
        recognizerGuess: "",
        likelySupported: false,
      }),
    ).toBe("Browser (Firefox → unsupported)");
  });

  it("falls back to bare prefix when browser is unknown", () => {
    expect(
      formatBrowserNativeLabel({
        prefix: "Browser",
        browser: "",
        recognizerGuess: "",
        likelySupported: false,
      }),
    ).toBe("Browser");
  });
});
