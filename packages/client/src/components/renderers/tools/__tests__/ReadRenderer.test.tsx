import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicShareProvider } from "../../../../contexts/PublicShareContext";
import { SessionMetadataProvider } from "../../../../contexts/SessionMetadataContext";
import { setInlineMediaExpandedPreference } from "../../../../hooks/useInlineMedia";
import { readRenderer } from "../ReadRenderer";
import type { ReadResult } from "../types";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const imageResult = {
  type: "image" as const,
  file: {
    base64: PNG_BASE64,
    type: "image/png",
    originalSize: 158 * 1024,
    dimensions: {
      originalWidth: 1024,
      originalHeight: 952,
      displayWidth: 512,
      displayHeight: 476,
    },
  },
};

vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
    ignoreToolErrors: vi.fn(),
    clearIgnoredTools: vi.fn(),
    ignoredTools: [],
  }),
}));

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

if (!readRenderer.renderInteractiveSummary) {
  throw new Error("Read renderer must provide interactive summary");
}

const projectRoot = "/local/graehl/yepanywhere";
const projectId = toUrlProjectId(projectRoot);

function renderInSession(children: ReactNode) {
  return render(
    <SessionMetadataProvider
      projectId={projectId}
      projectPath={projectRoot}
      sessionId="session-1"
    >
      {children}
    </SessionMetadataProvider>,
  );
}

