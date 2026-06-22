import { describe, expect, it } from "vitest";
import { normalizeGeminiTool } from "../../../src/sdk/providers/gemini-tools.js";

describe("normalizeGeminiTool", () => {
  it("maps Gemini CLI tool names to YA canonical renderer names", () => {
    expect(normalizeGeminiTool("read_file", {}).name).toBe("Read");
    expect(normalizeGeminiTool("replace", {}).name).toBe("Edit");
    expect(normalizeGeminiTool("write_file", {}).name).toBe("Write");
    expect(normalizeGeminiTool("glob", {}).name).toBe("Glob");
    expect(normalizeGeminiTool("search_file_content", {}).name).toBe("Grep");
    expect(normalizeGeminiTool("run_shell_command", {}).name).toBe("Bash");
  });

  it("renames replace's old_content/new_content to Claude Edit fields", () => {
    expect(
      normalizeGeminiTool("replace", {
        file_path: "a.txt",
        old_content: "Hello",
        new_content: "Greetings",
      }).input,
    ).toEqual({
      file_path: "a.txt",
      old_string: "Hello",
      new_string: "Greetings",
    });
  });

  it("leaves already-Claude-shaped fields untouched (read/write/bash)", () => {
    expect(
      normalizeGeminiTool("read_file", { file_path: "p.json" }).input,
    ).toEqual({
      file_path: "p.json",
    });
    expect(
      normalizeGeminiTool("write_file", { file_path: "n.txt", content: "x" })
        .input,
    ).toEqual({ file_path: "n.txt", content: "x" });
    expect(
      normalizeGeminiTool("run_shell_command", { command: "ls" }).input,
    ).toEqual({ command: "ls" });
  });

  it("passes unmapped tools through unchanged (honest raw fallback)", () => {
    const r = normalizeGeminiTool("write_todos", {
      todos: [{ status: "done" }],
    });
    expect(r.name).toBe("write_todos");
    expect(r.input).toEqual({ todos: [{ status: "done" }] });
    expect(normalizeGeminiTool("delegate_to_agent", {}).name).toBe(
      "delegate_to_agent",
    );
  });

  it("coerces non-object input to an empty record", () => {
    expect(normalizeGeminiTool("read_file", undefined).input).toEqual({});
    expect(normalizeGeminiTool(undefined, {}).name).toBe("unknown");
  });
});
