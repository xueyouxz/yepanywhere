import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { FileContentResponse } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { FileViewer, type FileViewerSource } from "../FileViewer";

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalGetBoundingClientRect =
  HTMLElement.prototype.getBoundingClientRect;
const originalClientHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight",
);
const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight",
);
const originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTop",
);

function restorePrototypeProperty(
  name: keyof HTMLElement,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(HTMLElement.prototype, name, descriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
}

describe("FileViewer", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: originalGetBoundingClientRect,
    });
    restorePrototypeProperty("clientHeight", originalClientHeightDescriptor);
    restorePrototypeProperty("scrollHeight", originalScrollHeightDescriptor);
    restorePrototypeProperty("scrollTop", originalScrollTopDescriptor);
  });

  it("marks and scrolls a line range 10% below the viewer top", async () => {
    let scrollTop = 0;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("file-viewer-body") ? 100 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("file-viewer-body") ? 1000 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("file-viewer-body") ? scrollTop : 0;
      },
      set(value) {
        if (this.classList.contains("file-viewer-body")) {
          scrollTop = Number(value);
        }
      },
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        const top = this.classList.contains("highlighted-line-start") ? 200 : 0;
        return {
          bottom: top,
          height: 0,
          left: 0,
          right: 0,
          toJSON: () => ({}),
          top,
          width: 0,
          x: 0,
          y: top,
        };
      },
    });
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "src/App.ts",
        size: 64,
        mimeType: "text/typescript",
        isText: true,
      },
      rawUrl: "",
      content: "one\ntwo\nthree\nfour\n",
      highlightedHtml:
        '<pre class="shiki"><code><span class="line">one</span>\n<span class="line">two</span>\n<span class="line">three</span>\n<span class="line">four</span></code></pre>',
      highlightedLanguage: "typescript",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="src/App.ts"
          lineNumber={2}
          lineEnd={3}
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".highlighted-line-start")).not.toBeNull();
    });

    expect(
      container
        .querySelector(".highlighted-line-start")
        ?.getAttribute("data-line"),
    ).toBe("2");
    expect(
      container
        .querySelector(".highlighted-line-end")
        ?.getAttribute("data-line"),
    ).toBe("3");
    const code = container.querySelector(".shiki-container code");
    expect(
      Array.from(code?.childNodes ?? []).some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent === "\n",
      ),
    ).toBe(false);
    expect(container.querySelector(".highlighted-line")).toBeNull();
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        container.querySelector<HTMLElement>(".file-viewer-body")?.scrollTop,
      ).toBe(190);
    });
  });

  it("paints a single highlighted line", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "src/App.ts",
        size: 64,
        mimeType: "text/typescript",
        isText: true,
      },
      rawUrl: "",
      content: "one\ntwo\nthree\n",
      contentStartLine: 40,
      highlightedHtml:
        '<pre class="shiki"><code><span class="line">one</span>\n<span class="line">two</span>\n<span class="line">three</span></code></pre>',
      highlightedLanguage: "typescript",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="src/App.ts"
          lineNumber={41}
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".highlighted-line")).not.toBeNull();
    });

    expect(
      container.querySelector(".highlighted-line")?.getAttribute("data-line"),
    ).toBe("41");
    expect(container.querySelector(".highlighted-line-start")).not.toBeNull();
    expect(container.querySelector(".highlighted-line-end")).not.toBeNull();
  });

  it("shows actual file line numbers in plain range windows", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "logs/session.txt",
        size: 64,
        mimeType: "text/plain",
        isText: true,
      },
      rawUrl: "",
      content: "alpha\nbeta\ngamma",
      contentStartLine: 40,
      contentEndLine: 42,
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="logs/session.txt"
          lineNumber={41}
          lineEnd={42}
          viewMode="range"
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".code-highlighter-plain")).not.toBeNull();
    });

    const gutter = Array.from(
      container.querySelectorAll(".code-line-numbers > div"),
    ).map((node) => node.textContent);
    expect(gutter).toEqual(["40", "41", "42"]);
    expect(
      container
        .querySelector(".highlighted-line-start")
        ?.getAttribute("data-line"),
    ).toBe("41");
    expect(
      container
        .querySelector(".highlighted-line-end")
        ?.getAttribute("data-line"),
    ).toBe("42");
  });

  it("keeps Markdown preview toggleable in range views", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "notes.md",
        size: 64,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: "# Title\n\nSelected text",
      contentStartLine: 10,
      contentEndLine: 12,
      highlightedHtml:
        '<pre class="shiki"><code><span class="line"># Title</span>\n<span class="line"></span>\n<span class="line">Selected text</span></code></pre>',
      renderedMarkdownHtml:
        '<div class="markdown-preview-line-boundary markdown-preview-line-boundary-start" data-line="10"></div><div class="markdown-preview-span markdown-preview-span-start" data-line-start="10" data-line-end="12"><h1>Title</h1><p>Selected text</p></div><div class="markdown-preview-line-boundary markdown-preview-line-boundary-end" data-line="12"></div>',
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="notes.md"
          lineNumber={10}
          lineEnd={12}
          viewMode="range"
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    });

    expect(container.querySelector(".shiki-container")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy();
    expect(
      container.querySelector(".markdown-preview-span-start"),
    ).toBeTruthy();
  });
});