describe("ReadRenderer", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps normal text reads as native file links", () => {
    renderInSession(
      <div>
        {readRenderer.renderInteractiveSummary?.(
          { file_path: "packages/client/src/hooks/useGlobalSessions.ts" },
          {
            type: "text",
            file: {
              filePath: "packages/client/src/hooks/useGlobalSessions.ts",
              content: 'import { useCallback } from "react";\n',
              numLines: 1,
              startLine: 1,
              totalLines: 1,
            },
          },
          false,
          renderContext,
        )}
      </div>,
    );

    const link = screen.getByRole("link", { name: /useGlobalSessions\.ts/i });
    expect(link.getAttribute("href")).toBe(
      `/projects/${projectId}/file?path=packages%2Fclient%2Fsrc%2Fhooks%2FuseGlobalSessions.ts`,
    );
    expect(link.parentElement?.textContent).toContain(
      "useGlobalSessions.ts 1 lines",
    );
  });

  it("links partial read summaries and their line counts to the read range", () => {
    renderInSession(
      <div>
        {readRenderer.renderInteractiveSummary?.(
          {
            file_path: "packages/client/src/lib/connection/SecureConnection.ts",
          },
          {
            type: "text",
            file: {
              filePath:
                "packages/client/src/lib/connection/SecureConnection.ts",
              content: "line\n".repeat(81),
              numLines: 81,
              startLine: 510,
              totalLines: 900,
            },
          },
          false,
          renderContext,
        )}
      </div>,
    );

    const expectedHref = `/projects/${projectId}/file?path=packages%2Fclient%2Fsrc%2Flib%2Fconnection%2FSecureConnection.ts&line=510&lineEnd=590`;
    const expectedRangeHref = `${expectedHref}&view=range`;
    expect(
      screen
        .getByRole("link", { name: /SecureConnection\.ts\s*:510-590/i })
        .getAttribute("href"),
    ).toBe(expectedHref);
    expect(
      screen.getByRole("link", { name: "81 lines" }).getAttribute("href"),
    ).toBe(expectedRangeHref);
  });

  it("renders public share Read summaries as share file links", () => {
    render(
      <PublicShareProvider
        value={{
          projectId,
          relayUrl: "wss://relay.graehl.org/ws",
          relayUsername: "ygraehl",
          secret: "share-secret",
        }}
      >
        <SessionMetadataProvider
          projectId={projectId}
          projectPath={projectRoot}
          sessionId="session-1"
        >
          {readRenderer.renderInteractiveSummary?.(
            { file_path: "ui-report/README.md" },
            {
              type: "text",
              file: {
                filePath: "ui-report/README.md",
                content: "# Report\n",
                numLines: 1,
                startLine: 1,
                totalLines: 1,
              },
            },
            false,
            renderContext,
          )}
        </SessionMetadataProvider>
      </PublicShareProvider>,
    );

    expect(
      screen
        .getByRole("link", { name: /ui-report\/README\.md/i })
        .getAttribute("href"),
    ).toBe(
      `/share/share-secret/file?path=ui-report%2FREADME.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${projectId}`,
    );
  });

  it("renders expanded text reads with a native file link", () => {
    renderInSession(
      <div>
        {readRenderer.renderToolResult(
          {
            type: "text",
            file: {
              filePath: "packages/client/src/hooks/useGlobalSessions.ts",
              content: 'import { useCallback } from "react";\n',
              numLines: 1,
              startLine: 1,
              totalLines: 1,
            },
          },
          false,
          renderContext,
        )}
      </div>,
    );

    expect(
      screen.getByRole("link", { name: /useGlobalSessions\.ts/i }),
    ).toBeDefined();
  });

  it("does not markdown-render backticks in non-Markdown reads", () => {
    const { container } = renderInSession(
      <div>
        {readRenderer.renderToolResult(
          {
            type: "text",
            file: {
              filePath: "packages/client/src/components/Widget.tsx",
              content: "const label = `dev`;\n",
              numLines: 1,
              startLine: 1,
              totalLines: 1,
            },
          },
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("const label = `dev`;")).toBeDefined();
    expect(
      container.querySelector(".fixed-font-rendered__content code"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Show source" })).toBeNull();
  });

  it("renders zero-line PTY-backed reads without fake continuation text", () => {
    renderInSession(
      <div>
        {readRenderer.renderInteractiveSummary?.(
          { file_path: "packages/client/src/hooks/useGlobalSessions.ts" },
          {
            type: "text",
            file: {
              filePath: "packages/client/src/hooks/useGlobalSessions.ts",
              content: "",
              numLines: 0,
              startLine: 1,
              totalLines: 260,
            },
            session_id: 37863,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(
      screen.queryByRole("button", { name: /useGlobalSessions\.ts/i }),
    ).toBeNull();
    const link = screen.getByRole("link", { name: /useGlobalSessions\.ts/i });
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).not.toContain("line=1");
    expect(link.textContent).not.toContain(":1");
    expect(screen.getByText("0 lines")).toBeDefined();
    expect(screen.queryByText(/continues in Shell/)).toBeNull();
  });

  it("renders zero-line PTY-backed read results without a phantom first line", () => {
    renderInSession(
      <div>
        {readRenderer.renderToolResult(
          {
            type: "text",
            file: {
              filePath: "packages/client/src/hooks/useGlobalSessions.ts",
              content: "",
              numLines: 0,
              startLine: 1,
              totalLines: 260,
            },
            session_id: 37863,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(
      screen.queryByRole("button", { name: /useGlobalSessions\.ts/i }),
    ).toBeNull();
    const link = screen.getByRole("link", { name: /useGlobalSessions\.ts/i });
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).not.toContain("line=1");
    expect(link.textContent).not.toContain(":1");
    expect(screen.getByText("0 lines")).toBeDefined();
    expect(screen.getByText("No content read")).toBeDefined();
    expect(screen.queryByText(/continues in Shell/)).toBeNull();
  });

  describe("image reads", () => {
    afterEach(() => {
      // Unmount first so resetting the store doesn't re-render a mounted tree
      // outside act(), then reset to the default (collapsed) for the next test.
      cleanup();
      setInlineMediaExpandedPreference(false);
    });

    it("keeps the image collapsed when Expand Inline Media is off", () => {
      setInlineMediaExpandedPreference(false);
      const { container } = renderInSession(
        <div>
          {readRenderer.renderToolResult(imageResult, false, renderContext, {
            file_path: "/tmp/screenshot.png",
          })}
        </div>,
      );

      expect(container.querySelector("img.read-image")).toBeNull();
      expect(
        screen.getByRole("button", { name: /expand image/i }),
      ).toBeDefined();
    });

    it("expands the image inline when the setting is on", () => {
      setInlineMediaExpandedPreference(true);
      const { container } = renderInSession(
        <div>
          {readRenderer.renderToolResult(imageResult, false, renderContext, {
            file_path: "/tmp/screenshot.png",
          })}
        </div>,
      );

      expect(container.querySelector("img.read-image")).not.toBeNull();
      expect(
        screen.getByRole("button", { name: /collapse image/i }),
      ).toBeDefined();
    });

    it("lets the user expand a collapsed image on demand", () => {
      setInlineMediaExpandedPreference(false);
      const { container } = renderInSession(
        <div>
          {readRenderer.renderToolResult(imageResult, false, renderContext, {
            file_path: "/tmp/screenshot.png",
          })}
        </div>,
      );

      expect(container.querySelector("img.read-image")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /expand image/i }));
      expect(container.querySelector("img.read-image")).not.toBeNull();
    });
  });

  // Claude Code's read-dedup returns a non-error Read whose `file` has only
  // `filePath` — content/numLines are omitted because the file is unchanged
  // since the last Read. These results must not crash or print "undefined
  // lines"; they render a distinct "unchanged" state instead.
  describe("read-dedup (content-less file) results", () => {
    // Intentionally malformed vs. the ReadResult type: at runtime the validated
    // schema allows this (all TextFile fields are optional), which is the whole
    // point — the renderer must tolerate it.
    const dedupResult = {
      type: "text",
      file: { filePath: "CLAUDE.md" },
    } as unknown as ReadResult;

    it("renders the expanded result without crashing (markdown path)", () => {
      expect(() =>
        renderInSession(
          <div>
            {readRenderer.renderToolResult(dedupResult, false, renderContext, {
              file_path: "CLAUDE.md",
            })}
          </div>,
        ),
      ).not.toThrow();

      expect(document.body.textContent).not.toContain("undefined lines");
      expect(document.body.textContent).toContain("unchanged");
    });

    it("renders the interactive summary as unchanged, not 'undefined lines'", () => {
      renderInSession(
        <div>
          {readRenderer.renderInteractiveSummary?.(
            { file_path: "CLAUDE.md" },
            dedupResult,
            false,
            renderContext,
          )}
        </div>,
      );

      expect(document.body.textContent).not.toContain("undefined lines");
      expect(document.body.textContent).toContain("unchanged");
    });

    it("summarizes the collapsed row as 'unchanged'", () => {
      expect(
        readRenderer.getResultSummary?.(dedupResult, false, {
          file_path: "CLAUDE.md",
        }),
      ).toBe("unchanged");
    });
  });
});
