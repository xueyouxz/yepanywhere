// @vitest-environment jsdom

import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  buildPublicShareRawFileApiPath,
  rewritePublicShareLocalAppHref,
  rewritePublicShareLocalAppLinks,
} from "../../contexts/PublicShareContext";
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
      `/projects/${projectId}/file?path=ui-report%2FREADME.md&line=8&view=range`,
      context,
      shareUrl,
    );

    expect(rewritten).toBe(
      `/share/share-secret/file?path=ui-report%2FREADME.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${projectId}&line=8&view=range`,
    );
  });

  it("rewrites local-file links under the shared project root", () => {
    const rewritten = rewritePublicShareLocalAppHref(
      "https://ya.graehl.org/api/local-file?path=%2Flocal%2Fgraehl%2Fyepanywhere%2Fui-report%2FREADME.md&render=1&line=8&lineEnd=12",
      context,
      shareUrl,
    );

    expect(rewritten).toBe(
      `/share/share-secret/file?path=ui-report%2FREADME.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${projectId}&line=8&lineEnd=12`,
    );
  });

  it("rewrites Windows local-file links under the shared project root", () => {
    const windowsProjectRoot = "C:\\Users\\user\\Documents\\code\\playbox";
    const windowsProjectId = toUrlProjectId(windowsProjectRoot);
    const windowsContext = {
      ...context,
      projectId: windowsProjectId,
    };
    const rewritten = rewritePublicShareLocalAppHref(
      "https://ya.graehl.org/api/local-file?path=C%3A%5CUsers%5Cuser%5CDocuments%5Ccode%5Cplaybox%5Cdocs%5Cguide.md&render=1",
      windowsContext,
      shareUrl,
    );

    expect(rewritten).toBe(
      `/share/share-secret/file?path=docs%2Fguide.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${windowsProjectId}`,
    );
  });

  it("marks local image sources for public share media hydration", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<img src="/api/local-image?path=%2Flocal%2Fgraehl%2Fyepanywhere%2Fui-report%2Fplot.png">';

    rewritePublicShareLocalAppLinks(root, context, shareUrl);

    expect(
      root.querySelector("img")?.getAttribute("data-public-share-src-path"),
    ).toBe("ui-report/plot.png");
  });

  it("builds share-scoped raw file API paths", () => {
    expect(
      buildPublicShareRawFileApiPath(
        context,
        "/local/graehl/yepanywhere/ui-report/plot.png",
      ),
    ).toBe(
      "/public-api/shares/share-secret/files/raw?path=ui-report%2Fplot.png",
    );
  });
});
