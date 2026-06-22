import { describe, expect, it } from "vitest";
import {
  attachPiResultDetailToToolInput,
  normalizePiTool,
  normalizePiToolResult,
} from "../../../src/sdk/providers/pi-tools.js";

describe("normalizePiTool", () => {
  it("maps pi lower-case tool names to YA canonical renderer names", () => {
    expect(normalizePiTool("read", {}).name).toBe("Read");
    expect(normalizePiTool("write", {}).name).toBe("Write");
    expect(normalizePiTool("edit", {}).name).toBe("Edit");
    expect(normalizePiTool("apply_patch", {}).name).toBe("Edit");
    expect(normalizePiTool("Apply_Patch", {}).name).toBe("Edit");
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

  it("maps pi apply_patch inputs to Edit raw patches", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    expect(normalizePiTool("apply_patch", patch)).toEqual({
      name: "Edit",
      input: { rawPatch: patch, _rawPatch: patch },
    });

    expect(normalizePiTool("apply_patch", { patch }).input).toEqual({
      patch,
      rawPatch: patch,
      _rawPatch: patch,
    });
  });

  it("keeps a multi-edit array as-is while preserving pi patch detail", () => {
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

  it("normalizes pi bash results to YA BashResult", () => {
    expect(
      normalizePiToolResult("Bash", {
        content: [{ type: "text", text: "hello\n" }],
      }),
    ).toEqual({
      stdout: "hello\n",
      stderr: "",
      interrupted: false,
      isImage: false,
    });
  });

  it("normalizes pi read results to YA ReadResult", () => {
    expect(
      normalizePiToolResult(
        "Read",
        { content: [{ type: "text", text: "a\nb" }] },
        { file_path: "src/a.ts", offset: 3 },
      ),
    ).toEqual({
      type: "text",
      file: {
        filePath: "src/a.ts",
        content: "a\nb",
        numLines: 2,
        startLine: 3,
        totalLines: 4,
      },
    });
  });

  it("attaches pi edit patches to canonical Edit inputs", () => {
    const input = normalizePiTool("edit", {
      path: "a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    }).input;

    attachPiResultDetailToToolInput("Edit", input, {
      content: [{ type: "text", text: "Successfully replaced 2 block(s)." }],
      details: { patch: "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-a\n+b" },
    });

    expect(input._rawPatch).toBe("--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-a\n+b");
  });
});
