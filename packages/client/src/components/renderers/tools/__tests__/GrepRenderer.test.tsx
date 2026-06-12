import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../../../i18n";
import { UI_KEYS } from "../../../../lib/storageKeys";
import { grepRenderer, truncateGrepPatternForWidth } from "../GrepRenderer";

vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
  }),
}));

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

describe("GrepRenderer", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("opens parsed content matches as a highlighted table", () => {
    render(
      <I18nProvider>
        {grepRenderer.renderToolResult(
          {
            mode: "content",
            filenames: [],
            numFiles: 2,
            content:
              "src/a.ts:12:const needle = true;\nsrc/b.ts:7:3:another needle",
            matches: [
              {
                filePath: "src/a.ts",
                lineNumber: 12,
                text: "const needle = true;",
                ranges: [{ start: 6, end: 12 }],
              },
              {
                columnNumber: 3,
                filePath: "src/b.ts",
                lineNumber: 7,
                text: "another needle",
              },
            ],
          },
          false,
          renderContext,
          { pattern: "needle", output_mode: "content" },
        )}
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "2 matches" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("7:3")).toBeTruthy();
    expect(screen.getAllByText("needle")).toHaveLength(2);
    expect(document.querySelectorAll(".grep-match-highlight")).toHaveLength(2);
  });

  it("does not cap the parsed match table at 100 rows", () => {
    const matches = Array.from({ length: 125 }, (_, index) => ({
      filePath: "src/results.ts",
      lineNumber: index + 1,
      text: `needle-${index + 1}`,
    }));
    render(
      <I18nProvider>
        {grepRenderer.renderToolResult(
          {
            mode: "content",
            filenames: [],
            numFiles: 1,
            content: matches
              .map(
                (match) =>
                  `${match.filePath}:${match.lineNumber}:${match.text}`,
              )
              .join("\n"),
            matches,
          },
          false,
          renderContext,
          { pattern: "needle", output_mode: "content" },
        )}
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "125 matches" }));

    expect(
      screen.getByText(
        (_content, element) =>
          element?.classList.contains("grep-match-text") === true &&
          element.textContent === "needle-125",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/Showing first/)).toBeNull();
  });

  it("omits the repeated file column for single-file match tables", () => {
    render(
      <I18nProvider>
        {grepRenderer.renderToolResult(
          {
            mode: "content",
            filenames: [],
            numFiles: 1,
            content: "src/a.ts:12:needle one\nsrc/a.ts:13:needle two",
            matches: [
              {
                filePath: "src/a.ts",
                lineNumber: 12,
                text: "needle one",
              },
              {
                filePath: "src/a.ts",
                lineNumber: 13,
                text: "needle two",
              },
            ],
          },
          false,
          renderContext,
          { pattern: "needle", output_mode: "content", path: "src/a.ts" },
        )}
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "2 matches" }));

    expect(screen.queryByRole("columnheader", { name: "File" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Line" })).toBeDefined();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.classList.contains("grep-match-text") === true &&
          element.textContent === "needle two",
      ),
    ).toBeDefined();
  });

  it("uses the tool preview line setting for collapsed Grep matches", () => {
    window.localStorage.setItem(UI_KEYS.outputToolPreviewLineCount, "2");
    const { container } = render(
      <div>
        {grepRenderer.renderCollapsedPreview?.(
          { pattern: "needle", output_mode: "content", path: "src/a.ts" },
          {
            mode: "content",
            filenames: [],
            numFiles: 1,
            content: "src/a.ts:1:needle one\nsrc/a.ts:2:needle two",
            matches: [
              {
                filePath: "src/a.ts",
                lineNumber: 1,
                text: "needle one",
              },
              {
                filePath: "src/a.ts",
                lineNumber: 2,
                text: "needle two",
              },
            ],
          },
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("needle")).toBeDefined();
    expect(screen.getByText("one")).toBeDefined();
    expect(screen.queryByText("two")).toBeNull();
    expect(screen.getByText("+1 match")).toBeDefined();
    expect(container.querySelector(".grep-preview-file")).toBeNull();
  });

  it("keeps long patterns clipped until summary context expands them", () => {
    const longPattern =
      "Ran codex update\\. It completed cleanly and kept the existing session ready for follow-up work\\.";
    const result = {
      mode: "content" as const,
      filenames: [],
      numFiles: 1,
      content: "log.txt:3:Ran codex update. It completed cleanly",
      matches: [
        {
          filePath: "log.txt",
          lineNumber: 3,
          text: "Ran codex update. It completed cleanly",
        },
      ],
    };

    const { container, rerender } = render(
      <div>
        {grepRenderer.renderInteractiveSummary?.(
          { pattern: longPattern, output_mode: "content" },
          result,
          false,
          {
            ...renderContext,
            summaryExpanded: false,
            toggleSummaryExpanded: vi.fn(),
          },
        )}
      </div>,
    );

    expect(container.querySelector(".grep-summary-pattern-full")).toBeNull();
    expect(
      container.querySelector(".grep-summary-pattern-clip")?.textContent,
    ).toBe(longPattern);
    expect(screen.getByRole("button", { name: "1 match" })).toBeDefined();

    rerender(
      <div>
        {grepRenderer.renderInteractiveSummary?.(
          { pattern: longPattern, output_mode: "content" },
          result,
          false,
          {
            ...renderContext,
            summaryExpanded: true,
            toggleSummaryExpanded: vi.fn(),
          },
        )}
      </div>,
    );

    expect(
      container.querySelector(".grep-summary-pattern-full")?.textContent,
    ).toBe(longPattern);
  });

  it("truncates grep patterns by measured width with ASCII ellipsis", () => {
    const measureText = (text: string) => text.length;

    expect(truncateGrepPatternForWidth("abcdef", 6, measureText)).toBe(
      "abcdef",
    );
    expect(truncateGrepPatternForWidth("abcdef", 5, measureText)).toBe("ab...");
    expect(truncateGrepPatternForWidth("abcdef", 2, measureText)).toBe("");
  });

  it("measures the live summary width before preserving the searched path", async () => {
    const originalGetBoundingClientRect =
      HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getRect() {
      const classList = this.classList;
      if (classList.contains("grep-summary-pattern-row")) {
        return rect({ width: 180 });
      }
      if (classList.contains("grep-summary-scope")) {
        return rect({ width: 96 });
      }
      if (classList.contains("grep-summary-pattern-measure")) {
        return rect({ width: (this.textContent ?? "").length * 8 });
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      const longPattern =
        "targetIdentifierWithEnoughCharactersToForceMeasuredTruncation";
      render(
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="/repo"
          sessionId="session-1"
        >
          <I18nProvider>
            {grepRenderer.renderInteractiveSummary?.(
              {
                output_mode: "content",
                path: "/repo/packages/client/src/target-file.ts",
                pattern: longPattern,
              },
              {
                mode: "content",
                filenames: [],
                numFiles: 1,
                content: "target-file.ts:3:targetIdentifier",
                matches: [
                  {
                    filePath: "packages/client/src/target-file.ts",
                    lineNumber: 3,
                    text: "targetIdentifier",
                  },
                ],
              },
              false,
              {
                ...renderContext,
                summaryExpanded: false,
                toggleSummaryExpanded: vi.fn(),
              },
            )}
          </I18nProvider>
        </SessionMetadataProvider>,
      );

      const patternButton = screen.getByRole("button", {
        name: "Show full grep pattern",
      });
      await waitFor(() => {
        expect(patternButton.textContent).toMatch(/\.\.\.$/);
      });

      expect(patternButton.textContent).not.toContain("target-file.ts");
      expect(
        screen.getByRole("link", { name: "target-file.ts" }),
      ).toBeDefined();
      expect(screen.getByRole("button", { name: "1 match" })).toBeDefined();
    } finally {
      HTMLElement.prototype.getBoundingClientRect =
        originalGetBoundingClientRect;
    }
  });

  it("compacts Windows project paths in summaries and result lists", () => {
    const projectPath = "C:\\Users\\user\\Documents\\code\\playbox";
    const projectId = toUrlProjectId(projectPath);

    render(
      <SessionMetadataProvider
        projectId={projectId}
        projectPath={projectPath}
        sessionId="session-1"
      >
        <I18nProvider>
          {grepRenderer.renderInteractiveSummary?.(
            {
              output_mode: "content",
              path: `${projectPath}\\src\\renderer\\Tool.tsx`,
              pattern: "needle",
            },
            {
              mode: "content",
              filenames: [],
              numFiles: 2,
              content:
                `${projectPath}\\src\\a.ts:3:needle one\n` +
                `${projectPath}\\src\\b.ts:7:needle two`,
              matches: [
                {
                  filePath: `${projectPath}\\src\\a.ts`,
                  lineNumber: 3,
                  text: "needle one",
                },
                {
                  filePath: `${projectPath}\\src\\b.ts`,
                  lineNumber: 7,
                  text: "needle two",
                },
              ],
            },
            false,
            {
              ...renderContext,
              projectPath,
              summaryExpanded: true,
              toggleSummaryExpanded: vi.fn(),
            },
          )}
          {grepRenderer.renderToolResult(
            {
              mode: "files_with_matches",
              filenames: [
                `${projectPath}\\src\\a.ts`,
                `${projectPath}\\src\\nested\\b.ts`,
              ],
              numFiles: 2,
            },
            false,
            { ...renderContext, projectPath },
            { pattern: "needle", path: `${projectPath}\\src` },
          )}
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    expect(screen.getByRole("link", { name: "Tool.tsx" })).toBeDefined();
    expect(screen.getByText("needle in src/renderer/Tool.tsx")).toBeDefined();
    expect(screen.getByText("src/a.ts")).toBeDefined();
    expect(screen.getByText("src/nested/b.ts")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "2 matches" }));

    expect(screen.getAllByText("src/a.ts").length).toBeGreaterThan(0);
    expect(screen.getByText("src/b.ts")).toBeDefined();
    expect(screen.queryByText(/C:\\Users\\user/)).toBeNull();
  });
});

function rect({ width }: { width: number }): DOMRect {
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}
