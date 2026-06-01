// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { isPublicShareLocalAppHref } from "../PublicSharePage";

describe("isPublicShareLocalAppHref", () => {
  const shareUrl = "https://ya.graehl.org/share/secret";

  it("blocks authenticated local file routes inside public shares", () => {
    expect(
      isPublicShareLocalAppHref(
        "/projects/project-1/file?path=README.md",
        shareUrl,
      ),
    ).toBe(true);
    expect(
      isPublicShareLocalAppHref(
        "/api/local-file?path=%2Frepo%2FREADME.md",
        shareUrl,
      ),
    ).toBe(true);
    expect(
      isPublicShareLocalAppHref(
        "/api/local-image?path=%2Frepo%2Fplot.png",
        shareUrl,
      ),
    ).toBe(true);
  });

  it("leaves external and public share links alone", () => {
    expect(
      isPublicShareLocalAppHref("https://example.com/README.md", shareUrl),
    ).toBe(false);
    expect(isPublicShareLocalAppHref("/share/other", shareUrl)).toBe(false);
  });
});
