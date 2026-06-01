import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import type { Message } from "../../../types";
import type { RenderItem, ToolCallItem } from "../../../types/renderItems";
import {
  ExploredToolGroup,
  buildAssistantRenderSegments,
} from "../ExploredToolGroup";

vi.mock("../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
  }),
}));

const projectRoot = "/local/graehl/yepanywhere";
const projectId = toUrlProjectId(projectRoot);

function sourceMessage(id: string, timestamp: string): Message {
  return {
    type: "assistant",
    uuid: id,
    timestamp,
    message: { role: "assistant", content: "" },
  };
}

function toolCall(
  id: string,
  toolName: string,
  toolInput: unknown,
  timestamp = "2026-05-28T00:00:00.000Z",
  toolResult?: ToolCallItem["toolResult"],
): ToolCallItem {
  return {
    type: "tool_call",
    id,
    toolName,
    toolInput,
    toolResult,
    status: toolResult ? "complete" : "pending",
    sourceMessages: [sourceMessage(`msg-${id}`, timestamp)],
  };
}

describe("ExploredToolGroup", () => {
  afterEach(() => {
    cleanup();
  });

  it("groups adjacent read/search/list calls but not distant ones", () => {
    const read = toolCall("read-1", "Read", { file_path: "README.md" });
    const grep = toolCall("grep-1", "Grep", { pattern: "needle" });
    const text: RenderItem = {
      type: "text",
      id: "text-1",
      text: "done",
      sourceMessages: [sourceMessage("msg-text", "2026-05-28T00:00:02.000Z")],
    };
    const oldGlob = toolCall(
      "glob-1",
      "Glob",
      { pattern: "*.ts" },
      "2026-05-28T00:10:00.000Z",
    );
    const lateLs = toolCall(
      "ls-1",
      "LS",
      { path: "packages/client" },
      "2026-05-28T00:20:30.000Z",
    );

    const segments = buildAssistantRenderSegments([
      read,
      grep,
      text,
      oldGlob,
      lateLs,
    ]);

    expect(segments.map((segment) => segment.kind)).toEqual([
      "explored",
      "item",
      "item",
      "item",
    ]);
    expect(segments[0]?.kind === "explored" && segments[0].items).toEqual([
      read,
      grep,
    ]);
  });

  it("renders compact labels and keeps read summaries clickable", () => {
    const read = toolCall(
      "read-1",
      "Read",
      { file_path: "topics/rich-text-rendering.md" },
      "2026-05-28T00:00:00.000Z",
      {
        content: "file contents",
        isError: false,
        structured: {
          type: "text",
          file: {
            filePath: "topics/rich-text-rendering.md",
            content: "line\n".repeat(141),
            numLines: 141,
            startLine: 1,
            totalLines: 141,
          },
        },
      },
    );
    const search = toolCall("grep-1", "Search", {
      query: "tool|bash",
      path: "packages/client/src",
    });
    const list = toolCall("ls-1", "list_dir", {
      target_directory: "packages/client/src",
    });

    render(
      <SessionMetadataProvider
        projectId={projectId}
        projectPath={projectRoot}
        sessionId="session-1"
      >
        <ExploredToolGroup id="explored-test" items={[read, search, list]} />
      </SessionMetadataProvider>,
    );

    expect(screen.getByText("Explored")).toBeDefined();
    expect(screen.getByText("Read")).toBeDefined();
    expect(screen.getByText("Search")).toBeDefined();
    expect(screen.getByText("List")).toBeDefined();
    const readLink = screen.getByRole("link", {
      name: /rich-text-rendering\.md/i,
    });
    expect(readLink.getAttribute("href")).toBe(
      `/projects/${projectId}/file?path=topics%2Frich-text-rendering.md`,
    );
    expect(screen.getByText("tool|bash in packages/client/src")).toBeDefined();
    expect(screen.getByText("packages/client/src")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Collapse explored tools" }));

    expect(screen.queryByText("Search")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand explored tools" }),
    ).toBeDefined();
  });
});
