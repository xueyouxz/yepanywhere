import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../i18n";
import { grepRenderer } from "../GrepRenderer";

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
});
