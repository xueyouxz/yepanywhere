import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RenderModeProvider,
  useOptionalRenderModeContext,
} from "../../../contexts/RenderModeContext";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { setInlineMediaExpandedPreference } from "../../../hooks/useInlineMedia";
import { I18nProvider } from "../../../i18n";
import { type Connection, setGlobalConnection } from "../../../lib/connection";
import { TextBlock } from "../TextBlock";

function GlobalRenderModeButton() {
  const renderMode = useOptionalRenderModeContext();
  return (
    <button type="button" onClick={renderMode?.toggleGlobalMode}>
      global render mode
    </button>
  );
}

const apiMocks = vi.hoisted(() => ({
  getFile: vi.fn(),
  getFileRawUrl: vi.fn(),
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
    setInlineMediaExpandedPreference(false);
    apiMocks.getFile.mockReset();
    apiMocks.getFileRawUrl.mockReset();
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

  it("keeps assistant markdown rendered when global render mode changes", () => {
    const { container } = render(
      <RenderModeProvider>
        <GlobalRenderModeButton />
        <TextBlock
          text="- **win**"
          augmentHtml="<ul><li><strong>win</strong></li></ul>"
        />
      </RenderModeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "global render mode" }));

    expect(container.querySelector("strong")?.textContent).toBe("win");
    expect(container.querySelector(".text-block-source")).toBeNull();
  });

  it("mounts local media previews inline beside rendered markdown links", async () => {
    setInlineMediaExpandedPreference(true);
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

  it("keeps local media previews collapsed by default until expanded", async () => {
    setInlineMediaExpandedPreference(false);
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

    expect(toggle?.hidden).toBe(false);
    expect(toggle?.textContent).toBe("+");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(preview?.hidden).toBe(false);
    expect(preview?.getAttribute("data-expanded")).toBe("false");
    expect(
      container.querySelector(".local-media-inline-image-button"),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(toggle as HTMLButtonElement);

    expect(toggle?.textContent).toBe("-");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByAltText("trajectory.png")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: /trajectory/i }),
    );

    expect(clickAllowed).toBe(false);
    expect(screen.getByRole("dialog").textContent).toContain("trajectory.png");
    expect(
      await screen.findByRole("img", { name: "trajectory.png" }),
    ).toBeTruthy();
  });

  it("keeps inline videos collapsed by default until expanded", async () => {
    setInlineMediaExpandedPreference(false);
    const fetchMock = vi.fn(
      async () => new Response(new Blob(["mp4"], { type: "video/mp4" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:video-preview"),
      revokeObjectURL: vi.fn(),
    });

    const { container } = render(
      <I18nProvider>
        <TextBlock
          text="[demo](/tmp/demo.mp4)"
          augmentHtml={
            '<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="/tmp/demo.mp4" data-media-type="video" data-expanded="true" aria-label="Collapse video" aria-expanded="true" title="Collapse inline preview">-</button><a href="/api/local-image?path=%2Ftmp%2Fdemo.mp4" class="local-media-link" data-ya-resource="local-media" data-ya-path="/tmp/demo.mp4" data-ya-media-type="video" data-media-type="video">demo<span class="local-media-type">(video)</span></a></span><span class="local-media-inline-preview" data-media-path="/tmp/demo.mp4" data-media-type="video" data-expanded="true"></span>'
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

    expect(toggle?.textContent).toBe("+");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(preview?.getAttribute("data-expanded")).toBe("false");
    expect(container.querySelector(".local-media-inline-player")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(toggle as HTMLButtonElement);

    expect(toggle?.textContent).toBe("-");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => {
      expect(
        container.querySelector(".local-media-inline-player"),
      ).toBeTruthy();
    });
    expect(
      container
        .querySelector(".local-media-inline-player")
        ?.getAttribute("src"),
    ).toBe("blob:video-preview");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: /demo/i }),
    );

    expect(clickAllowed).toBe(false);
    expect(screen.getByRole("dialog").textContent).toContain("demo.mp4");
    await waitFor(() => {
      expect(
        screen.getByRole("dialog").querySelector(".local-media-player"),
      ).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      undefined,
      undefined,
      "full",
    );
    expect(await screen.findByText("Project doc")).toBeTruthy();
  });

  it("normalizes browser-style Windows drive local-file links under the active project", async () => {
    apiMocks.getFile.mockResolvedValueOnce({
      content: "# Queue doc\n\nRendered through FileViewer.",
      metadata: {
        isText: true,
        mimeType: "text/markdown",
        path: "topics/message-control-steer-queue-btw-later-interrupt.md",
        size: 39,
      },
      rawUrl:
        "/api/projects/project-1/files/raw?path=topics%2Fmessage-control-steer-queue-btw-later-interrupt.md",
      renderedMarkdownHtml: "<h1>Queue doc</h1>",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="C:/Users/user/Documents/code/yepanywhere"
          sessionId="session-1"
        >
          <TextBlock
            text="[queue doc](/C:/Users/user/Documents/code/yepanywhere/topics/message-control-steer-queue-btw-later-interrupt.md)"
            augmentHtml={
              '<p><a href="/api/local-file?path=%2FC%3A%2FUsers%2Fuser%2FDocuments%2Fcode%2Fyepanywhere%2Ftopics%2Fmessage-control-steer-queue-btw-later-interrupt.md&amp;render=1&amp;line=38" data-ya-resource="local-file" data-ya-path="/C:/Users/user/Documents/code/yepanywhere/topics/message-control-steer-queue-btw-later-interrupt.md" data-ya-render-markdown="true" data-ya-line="38">queue doc</a></p>'
            }
          />
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "queue doc" }),
    );

    expect(clickAllowed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiMocks.getFile).toHaveBeenCalledWith(
      "project-1",
      "topics/message-control-steer-queue-btw-later-interrupt.md",
      true,
      38,
      undefined,
      "full",
    );
    expect(await screen.findByText(/Queue doc/)).toBeTruthy();
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
