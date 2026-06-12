import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { globRenderer } from "../GlobRenderer";

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

describe("GlobRenderer", () => {
  it("compacts Windows project paths in use and result displays", () => {
    const projectPath = "C:\\Users\\user\\Documents\\code\\playbox";

    render(
      <div>
        {globRenderer.renderToolUse(
          {
            pattern: "**/*.ts",
            path: `${projectPath}\\packages\\client`,
          },
          { ...renderContext, projectPath },
        )}
        {globRenderer.renderToolResult(
          {
            durationMs: 12,
            filenames: [
              `${projectPath}\\packages\\client\\src\\App.tsx`,
              `${projectPath}\\packages\\client\\src\\lib\\text.ts`,
            ],
            numFiles: 2,
            truncated: false,
          },
          false,
          { ...renderContext, projectPath },
        )}
      </div>,
    );

    expect(screen.getByText("in packages/client")).toBeDefined();
    expect(screen.getByText("packages/client/src/App.tsx")).toBeDefined();
    expect(screen.getByText("packages/client/src/lib/text.ts")).toBeDefined();
    expect(screen.queryByText(/C:\\Users\\user/)).toBeNull();
  });
});
