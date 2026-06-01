// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { rewritePublicShareLocalAppHref } from "../../contexts/PublicShareContext";
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

describe("rewritePublicShareLocalAppHref", () => {
  const projectId = toUrlProjectId("/local/graehl/yepanywhere");
  const context = {
    projectId,
    relayUrl: "wss://relay.graehl.org/ws",
    relayUsername: "ygraehl",
    secret: "share-secret",
  };
  const shareUrl = "https://ya.graehl.org/share/share-secret?h=ygraehl";

  it("rewrites project file viewer links to public share file routes", () => {
    const rewritten = rewritePublicShareLocalAppHref(
      `/projects/${projectId}/file?path=ui-report%2FREADME.md&line=8`,
      context,
      shareUrl,
    );

    expect(rewritten).toBe(
      `/share/share-secret/file?path=ui-report%2FREADME.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${projectId}&line=8`,
    );
  });

  it("rewrites local-file links under the shared project root", () => {
    const rewritten = rewritePublicShareLocalAppHref(
      "https://ya.graehl.org/api/local-file?path=%2Flocal%2Fgraehl%2Fyepanywhere%2Fui-report%2FREADME.md&render=1&line=8",
      context,
      shareUrl,
    );

    expect(rewritten).toBe(
      `/share/share-secret/file?path=ui-report%2FREADME.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${projectId}&line=8`,
    );
  });
});
