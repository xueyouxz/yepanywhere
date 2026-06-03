import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { setStableToolPreviewRenderingPreference } from "../../../hooks/useStableToolPreviewRendering";
import { I18nProvider } from "../../../i18n";
import { UI_KEYS } from "../../../lib/storageKeys";
import {
  DEFERRED_PREVIEW_HEIGHT,
  estimateDeferredPreviewHeightPx,
  ToolCallRow,
} from "../ToolCallRow";

vi.mock("../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
  }),
}));

describe("ToolCallRow", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "IntersectionObserver");
    setStableToolPreviewRenderingPreference(true);
    window.localStorage.removeItem(UI_KEYS.stableToolPreviewRendering);
  });

  it("keeps pending Codex command rows collapsed without output preview cards", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-1"
        toolName="Bash"
        toolInput={{ command: "npm run test:e2e:pipeline-v2" }}
        status="pending"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("Ran")).toBeDefined();
    expect(screen.getByText("npm run test:e2e:pipeline-v2")).toBeDefined();
    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();
    expect(container.querySelector(".tool-use-expanded")).toBeNull();
  });

  it("shows pending Edit targets as title-backed clickable summaries", () => {
    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          <ToolCallRow
            id="tool-pending-edit"
            toolName="apply_patch"
            toolInput={[
              "*** Begin Patch",
              "*** Update File: /repo/src/a.ts",
              "@@",
              "+const a = 1;",
              "*** Update File: /repo/src/b.ts",
              "@@",
              "+const b = 1;",
              "*** End Patch",
            ].join("\n")}
            status="pending"
            sessionProvider="codex"
          />
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    const button = screen.getByRole("button", { name: /a\.ts \+1 files/i });
    expect(button.getAttribute("title")).toBe("src/a.ts\nsrc/b.ts");

    fireEvent.click(button);

    expect(screen.getAllByTitle("src/a.ts").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("src/b.ts").length).toBeGreaterThan(0);
  });

  it("shows completed Codex Bash markdown output as a renderable preview", () => {
    const output = [
      "diff --git a/notes.md b/notes.md",
      "@@ -1,2 +1,2 @@",
      "-## Old",
      "+## New",
      "+- **done** in `dev`",
    ].join("\n");

    const { container } = render(
      <ToolCallRow
        id="tool-markdown-bash"
        toolName="Bash"
        toolInput={{ command: "git diff -- notes.md" }}
        toolResult={{
          structured: {
            stdout: output,
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: output,
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("Ran")).toBeDefined();
    expect(
      container.querySelector(".tool-row-collapsed-preview"),
    ).not.toBeNull();
    expect(screen.getByText("New")).toBeDefined();
    expect(
      container.querySelector(".fixed-font-markdown-heading"),
    ).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("done");
    expect(
      container.querySelector(".fixed-font-rendered__content code")
        ?.textContent,
    ).toBe("dev");
    expect(container.querySelector(".expand-chevron")).toBeNull();
    expect(screen.getAllByText("git diff -- notes.md")).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse preview from left gutter" }),
    );

    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand preview" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Expand preview" }));

    expect(
      container.querySelector(".tool-row-collapsed-preview"),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Collapse preview" }));

    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();
    expect(screen.getByText("git diff -- notes.md")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Expand preview" }),
    ).toBeDefined();
  });

  it("does not make empty completed Bash rows expandable", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-empty-bash"
        toolName="Bash"
        toolInput={{ command: "true" }}
        toolResult={{
          structured: {
            stdout: "",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: "",
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("Ran")).toBeDefined();
    expect(screen.getByText("true")).toBeDefined();
    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();
    expect(container.querySelector(".expand-chevron")).toBeNull();
    expect(screen.queryByRole("button", { name: /expand/i })).toBeNull();
  });

  it("expands Bash command text without toggling row details", () => {
    const command = `printf '${"x".repeat(180)}'`;
    const { container } = render(
      <ToolCallRow
        id="tool-long-bash"
        toolName="Bash"
        toolInput={{ command }}
        toolResult={{
          structured: {
            stdout: "",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: "",
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    const commandButton = screen.getByRole("button", {
      name: "Show full command",
    });
    expect(commandButton.textContent).toBe(command);

    fireEvent.click(commandButton);

    expect(commandButton.className).toContain("is-expanded");
    expect(container.querySelector(".tool-row-content")).toBeNull();
    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();
  });

  it("shows hidden multiline Bash command content before expansion", () => {
    const command = ["printf first", "printf second", "printf third"].join(
      "\n",
    );
    render(
      <ToolCallRow
        id="tool-multiline-bash"
        toolName="Bash"
        toolInput={{ command }}
        toolResult={{
          structured: {
            stdout: "",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: "",
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    const commandButton = screen.getByRole("button", {
      name: "Show full command",
    });
    expect(commandButton.textContent).toContain("printf first");
    expect(commandButton.textContent).toContain("printf second");
    expect(commandButton.textContent).toContain("+1 line");
    expect(commandButton.textContent).not.toContain("printf third");

    fireEvent.click(commandButton);

    expect(commandButton.textContent).toContain("printf third");
    expect(commandButton.textContent).not.toContain("+1 line");
  });

  it("uses the timeline dot to expand long Grep summaries", () => {
    const pattern =
      "Ran codex update\\. It completed cleanly and kept the existing session ready for follow-up work\\.";
    const { container } = render(
      <ToolCallRow
        id="tool-grep"
        toolName="Grep"
        toolInput={{ pattern, output_mode: "content" }}
        toolResult={{
          structured: {
            mode: "content",
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
          },
          content: "",
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(container.querySelector(".grep-summary-pattern-full")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand summary" }));

    expect(
      container.querySelector(".grep-summary-pattern-full")?.textContent,
    ).toBe(pattern);
    expect(
      screen.getByRole("button", { name: "Collapse summary" }),
    ).toBeDefined();
  });

  it("shows PTY-backed read shell rows inline without requiring expansion", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-pty-read"
        toolName="WriteStdin"
        toolInput={{
          session_id: 37863,
          chars: "",
          linked_tool_name: "Read",
          linked_file_path: "packages/client/src/hooks/useGlobalSessions.ts",
        }}
        toolResult={{
          content:
            "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 0\nOutput:\nline 1\nline 2\n",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(screen.getByText("Shell")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /useGlobalSessions\.ts/i }),
    ).toBeDefined();
    expect(screen.getByText(/2 lines/)).toBeDefined();
    expect(container.querySelector(".expand-chevron")).toBeNull();
  });

  it("keeps generic shell rows expandable when no inline PTY summary applies", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-pty-generic"
        toolName="WriteStdin"
        toolInput={{ session_id: 37863, chars: "" }}
        toolResult={{
          content:
            "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 0\nOutput:\nline 1\nline 2\n",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".expand-chevron")).not.toBeNull();
  });

  it("collapses generic expanded tool rows from the left strip", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-glob"
        toolName="Glob"
        toolInput={{ pattern: "**/*.ts" }}
        toolResult={{
          structured: {
            filenames: ["src/file.ts"],
            numFiles: 1,
            durationMs: 12,
            truncated: false,
          },
          content: "src/file.ts",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".glob-result")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));

    expect(container.querySelector(".glob-result")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse expanded tool row" }),
    );

    expect(container.querySelector(".glob-result")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand" })).toBeDefined();
  });

  it("collapses expanded Read rows from the left strip", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-read"
        toolName="Read"
        toolInput={{ file_path: "packages/client/src/file.ts" }}
        toolResult={{
          structured: {
            type: "text",
            file: {
              filePath: "packages/client/src/file.ts",
              content: "line 1\nline 2\nline 3\n",
              numLines: 3,
              startLine: 1,
              totalLines: 3,
            },
          },
          content: "line 1\nline 2\nline 3\n",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".read-text-inline")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand inline view" }));

    expect(container.querySelector(".read-text-inline")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse expanded tool row" }),
    );

    expect(container.querySelector(".read-text-inline")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand inline view" }),
    ).toBeDefined();
  });

  it("expands completed Edit rows inline from the timeline dot", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-edit"
        toolName="Edit"
        toolInput={{
          file_path: "packages/client/src/file.ts",
          old_string: "const value = 1;",
          new_string: "const value = 2;",
        }}
        toolResult={{
          structured: {
            filePath: "packages/client/src/file.ts",
            oldString: "const value = 1;",
            newString: "const value = 2;",
            originalFile: "const value = 1;\n",
            replaceAll: false,
            userModified: false,
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const value = 1;", "+const value = 2;"],
              },
            ],
          },
          content: "const value = 2;",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".edit-collapsed-preview")).not.toBeNull();
    expect(container.querySelector(".edit-result")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand inline view" }));

    expect(container.querySelector(".edit-collapsed-preview")).toBeNull();
    expect(container.querySelector(".edit-result")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse expanded tool row" }),
    );

    expect(container.querySelector(".edit-collapsed-preview")).not.toBeNull();
    expect(container.querySelector(".edit-result")).toBeNull();
  });

  it("focuses the tool row top when expanding long inline content", () => {
    let scrollTop = 40;
    const { container } = render(
      <div data-testid="scroll-container" style={{ overflowY: "auto" }}>
        <ToolCallRow
          id="tool-read-scroll"
          toolName="Read"
          toolInput={{ file_path: "packages/client/src/file.ts" }}
          toolResult={{
            structured: {
              type: "text",
              file: {
                filePath: "packages/client/src/file.ts",
                content: "line\n".repeat(80),
                numLines: 80,
                startLine: 1,
                totalLines: 80,
              },
            },
            content: "line\n".repeat(80),
            isError: false,
          }}
          status="complete"
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("scroll-container");
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Number(value);
      },
    });
    scrollContainer.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 300,
        left: 0,
        right: 300,
        width: 300,
        height: 200,
        x: 0,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;
    const row = container.querySelector<HTMLElement>(".tool-row");
    expect(row).not.toBeNull();
    if (row) {
      row.getBoundingClientRect = () =>
        ({
          top: 220,
          bottom: 260,
          left: 0,
          right: 300,
          width: 300,
          height: 40,
          x: 0,
          y: 220,
          toJSON: () => ({}),
        }) as DOMRect;
    }

    fireEvent.click(screen.getByRole("button", { name: "Expand inline view" }));

    expect(scrollTop).toBe(148);
  });

  it("reserves a bounded deferred preview shell before near-viewport hydration", () => {
    class DeferredIntersectionObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: DeferredIntersectionObserver,
    });
    setStableToolPreviewRenderingPreference(false);

    const { container } = render(
      <ToolCallRow
        id="tool-deferred-bash"
        toolName="Bash"
        toolInput={{ command: "pnpm test -- --runInBand" }}
        toolResult={{
          structured: {
            stdout: ["# Result", "- **line one**", "- line two"].join("\n"),
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: ["# Result", "- **line one**", "- line two"].join("\n"),
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    const shell = container.querySelector<HTMLElement>(
      ".tool-row-deferred-preview",
    );
    expect(shell).not.toBeNull();
    expect(container.querySelector(".bash-collapsed-preview")).toBeNull();
    expect(
      shell?.style.getPropertyValue("--tool-row-deferred-preview-height"),
    ).toMatch(/px$/);
  });

  it("renders completed Edit previews immediately by default", () => {
    class DeferredIntersectionObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: DeferredIntersectionObserver,
    });

    const { container } = render(
      <ToolCallRow
        id="tool-default-stable-edit"
        toolName="Edit"
        toolInput={{
          file_path: "packages/client/src/file.ts",
          old_string: "const value = 1;",
          new_string: "const value = 2;",
        }}
        toolResult={{
          structured: {
            filePath: "packages/client/src/file.ts",
            oldString: "const value = 1;",
            newString: "const value = 2;",
            originalFile: "const value = 1;\n",
            replaceAll: false,
            userModified: false,
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const value = 1;", "+const value = 2;"],
              },
            ],
          },
          content: "const value = 2;",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".tool-row-deferred-preview")).toBeNull();
    expect(container.querySelector(".edit-collapsed-preview")).not.toBeNull();
  });

  it("defers completed Edit previews when stable preview rendering is disabled", () => {
    class DeferredIntersectionObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: DeferredIntersectionObserver,
    });
    setStableToolPreviewRenderingPreference(false);

    const { container } = render(
      <ToolCallRow
        id="tool-deferred-edit"
        toolName="Edit"
        toolInput={{
          file_path: "packages/client/src/file.ts",
          old_string: "const value = 1;",
          new_string: "const value = 2;",
        }}
        toolResult={{
          structured: {
            filePath: "packages/client/src/file.ts",
            oldString: "const value = 1;",
            newString: "const value = 2;",
            originalFile: "const value = 1;\n",
            replaceAll: false,
            userModified: false,
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const value = 1;", "+const value = 2;"],
              },
            ],
          },
          content: "const value = 2;",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".edit-collapsed-preview")).toBeNull();
    expect(container.querySelector(".tool-row-deferred-preview")).toBeNull();
  });

  it("estimates deferred Bash preview height from text, width, and max preview cap", () => {
    const short = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "echo ok" },
      result: { stdout: "ok", stderr: "" },
      status: "complete",
      rowWidthPx: 900,
    });
    expect(short).toBe(
      DEFERRED_PREVIEW_HEIGHT.minOutputRowPx +
        DEFERRED_PREVIEW_HEIGHT.previewBorderPx,
    );

    const longLine = "x".repeat(180);
    const wide = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "printf long" },
      result: { stdout: longLine, stderr: "" },
      status: "complete",
      rowWidthPx: 1000,
    });
    const narrow = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "printf long" },
      result: { stdout: longLine, stderr: "" },
      status: "complete",
      rowWidthPx: 240,
    });

    expect(wide).not.toBeNull();
    expect(narrow).not.toBeNull();
    expect(narrow as number).toBeGreaterThan(wide as number);
    expect(narrow as number).toBeLessThanOrEqual(DEFERRED_PREVIEW_HEIGHT.maxPx);

    const huge = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "cat big.log" },
      result: { stdout: `${"line\n".repeat(100)}`, stderr: "" },
      status: "complete",
      rowWidthPx: 900,
    });
    expect(huge).toBe(
      DEFERRED_PREVIEW_HEIGHT.outputRowChromePx +
        DEFERRED_PREVIEW_HEIGHT.maxOutputPx +
        DEFERRED_PREVIEW_HEIGHT.previewBorderPx,
    );
  });

  it("scales deferred Bash preview height with output typography metrics", () => {
    const output = "x".repeat(260);
    const compact = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "printf long" },
      result: { stdout: output, stderr: "" },
      status: "complete",
      rowWidthPx: 360,
      typography: {
        averageCharWidthPx: 5.5,
        outputLineHeightPx: 14,
        outputRowChromePx: 6,
      },
    });
    const roomy = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "printf long" },
      result: { stdout: output, stderr: "" },
      status: "complete",
      rowWidthPx: 360,
      typography: {
        averageCharWidthPx: 9,
        outputLineHeightPx: 24,
        outputRowChromePx: 18,
      },
    });

    expect(compact).not.toBeNull();
    expect(roomy).not.toBeNull();
    expect(roomy as number).toBeGreaterThan(compact as number);
  });

  it("does not reserve estimated preview height for rows without a cheap model", () => {
    expect(
      estimateDeferredPreviewHeightPx({
        toolName: "Read",
        toolInput: { file_path: "README.md" },
        result: { content: "body" },
        status: "complete",
        rowWidthPx: 900,
      }),
    ).toBeNull();
  });
});
