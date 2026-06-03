import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../../i18n";
import { setInlineImagesPreference } from "../../../hooks/useInlineImages";
import { type Connection, setGlobalConnection } from "../../../lib/connection";
import { TextBlock } from "../TextBlock";

const apiMocks = vi.hoisted(() => ({
  getFile: vi.fn(),
}));

vi.mock("../../../api/client", () => ({
  api: apiMocks,
}));

function mockRemoteConnection(
  fetchBlob = vi.fn(
    async () => new Blob(["remote file"], { type: "text/plain" }),
  ),
): Connection {
  return {
    mode: "secure",
    fetch: vi.fn(),
    fetchBlob,
  } as unknown as Connection;
}

describe("TextBlock", () => {
  afterEach(() => {
    cleanup();
    setGlobalConnection(null);
    setInlineImagesPreference(true);
    apiMocks.getFile.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defers local math rendering until streaming text completes", () => {
    const { container, rerender } = render(
      <TextBlock text="Streaming $x^2$ now" isStreaming={true} />,
    );

    expect(container.querySelector(".text-block-toggle")).toBeNull();
    expect(container.querySelector(".text-block-local-rendered")).toBeNull();
    expect(screen.getByText("Streaming $x^2$ now")).toBeDefined();

    rerender(<TextBlock text="Streaming $x^2$ now" isStreaming={false} />);

    expect(container.querySelector(".text-block-toggle")).toBeTruthy();
    expect(container.querySelector(".text-block-local-rendered")).toBeTruthy();
    expect(container.querySelector(".katex")).toBeTruthy();
  });

  it("does not show render toggle for server HTML that matches plain text", () => {
    const { container } = render(
      <TextBlock text="Plain answer." augmentHtml="<p>Plain answer.</p>" />,
    );

    expect(container.querySelector(".text-block-toggle")).toBeNull();
    expect(screen.getByText("Plain answer.")).toBeDefined();
  });

  it("shows render toggle for completed server markdown", () => {
    const { container } = render(
      <TextBlock
        text="- **win**"
        augmentHtml="<ul><li><strong>win</strong></li></ul>"
      />,
    );

    expect(container.querySelector(".text-block-toggle")).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("win");
  });

  it("mounts local media previews inline beside rendered markdown links", async () => {
    setInlineImagesPreference(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }))),
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    const { container } = render(
      <TextBlock
        text="[trajectory](/tmp/trajectory.png)"
        augmentHtml={
          '<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true" aria-label="Collapse image" aria-expanded="true" title="Collapse inline preview">-</button><a href="/api/local-image?path=%2Ftmp%2Ftrajectory.png" class="local-media-link" data-media-type="image">trajectory<span class="local-media-type">(image)</span></a></span><span class="local-media-inline-preview" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true"></span>'
        }
      />,
    );

    expect(container.querySelector(".local-media-link")).toBeTruthy();
    expect(await screen.findByAltText("trajectory.png")).toBeTruthy();
    expect(
      container.querySelector(".local-media-inline-image-button"),
    ).toBeTruthy();
  });

  it("keeps local media links modal-clickable when inline images are disabled", async () => {
    setInlineImagesPreference(false);
    const fetchMock = vi.fn(
      async () => new Response(new Blob(["png"], { type: "image/png" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    const { container } = render(
      <I18nProvider>
        <TextBlock
          text="[trajectory](/tmp/trajectory.png)"
          augmentHtml={
            '<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true" aria-label="Collapse image" aria-expanded="true" title="Collapse inline preview">-</button><a href="/api/local-image?path=%2Ftmp%2Ftrajectory.png" class="local-media-link" data-ya-resource="local-media" data-ya-path="/tmp/trajectory.png" data-ya-media-type="image" data-media-type="image">trajectory<span class="local-media-type">(image)</span></a></span><span class="local-media-inline-preview" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true"></span>'
          }
        />
      </I18nProvider>,
    );

    const toggle = container.querySelector(
      ".local-media-inline-toggle",
    ) as HTMLButtonElement | null;
    const preview = container.querySelector(
      ".local-media-inline-preview",
    ) as HTMLElement | null;

    expect(toggle?.hidden).toBe(true);
    expect(preview?.hidden).toBe(true);
    expect(
      container.querySelector(".local-media-inline-image-button"),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: /trajectory/i }),
    );

    expect(clickAllowed).toBe(false);
    expect(
      await screen.findByRole("img", { name: "trajectory.png" }),
    ).toBeTruthy();
  });

  it("opens semantic local media links through the existing modal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }))),
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    render(
      <I18nProvider>
        <TextBlock
          text="![trajectory](C:/tmp/trajectory.png)"
          augmentHtml={
            '<p><a href="/api/local-image?path=C%3A%2Ftmp%2Ftrajectory.png" data-ya-resource="local-media" data-ya-path="C:/tmp/trajectory.png" data-ya-media-type="image">trajectory</a></p>'
          }
        />
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "trajectory" }),
    );

    expect(clickAllowed).toBe(false);
    expect(screen.getByRole("dialog").textContent).toContain("trajectory.png");
    expect(
      await screen.findByRole("img", { name: "trajectory.png" }),
    ).toBeTruthy();
  });

  it("opens direct local-file links in a modal", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"ok": true}\n', {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <TextBlock
          text="[probe json](/tmp/probe.json)"
          augmentHtml={
            '<p><a href="/api/local-file?path=%2Ftmp%2Fprobe.json">probe json</a></p>'
          }
        />
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "probe json" }),
    );

    expect(clickAllowed).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-file?path=%2Ftmp%2Fprobe.json",
      { credentials: "include" },
    );
    expect(screen.getByRole("dialog").textContent).toContain("probe.json");
    expect(await screen.findByText(/"ok": true/)).toBeTruthy();
  });

  it("opens absolute local-file links under the active project in FileViewer", async () => {
    apiMocks.getFile.mockResolvedValueOnce({
      content: "# Project doc\n\nRendered through FileViewer.",
      metadata: {
        isText: true,
        mimeType: "text/markdown",
        path: "docs/status.md",
        size: 36,
      },
      rawUrl: "/api/projects/project-1/files/raw?path=docs%2Fstatus.md",
      renderedMarkdownHtml: "<h1>Project doc</h1>",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="/Users/kgraehl/code/yepanywhere"
          sessionId="session-1"
        >
          <TextBlock
            text="[status](/Users/kgraehl/code/yepanywhere/docs/status.md)"
            augmentHtml={
              '<p><a href="/api/local-file?path=%2FUsers%2Fkgraehl%2Fcode%2Fyepanywhere%2Fdocs%2Fstatus.md" data-ya-resource="local-file" data-ya-path="/Users/kgraehl/code/yepanywhere/docs/status.md" data-ya-render-markdown="true">status</a></p>'
            }
          />
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "status" }),
    );

    expect(clickAllowed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiMocks.getFile).toHaveBeenCalledWith(
      "project-1",
      "docs/status.md",
      true,
    );
    expect(await screen.findByText("Project doc")).toBeTruthy();
  });

  it("preserves direct browser gestures for local-file links", () => {
    render(
      <TextBlock
        text="[probe json](/tmp/probe.json)"
        augmentHtml={
          '<p><a href="/api/local-file?path=%2Ftmp%2Fprobe.json">probe json</a></p>'
        }
      />,
    );

    let defaultPreventedBeforeDocument = true;
    document.addEventListener(
      "click",
      (event) => {
        defaultPreventedBeforeDocument = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );

    fireEvent.click(screen.getByRole("link", { name: "probe json" }), {
      metaKey: true,
    });

    expect(defaultPreventedBeforeDocument).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens remote local-file links through the active connection", async () => {
    const fetchBlob = vi.fn(
      async () => new Blob(["remote file"], { type: "text/plain" }),
    );
    setGlobalConnection(mockRemoteConnection(fetchBlob));

    render(
      <I18nProvider>
        <TextBlock
          text="[probe json](C:/tmp/probe.json)"
          augmentHtml={
            '<p><a href="/api/local-file?path=C%3A%2Ftmp%2Fprobe.json">probe json</a></p>'
          }
        />
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "probe json" }),
    );

    expect(clickAllowed).toBe(false);
    expect(fetchBlob).toHaveBeenCalledWith(
      "/api/local-file?path=C%3A%2Ftmp%2Fprobe.json",
    );
    expect(await screen.findByText("remote file")).toBeTruthy();
  });

  it("shows remote local-file server rejections inside the modal", async () => {
    const fetchBlob = vi.fn(async () => {
      throw new Error("API error: 403: Path not in allowed directories");
    });
    setGlobalConnection(mockRemoteConnection(fetchBlob));

    render(
      <I18nProvider>
        <TextBlock
          text="[probe json](C:/tmp/probe.json)"
          augmentHtml={
            '<p><a href="/api/local-file?path=C%3A%2Ftmp%2Fprobe.json">probe json</a></p>'
          }
        />
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "probe json" }),
    );

    expect(clickAllowed).toBe(false);
    expect(
      await screen.findByText(/Path not in allowed directories/),
    ).toBeTruthy();
  });
});
