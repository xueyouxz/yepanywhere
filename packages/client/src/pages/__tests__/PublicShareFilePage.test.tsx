// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type FileContentResponse, toUrlProjectId } from "@yep-anywhere/shared";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setInlineMediaExpandedPreference } from "../../hooks/useInlineMedia";
import { I18nProvider } from "../../i18n";
import {
  fetchPublicShareBlobViaRelay,
  fetchPublicShareJsonViaRelay,
} from "../../lib/publicShareRelay";
import { PublicShareFilePage } from "../PublicShareFilePage";

vi.mock("../../lib/publicShareRelay", () => ({
  fetchPublicShareBlobViaRelay: vi.fn(),
  fetchPublicShareJsonViaRelay: vi.fn(),
}));

const fetchPublicShareJsonViaRelayMock = vi.mocked(
  fetchPublicShareJsonViaRelay,
);
const fetchPublicShareBlobViaRelayMock = vi.mocked(
  fetchPublicShareBlobViaRelay,
);

function installObjectUrlMock() {
  const URLCtor = URL;
  class MockURL extends URLCtor {}
  Object.defineProperty(MockURL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:embedded-media"),
  });
  Object.defineProperty(MockURL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal("URL", MockURL);
}

describe("PublicShareFilePage", () => {
  beforeEach(() => {
    setInlineMediaExpandedPreference(false);
    installObjectUrlMock();
  });

  afterEach(() => {
    cleanup();
    setInlineMediaExpandedPreference(false);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the shared file viewer and embedded Markdown media", async () => {
    const projectRoot = "/local/graehl/yepanywhere";
    const projectId = toUrlProjectId(projectRoot);
    const imagePath = `${projectRoot}/docs/diagram.png`;
    const imageMedia = {
      data: btoa("png"),
      mimeType: "image/png",
    };
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "docs/guide.md",
        size: 47,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: "# Guide\n\n![diagram](./diagram.png)\n",
      renderedMarkdownHtml: `<h1>Guide</h1><span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="${imagePath}" data-media-type="image" data-expanded="true" aria-label="Collapse image" aria-expanded="true" title="Collapse inline preview">-</button><a href="/api/local-image?path=${encodeURIComponent(imagePath)}" class="local-media-link" data-media-type="image">diagram<span class="local-media-type">(image)</span></a></span><span class="local-media-inline-preview" data-media-path="${imagePath}" data-media-type="image" data-expanded="true"></span>`,
      embeddedMedia: {
        [imagePath]: imageMedia,
        "docs/diagram.png": imageMedia,
      },
    };
    fetchPublicShareJsonViaRelayMock.mockResolvedValue(fileResponse);

    const params = new URLSearchParams({
      h: "ygraehl",
      path: "docs/guide.md",
      projectId,
      r: "wss://relay.graehl.org/ws",
    });

    render(
      <I18nProvider>
        <MemoryRouter initialEntries={[`/share/share-secret/file?${params}`]}>
          <Routes>
            <Route
              path="/share/:secret/file"
              element={<PublicShareFilePage />}
            />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Guide" })).toBeTruthy();
    expect(screen.queryByAltText("diagram.png")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Expand image" }));

    const inlineImage = await screen.findByAltText("diagram.png");
    expect(inlineImage.getAttribute("src")).toBe("blob:embedded-media");

    const mediaLink = screen.getByRole("link", { name: /diagram/i });
    expect(mediaLink.getAttribute("href")).toContain(
      "/share/share-secret/file",
    );
    expect(fetchPublicShareBlobViaRelayMock).not.toHaveBeenCalled();
  });
});
