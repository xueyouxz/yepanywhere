import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../../../i18n";
import { editRenderer } from "../EditRenderer";

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
if (!editRenderer.renderCollapsedPreview) {
  throw new Error("Edit renderer must provide collapsed preview");
}
const renderCollapsedPreview = editRenderer.renderCollapsedPreview;

describe("EditRenderer collapsed preview fallback", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders raw patch text for completed rows when structured patch is missing", () => {
    const input = {
      _rawPatch: [
        "*** Begin Patch",
        "*** Update File: src/example.ts",
        "@@",
        "-const x = 1;",
        "+const x = 2;",
        "*** End Patch",
      ].join("\n"),
    };

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(screen.getByText(/\*\*\* Begin Patch/)).toBeDefined();
  });

  it("keeps pending classic Edit rows on Computing diff...", () => {
    const input = {
      file_path: "src/example.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    };

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("Computing diff...")).toBeDefined();
  });

  it("keeps structured diff rendering unchanged when structured patch exists", () => {
    const input = {
      _structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-const x = 1;", "+const x = 2;"],
        },
      ],
    };

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(screen.getByText("-const x = 1;")).toBeDefined();
    expect(screen.getByText("+const x = 2;")).toBeDefined();
  });

  it("renders completed markdown table edits through the render toggle", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          " | name | value |",
          " | --- | --- |",
          "-| old | $x^2$ |",
          "+| new | $y^2$ |",
        ],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "notes.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("old")).toBeDefined();
    expect(screen.getByText("new")).toBeDefined();
    expect(container.querySelector(".katex")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show source" }));

    expect(container.textContent).toContain("-| old | $x^2$ |");
  });

  it("renders markdown headings and inline markup in completed edits", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: ["-old text", "+## Findings", "+- **win** in `dev`"],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "notes.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("Findings")).toBeDefined();
    expect(container.querySelector(".fixed-font-markdown-heading")).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("win");
    expect(container.querySelector("code")?.textContent).toBe("dev");
    const gutters = Array.from(
      container.querySelectorAll(".fixed-font-diff-gutter"),
    ).map((node) => node.textContent);
    expect(gutters).toContain("+");
    expect(gutters).toContain("-");
  });

  it("renders headerless markdown table edit hunks", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [
          "@@ -1,2 +1,3 @@",
          "-| `POL-E2P-Q35-BASE` | `en->pl` | Qwen3.5-4B base | 200 | 3.1581 | 290.64 tok/s / 7,598 tok |",
          "-| `POL-E2P-TG4B-BASE` | `en->pl` | TranslateGemma-4B base | 200 | **2.7577** | 235.79 tok/s / 7,726 tok |",
          "+| `POL-E2P-EURO-BASE` | `en->pl` | EuroLLM-9B base | 200 | **2.5526** | 98.89 tok/s / 6,527 tok |",
          "+| `POL-E2P-Q35-BASE` | `en->pl` | Qwen3.5-4B base | 200 | 3.1581 | 290.64 tok/s / 7,598 tok |",
          "+| `POL-E2P-TG4B-BASE` | `en->pl` | TranslateGemma-4B base | 200 | 2.7577 | 235.79 tok/s / 7,726 tok |",
        ],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "research/conditioned-diversity.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("POL-E2P-EURO-BASE")).toBeDefined();
    expect(
      Array.from(container.querySelectorAll("strong")).map(
        (node) => node.textContent,
      ),
    ).toContain("2.5526");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(5);
  });

  it("resolves markdown links in edit table cells relative to the edited file", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 3,
        lines: [
          "+| Ref | Artifacts |",
          "+| --- | --- |",
          "+| `PILOT` | [decode](../untracked/pilot.meta.md) |",
        ],
      },
    ];

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "research/conditioned-diversity.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </SessionMetadataProvider>,
    );

    const link = screen.getByRole("link", { name: "decode" });
    expect(link.getAttribute("data-fixed-font-file-path")).toBe(
      "untracked/pilot.meta.md",
    );
  });

  it("renders server-provided highlighted diff HTML when available", () => {
    const input = {
      _structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-const x = 1;", "+const x = 2;"],
        },
      ],
      _diffHtml:
        '<pre class="shiki"><code class="language-ts"><span class="line line-deleted"><span class="diff-prefix">-</span><span style="color:var(--shiki-token-keyword)">const</span> x = 1;</span>\n<span class="line line-inserted"><span class="diff-prefix">+</span><span style="color:var(--shiki-token-keyword)">const</span> x = 2;</span></code></pre>',
    };

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          input as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(
      container.querySelector(".highlighted-diff .line-inserted"),
    ).toBeTruthy();
    expect(screen.getAllByText(/const/)).toHaveLength(2);
  });

  it("renders stable fallback text when completed row has no patch data", () => {
    const input = {};

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(screen.getByText("Patch preview unavailable")).toBeDefined();
  });

  it("derives filename from raw patch when file_path is missing", () => {
    const summary = editRenderer.getUseSummary?.({
      _rawPatch: [
        "*** Begin Patch",
        "*** Update File: packages/client/src/components/Foo.tsx",
        "@@",
        "-const x = 1;",
        "+const x = 2;",
        "*** End Patch",
      ].join("\n"),
    } as never);

    expect(summary).toBe("Foo.tsx");
  });

  it("summarizes multi-file raw Codex patches without implying the previous read", () => {
    const summary = editRenderer.getUseSummary?.([
      "*** Begin Patch",
      "*** Update File: RegressionTests/AwesomeAlign/regtest-awesome-chi.yml",
      "@@",
      "+# checked chi",
      "*** Update File: RegressionTests/AwesomeAlign/regtest-xmt-awesomealign.yml",
      "@@",
      "+# checked align",
      "*** End Patch",
    ].join("\n") as never);

    expect(summary).toBe("regtest-awesome-chi.yml +1 files");
  });

  it("summarizes Codex fileChange inputs from changed paths", () => {
    const summary = editRenderer.getUseSummary?.({
      changes: [
        {
          path: "/repo/src/a.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-a\n+b\n",
        },
        {
          path: "/repo/src/b.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-c\n+d\n",
        },
      ],
    } as never);

    expect(summary).toBe("a.ts +1 files");
  });

  it("keeps completed apply_patch summaries specific before rich hydration", () => {
    const summary = editRenderer.getResultSummary?.(
      { ok: true } as never,
      false,
      [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "+const a = 1;",
        "*** Update File: src/b.ts",
        "@@",
        "+const b = 1;",
        "*** End Patch",
      ].join("\n") as never,
    );

    expect(summary).toBe("a.ts +1 files");
  });

  it("shows raw patch filename in interactive summary when file_path is missing", () => {
    if (!editRenderer.renderInteractiveSummary) {
      throw new Error("Edit renderer must provide interactive summary");
    }

    render(
      <div>
        {editRenderer.renderInteractiveSummary(
          {
            _rawPatch: [
              "*** Begin Patch",
              "*** Update File: packages/client/src/components/Foo.tsx",
              "@@",
              "-const x = 1;",
              "+const x = 2;",
              "*** End Patch",
            ].join("\n"),
            _structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const x = 1;", "+const x = 2;"],
              },
            ],
          } as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByRole("button", { name: /Foo\.tsx/i })).toBeDefined();
  });

  it("puts all multi-file patch targets in the interactive summary title", () => {
    if (!editRenderer.renderInteractiveSummary) {
      throw new Error("Edit renderer must provide interactive summary");
    }

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        {editRenderer.renderInteractiveSummary(
          {
            _rawPatch: [
              "*** Begin Patch",
              "*** Update File: /repo/src/a.ts",
              "@@",
              "+const a = 1;",
              "*** Update File: /repo/src/b.ts",
              "@@",
              "+const b = 1;",
              "*** End Patch",
            ].join("\n"),
            _structuredPatch: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                lines: ["+const a = 1;"],
              },
            ],
          } as never,
          undefined,
          false,
          renderContext,
        )}
      </SessionMetadataProvider>,
    );

    const button = screen.getByRole("button", { name: /a\.ts \+1 files/i });
    expect(button.getAttribute("title")).toBe("src/a.ts\nsrc/b.ts");
  });

  it("keeps pending multi-file edit summaries title-backed and clickable", () => {
    if (!editRenderer.renderInteractiveSummary) {
      throw new Error("Edit renderer must provide interactive summary");
    }

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          {editRenderer.renderInteractiveSummary(
            {
              _rawPatch: [
                "*** Begin Patch",
                "*** Update File: /repo/src/a.ts",
                "@@",
                "+const a = 1;",
                "*** Update File: /repo/src/b.ts",
                "@@",
                "+const b = 1;",
                "*** End Patch",
              ].join("\n"),
            } as never,
            undefined,
            false,
            renderContext,
          )}
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    const button = screen.getByRole("button", { name: /a\.ts \+1 files/i });
    expect(button.getAttribute("title")).toBe("src/a.ts\nsrc/b.ts");

    fireEvent.click(button);

    expect(screen.getAllByTitle("src/a.ts").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("src/b.ts").length).toBeGreaterThan(0);
  });

  it("renders Codex Add File patches as created file content", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: [
          "+# Recent MT Adapter Progress",
          "+",
          "+- **win** in `dev`",
        ],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _rawPatch: [
              "*** Begin Patch",
              "*** Add File: /repo/research/progress-2026-05-18.md",
              "+# Recent MT Adapter Progress",
              "+",
              "+- **win** in `dev`",
              "*** End Patch",
            ].join("\n"),
            _structuredPatch: structuredPatch,
          } as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText(/\*\*\* Begin Patch/)).toBeNull();
    expect(screen.getByText("Recent MT Adapter Progress")).toBeDefined();
    expect(container.querySelector(".fixed-font-markdown-heading")).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("win");
    expect(container.querySelector("code")?.textContent).toBe("dev");
  });

  it("copies only post-change diff text from the copy button", () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [" context", "-old", "+new", "+tail"],
      },
    ];

    render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "notes.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy post-change text" }));

    expect(writeText).toHaveBeenCalledWith("context\nnew\ntail");
  });

  it("opens full add-file modal with a fresh render toggle", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 13,
        lines: [
          "+# Recent MT Adapter Progress",
          "+",
          "+- **win** in `dev`",
          "+- line 4",
          "+- line 5",
          "+- line 6",
          "+- line 7",
          "+- line 8",
          "+- line 9",
          "+- line 10",
          "+- line 11",
          "+- line 12",
          "+- line 13",
        ],
      },
    ];

    const { container } = render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          {renderCollapsedPreview(
            {
              _structuredPatch: structuredPatch,
            } as never,
            {
              filePath: "research/progress-2026-05-18.md",
              structuredPatch,
            } as never,
            false,
            renderContext,
          )}
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));

    const modal = document.body.querySelector(".modal");
    expect(modal?.textContent).toContain("Recent MT Adapter Progress");
    const titleLink = modal?.querySelector(
      ".modal-title a.file-path-link",
    ) as HTMLAnchorElement | null;
    expect(titleLink?.textContent).toContain("progress-2026-05-18.md");
    expect(titleLink?.getAttribute("href")).toBe(
      "/projects/project-1/file?path=research%2Fprogress-2026-05-18.md&line=1&lineEnd=13",
    );
    const pathLink = screen.getByRole("link", {
      name: /research\/progress-2026-05-18\.md\s*:1-13/,
    });
    expect(pathLink.getAttribute("href")).toBe(
      "/projects/project-1/file?path=research%2Fprogress-2026-05-18.md&line=1&lineEnd=13",
    );
    const modalToggle = modal?.querySelector(
      ".fixed-font-render-toggle__button",
    );
    expect(modalToggle).toBeTruthy();

    fireEvent.click(modalToggle as Element);
    expect(container.textContent).toContain("Recent MT Adapter Progress");
  });
});
