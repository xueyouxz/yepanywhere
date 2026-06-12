import { describe, expect, it } from "vitest";
import {
  getPathBasename,
  getProjectRelativePath,
  makeDisplayPath,
  shortenPath,
  splitDisplayPath,
} from "../text";

describe("path display helpers", () => {
  it("makes POSIX project-local absolute paths project-relative", () => {
    expect(
      makeDisplayPath(
        "/Users/user/Documents/code/playbox/docs/tactical/note.md",
        "/Users/user/Documents/code/playbox",
      ),
    ).toBe("docs/tactical/note.md");
  });

  it("makes Windows project-local absolute paths project-relative", () => {
    expect(
      makeDisplayPath(
        "C:\\Users\\user\\Documents\\code\\playbox\\docs\\tactical\\note.md",
        "C:\\Users\\user\\Documents\\code\\playbox",
      ),
    ).toBe("docs/tactical/note.md");
  });

  it("compares Windows drive paths case-insensitively", () => {
    expect(
      getProjectRelativePath(
        "c:\\Users\\User\\Documents\\Code\\Playbox\\src\\App.tsx",
        "C:/Users/user/Documents/code/playbox",
      ),
    ).toBe("src/App.tsx");
  });

  it("shortens home paths without changing unrelated absolute paths", () => {
    expect(shortenPath("C:\\Users\\user\\Downloads\\trace.log")).toBe(
      "~/Downloads/trace.log",
    );
    expect(shortenPath("D:\\work\\external\\trace.log")).toBe(
      "D:\\work\\external\\trace.log",
    );
  });

  it("handles basename and display splitting for both slash styles", () => {
    expect(getPathBasename("C:\\repo\\src\\App.tsx")).toBe("App.tsx");
    expect(splitDisplayPath("C:\\repo\\src\\App.tsx")).toEqual({
      dir: "C:\\repo\\src\\",
      name: "App.tsx",
    });
  });
});
