import { describe, expect, it } from "vitest";
import {
  parseLocalResourceAttributes,
  parseLocalResourceHref,
  parseLocalResourceLink,
} from "../src/local-resource.js";

describe("local resource parsing", () => {
  it("parses local-file hrefs with render and location hints", () => {
    expect(
      parseLocalResourceHref(
        "/api/local-file?path=%2Frepo%2FREADME.md&render=1&line=8&column=3",
      ),
    ).toEqual({
      kind: "local-file",
      path: "/repo/README.md",
      lineNumber: 8,
      columnNumber: 3,
      renderMarkdown: true,
      download: undefined,
    });
  });

  it("parses Windows drive paths in local-file hrefs", () => {
    expect(
      parseLocalResourceHref(
        "https://staging.yepanywhere.com/api/local-file?path=C%3A%2Ftmp%2Fplaybox-zero-g-compare.json",
      ),
    ).toEqual({
      kind: "local-file",
      path: "C:/tmp/playbox-zero-g-compare.json",
      lineNumber: undefined,
      columnNumber: undefined,
      renderMarkdown: undefined,
      download: undefined,
    });
  });

  it("keeps inline line suffixes out of parsed local-file paths", () => {
    expect(
      parseLocalResourceHref(
        "/api/local-file?path=C%3A%2Ftmp%2Fprobe.json%3A12",
      ),
    ).toMatchObject({
      kind: "local-file",
      path: "C:/tmp/probe.json",
      lineNumber: 12,
    });
  });

  it("parses local-image hrefs as local media", () => {
    expect(
      parseLocalResourceHref("/api/local-image?path=C%3A%2Ftmp%2Fprobe.png"),
    ).toEqual({
      kind: "local-media",
      path: "C:/tmp/probe.png",
      mediaType: "image",
    });

    expect(
      parseLocalResourceHref("/api/local-image?path=%2Ftmp%2Fclip.webm"),
    ).toEqual({
      kind: "local-media",
      path: "/tmp/clip.webm",
      mediaType: "video",
    });
  });

  it("parses project file routes", () => {
    expect(
      parseLocalResourceHref(
        "/projects/project-1/file?path=docs%2Fguide.md&line=12&lineEnd=18&column=4",
      ),
    ).toEqual({
      kind: "project-file",
      projectId: "project-1",
      path: "docs/guide.md",
      lineNumber: 12,
      lineEnd: 18,
      columnNumber: 4,
    });
  });

  it("parses project file routes under a hosted app basename", () => {
    expect(
      parseLocalResourceHref(
        "/remote/projects/project-1/file?path=docs%2Fguide.md",
      ),
    ).toEqual({
      kind: "project-file",
      projectId: "project-1",
      path: "docs/guide.md",
      lineNumber: undefined,
      lineEnd: undefined,
      columnNumber: undefined,
    });
  });

  it("parses raw project file API routes", () => {
    expect(
      parseLocalResourceHref(
        "/api/projects/project-1/files/raw?path=docs%2Fguide.pdf&download=true",
      ),
    ).toEqual({
      kind: "project-raw-file",
      projectId: "project-1",
      path: "docs/guide.pdf",
      download: true,
    });
  });

  it("parses semantic resource attributes", () => {
    expect(
      parseLocalResourceAttributes({
        "data-ya-resource": "local-file",
        "data-ya-path": "C:/tmp/probe.json",
        "data-ya-line": "9",
        "data-ya-column": "2",
        "data-ya-render-markdown": "false",
      }),
    ).toEqual({
      kind: "local-file",
      path: "C:/tmp/probe.json",
      projectId: undefined,
      lineNumber: 9,
      lineEnd: undefined,
      columnNumber: 2,
      renderMarkdown: false,
      download: undefined,
      mediaType: undefined,
    });
  });

  it("prefers semantic attributes over fallback hrefs", () => {
    expect(
      parseLocalResourceLink({
        attributes: {
          "data-ya-resource": "local-file",
          "data-ya-path": "C:/tmp/probe.json",
        },
        href: "/api/local-image?path=%2Ftmp%2Fprobe.png",
      }),
    ).toMatchObject({
      kind: "local-file",
      path: "C:/tmp/probe.json",
    });
  });

  it("falls back to hrefs when semantic attributes are incomplete", () => {
    expect(
      parseLocalResourceLink({
        attributes: {
          "data-ya-resource": "local-file",
        },
        href: "/api/local-image?path=%2Ftmp%2Fprobe.png",
      }),
    ).toEqual({
      kind: "local-media",
      path: "/tmp/probe.png",
      mediaType: "image",
    });
  });

  it("ignores unsupported or incomplete resource links", () => {
    expect(parseLocalResourceHref("https://example.com/docs")).toBeNull();
    expect(parseLocalResourceHref("/api/local-file")).toBeNull();
    expect(
      parseLocalResourceAttributes({
        "data-ya-resource": "local-media",
      }),
    ).toBeNull();
    expect(
      parseLocalResourceAttributes({
        "data-ya-resource": "project-file",
        "data-ya-path": "docs/guide.md",
      }),
    ).toBeNull();
  });
});
