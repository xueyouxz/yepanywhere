import { cleanup, render, screen } from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import { FilePathLink } from "../FilePathLink";

describe("FilePathLink", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a native link to the standalone file viewer", () => {
    render(
      <FilePathLink
        projectId="project-id"
        filePath="docs/guide.md"
        lineNumber={12}
        displayText="guide.md"
      />,
    );

    const link = screen.getByRole("link", { name: /guide\.md\s*:12/ });
    expect(link.getAttribute("href")).toBe(
      "/projects/project-id/file?path=docs%2Fguide.md&line=12",
    );
  });

  it("links absolute paths under the project as project-relative paths", () => {
    const projectId = toUrlProjectId("/local/graehl/yepanywhere");

    render(
      <FilePathLink
        projectId={projectId}
        filePath="/local/graehl/yepanywhere/ui-report/README.md"
        lineNumber={8}
        displayText="ui-report/README.md"
      />,
    );

    const link = screen.getByRole("link", {
      name: /ui-report\/README\.md\s*:8/,
    });
    expect(link.getAttribute("href")).toBe(
      `/projects/${projectId}/file?path=ui-report%2FREADME.md&line=8`,
    );
  });
});
