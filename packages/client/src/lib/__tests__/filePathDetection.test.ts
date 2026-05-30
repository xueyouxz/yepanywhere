import { describe, expect, it } from "vitest";
import { detectFilePaths, splitTextWithFilePaths } from "../filePathDetection";

describe("detectFilePaths", () => {
  describe("absolute paths", () => {
    it("detects absolute paths with extensions", () => {
      const result = detectFilePaths("Look at /path/to/file.ts for details");
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        filePath: "/path/to/file.ts",
        match: "/path/to/file.ts",
      });
    });

    it("detects absolute paths in root directory", () => {
      const result = detectFilePaths("Check /home/user/project/src/index.ts");
      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe("/home/user/project/src/index.ts");
    });
  });

  describe("relative paths", () => {
    it("detects relative paths with ./", () => {
      const result = detectFilePaths("Edit ./src/components/Button.tsx");
      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe("./src/components/Button.tsx");
    });

    it("detects relative paths without ./", () => {
      const result = detectFilePaths("Found in src/utils/helper.ts");
      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe("src/utils/helper.ts");
    });

    it("detects paths with ../ prefix", () => {
      const result = detectFilePaths("Import from ../shared/types.ts");
      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe("../shared/types.ts");
    });
  });

  describe("line numbers", () => {
    it("detects paths with line numbers", () => {
      const result = detectFilePaths("Error at src/app.ts:42");
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        filePath: "src/app.ts",
        lineNumber: 42,
        match: "src/app.ts:42",
      });
    });

    it("detects paths with line and column numbers", () => {
      const result = detectFilePaths("Issue at src/app.ts:42:10");
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        filePath: "src/app.ts",
        lineNumber: 42,
        columnNumber: 10,
        match: "src/app.ts:42:10",
      });
    });
  });

  describe("multiple paths", () => {
    it("detects multiple paths in text", () => {
      const result = detectFilePaths(
        "Changed src/a.ts and packages/client/b.tsx",
      );
      expect(result).toHaveLength(2);
      expect(result[0]?.filePath).toBe("src/a.ts");
      expect(result[1]?.filePath).toBe("packages/client/b.tsx");
    });
  });

  describe("known filenames", () => {
    it("detects package.json", () => {
      const result = detectFilePaths("Edit package.json");
      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe("package.json");
    });

    it("detects tsconfig.json", () => {
      const result = detectFilePaths("Configure tsconfig.json");
      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe("tsconfig.json");
    });

    it("detects README.md", () => {
      const result = detectFilePaths("Read README.md");
      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe("README.md");
    });
  });

  describe("false positive prevention", () => {
    it("ignores URLs", () => {
      const result = detectFilePaths("Visit https://example.com/page.html");
      expect(result).toHaveLength(0);
    });

    it("ignores http URLs", () => {
      const result = detectFilePaths("Go to http://localhost:3000/api.json");
      expect(result).toHaveLength(0);
    });

    it("ignores email addresses", () => {
      const result = detectFilePaths("Contact user@example.com");
      expect(result).toHaveLength(0);
    });

    it("ignores strings without file extensions in prose", () => {
      const result = detectFilePaths("The ratio was 3/4 of the total");
      expect(result).toHaveLength(0);
    });

    it("ignores plain words that look like extensions", () => {
      const result = detectFilePaths("Use the test.case approach");
      // test.case has no recognized extension
      expect(result).toHaveLength(0);
    });
  });

  describe("position tracking", () => {
    it("tracks start and end indices", () => {
      const text = "Found in src/file.ts here";
      const result = detectFilePaths(text);
      expect(result).toHaveLength(1);
      expect(result[0]?.startIndex).toBe(9);
      expect(result[0]?.endIndex).toBe(20); // "src/file.ts" is 11 chars
      expect(text.slice(result[0]?.startIndex, result[0]?.endIndex)).toBe(
        "src/file.ts",
      );
    });
  });
});

describe("splitTextWithFilePaths", () => {
  it("returns single text segment when no paths found", () => {
    const result = splitTextWithFilePaths("Hello world");
    expect(result).toEqual([{ type: "text", content: "Hello world" }]);
  });

  it("splits text around file path", () => {
    const result = splitTextWithFilePaths("Check src/file.ts for details");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "text", content: "Check " });
    expect(result[1]).toMatchObject({
      type: "filePath",
      detected: { filePath: "src/file.ts" },
    });
    expect(result[2]).toEqual({ type: "text", content: " for details" });
  });

  it("handles multiple file paths", () => {
    const result = splitTextWithFilePaths("Edit src/a.ts and src/b.ts files");
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ type: "text", content: "Edit " });
    expect(result[1]).toMatchObject({ type: "filePath" });
    expect(result[2]).toEqual({ type: "text", content: " and " });
    expect(result[3]).toMatchObject({ type: "filePath" });
    expect(result[4]).toEqual({ type: "text", content: " files" });
  });

  it("handles path at start of text", () => {
    const result = splitTextWithFilePaths("src/file.ts is the entry");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: "filePath" });
    expect(result[1]).toEqual({ type: "text", content: " is the entry" });
  });

  it("handles path at end of text", () => {
    const result = splitTextWithFilePaths("Entry point is src/file.ts");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", content: "Entry point is " });
    expect(result[1]).toMatchObject({ type: "filePath" });
  });

  it("handles path as only content", () => {
    const result = splitTextWithFilePaths("src/file.ts");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "filePath",
      detected: { filePath: "src/file.ts" },
    });
  });

  it("preserves line numbers in segments", () => {
    const result = splitTextWithFilePaths("Error at src/app.ts:42:10");
    expect(result).toHaveLength(2);
    const fp = result[1];
    expect(fp?.type).toBe("filePath");
    if (fp?.type === "filePath") {
      expect(fp.detected.lineNumber).toBe(42);
      expect(fp.detected.columnNumber).toBe(10);
    }
  });
});
