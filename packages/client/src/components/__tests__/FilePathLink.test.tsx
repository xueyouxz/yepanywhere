import { cleanup, render, screen } from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import { PublicShareProvider } from "../../contexts/PublicShareContext";
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

  it("renders file range links with lineEnd", () => {
    render(
      <FilePathLink
        projectId="project-id"
        filePath="docs/guide.md"
        lineNumber={12}
        lineEnd={16}
        displayText="guide.md"
      />,
    );

    const link = screen.getByRole("link", { name: /guide\.md\s*:12-16/ });
    expect(link.getAttribute("href")).toBe(
      "/projects/project-id/file?path=docs%2Fguide.md&line=12&lineEnd=16",
    );
  });

  it("renders compact range links with view=range", () => {
    render(
      <FilePathLink
        projectId="project-id"
        filePath="docs/guide.md"
        lineNumber={12}
        lineEnd={16}
        displayText="5 lines"
        showLineSuffix={false}
        viewMode="range"
      />,
    );

    const link = screen.getByRole("link", { name: "5 lines" });
    expect(link.getAttribute("href")).toBe(
      "/projects/project-id/file?path=docs%2Fguide.md&line=12&lineEnd=16&view=range",
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

  it("links Windows absolute paths under the project as project-relative paths", () => {
    const projectRoot = "C:\\Users\\user\\Documents\\code\\playbox";
    const projectId = toUrlProjectId(projectRoot);

    render(
      <FilePathLink
        projectId={projectId}
        filePath={`${projectRoot}\\docs\\tactical\\note.md`}
        lineNumber={8}
        displayText="docs/tactical/note.md"
      />,
    );

    const link = screen.getByRole("link", {
      name: /docs\/tactical\/note\.md\s*:8/,
    });
    expect(link.getAttribute("href")).toBe(
      `/projects/${projectId}/file?path=docs%2Ftactical%2Fnote.md&line=8`,
    );
  });

  it("keeps Windows absolute paths outside the project absolute", () => {
    const projectRoot = "C:\\Users\\user\\Documents\\code\\playbox";
    const projectId = toUrlProjectId(projectRoot);

    render(
      <FilePathLink
        projectId={projectId}
        filePath={"D:\\scratch\\outside.md"}
        lineNumber={4}
        displayText="outside.md"
      />,
    );

    const link = screen.getByRole("link", { name: /outside\.md\s*:4/ });
    expect(link.getAttribute("href")).toBe(
      `/projects/${projectId}/file?path=D%3A%5Cscratch%5Coutside.md&line=4`,
    );
  });

  it("uses share-scoped file routes when rendered in a public share", () => {
    const projectId = toUrlProjectId("/local/graehl/yepanywhere");

    render(
      <PublicShareProvider
        value={{
          projectId,
          relayUrl: "wss://relay.graehl.org/ws",
          relayUsername: "ygraehl",
          secret: "share-secret",
        }}
      >
        <FilePathLink
          projectId={projectId}
          filePath="/local/graehl/yepanywhere/ui-report/README.md"
          lineNumber={8}
          lineEnd={12}
          displayText="ui-report/README.md"
          viewMode="range"
        />
      </PublicShareProvider>,
    );

    const link = screen.getByRole("link", {
      name: /ui-report\/README\.md\s*:8/,
    });
    expect(link.getAttribute("href")).toBe(
      `/share/share-secret/file?path=ui-report%2FREADME.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${projectId}&line=8&lineEnd=12&view=range`,
    );
  });
});
