import { cleanup, render, screen } from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicShareProvider } from "../../../../contexts/PublicShareContext";
import { SessionMetadataProvider } from "../../../../contexts/SessionMetadataContext";
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

    expect(screen.getByRole("link").getAttribute("href")).toBe(
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

  it("does not offer an empty modal for PTY handoff reads", () => {
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
    expect(
      screen.getByRole("link", { name: /useGlobalSessions\.ts/i }),
    ).toBeDefined();
    expect(screen.getByText(/continues in Shell/)).toBeDefined();
  });

  it("renders PTY handoff result without a file button", () => {
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
    expect(
      screen.getByRole("link", { name: /useGlobalSessions\.ts/i }),
    ).toBeDefined();
    expect(screen.getByText(/continues in Shell/)).toBeDefined();
  });
});
