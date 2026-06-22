import { describe, expect, it } from "vitest";
import { normalizePiTool } from "../../../src/sdk/providers/pi-tools.js";

describe("normalizePiTool", () => {
  it("maps pi lower-case tool names to YA canonical renderer names", () => {
    expect(normalizePiTool("read", {}).name).toBe("Read");
    expect(normalizePiTool("write", {}).name).toBe("Write");
    expect(normalizePiTool("edit", {}).name).toBe("Edit");
    expect(normalizePiTool("bash", {}).name).toBe("Bash");
    expect(normalizePiTool("grep", {}).name).toBe("Grep");
    expect(normalizePiTool("ls", {}).name).toBe("LS");
  });

  it("renames pi `path` to `file_path` for Read/Write/Edit", () => {
    expect(
      normalizePiTool("read", { path: "a.ts", offset: 1, limit: 2 }).input,
    ).toEqual({ file_path: "a.ts", offset: 1, limit: 2 });
    expect(
      normalizePiTool("write", { path: "a.ts", content: "x" }).input,
    ).toEqual({
      file_path: "a.ts",
      content: "x",
    });
  });

  it("does NOT rename `path` for grep (Claude Grep expects `path`)", () => {
    expect(
      normalizePiTool("grep", { pattern: "x", path: "src", glob: "*.ts" })
        .input,
    ).toEqual({ pattern: "x", path: "src", glob: "*.ts" });
  });

  it("expands a single pi edit to old_string/new_string for the diff augment", () => {
    expect(
      normalizePiTool("edit", {
        path: "a.ts",
        edits: [{ oldText: "foo", newText: "bar" }],
      }).input,
    ).toEqual({
      file_path: "a.ts",
      edits: [{ oldText: "foo", newText: "bar" }],
      old_string: "foo",
      new_string: "bar",
    });
  });

  it("keeps a multi-edit array as-is (no MultiEdit renderer)", () => {
    const input = normalizePiTool("edit", {
      path: "a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    }).input;
    expect(input.file_path).toBe("a.ts");
    expect(input.old_string).toBeUndefined();
    expect(Array.isArray(input.edits)).toBe(true);
  });

  it("passes unmapped tools through unchanged", () => {
    expect(normalizePiTool("custom_tool", { a: 1 })).toEqual({
      name: "custom_tool",
      input: { a: 1 },
    });
  });
});
