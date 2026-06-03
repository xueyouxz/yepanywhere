import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../i18n";
import { setInlineImagesPreference } from "../../../../hooks/useInlineImages";
import { readRenderer } from "../ReadRenderer";

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

describe("ReadRenderer", () => {
  afterEach(() => {
    cleanup();
    setInlineImagesPreference(true);
  });

  it("keeps normal text reads clickable", () => {
    render(
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

    expect(
      screen.getByRole("button", { name: /useGlobalSessions\.ts/i }),
    ).toBeDefined();
    expect(screen.getByRole("button").textContent).toContain(
      "useGlobalSessions.ts 1 lines",
    );
  });

  it("does not offer an empty modal for PTY handoff reads", () => {
    render(
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
    expect(screen.getByText(/useGlobalSessions\.ts/)).toBeDefined();
    expect(screen.getByText(/continues in Shell/)).toBeDefined();
  });

  it("renders PTY handoff result without a clickable file button", () => {
    render(
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
    expect(screen.getByText(/continues in Shell/)).toBeDefined();
  });

  it("replaces inline image results with a modal opener when disabled", () => {
    setInlineImagesPreference(false);

    render(
      <I18nProvider>
        {readRenderer.renderToolResult(
          {
            type: "image",
            file: {
              base64: "AAAA",
              type: "image/png",
              originalSize: 2048,
              dimensions: {
                originalWidth: 40,
                originalHeight: 20,
                displayWidth: 40,
                displayHeight: 20,
              },
            },
          } as never,
          false,
          renderContext,
        )}
      </I18nProvider>,
    );

    expect(screen.queryByRole("img")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /File content/i }));

    expect(screen.getByRole("img", { name: "File content" })).toBeDefined();
  });
});
