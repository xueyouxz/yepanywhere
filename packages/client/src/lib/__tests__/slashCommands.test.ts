import { describe, expect, it } from "vitest";
import {
  buildRunExactlyPrompt,
  getSlashCommandMenuParts,
  parseComposerSlashCommand,
  resolveComposerSlashTurn,
} from "../slashCommands";

describe("slashCommands", () => {
  it("parses fast and run aliases only when they start with slash", () => {
    expect(parseComposerSlashCommand("/f check status")).toEqual({
      kind: "fast",
      argument: "check status",
    });
    expect(parseComposerSlashCommand("/fast check status")).toEqual({
      kind: "fast",
      argument: "check status",
    });
    expect(parseComposerSlashCommand("/r git diff")).toEqual({
      kind: "run",
      argument: "git diff",
    });
    expect(parseComposerSlashCommand("/run git diff")).toEqual({
      kind: "run",
      argument: "git diff",
    });
    expect(parseComposerSlashCommand("f check status")).toBeNull();
    expect(parseComposerSlashCommand("!git diff")).toBeNull();
  });

  it("parses highlighted model shortcut as the model command", () => {
    expect(parseComposerSlashCommand("/m")).toEqual({
      kind: "custom",
      command: "model",
      argument: "",
    });
    expect(parseComposerSlashCommand("/model")).toEqual({
      kind: "custom",
      command: "model",
      argument: "",
    });
  });

  it("parses /done and /d as a client-side close-aside command", () => {
    expect(parseComposerSlashCommand("/d")).toEqual({
      kind: "custom",
      command: "done",
      argument: "",
    });
    expect(parseComposerSlashCommand("/done")).toEqual({
      kind: "custom",
      command: "done",
      argument: "",
    });
    expect(parseComposerSlashCommand("/done with notes")).toEqual({
      kind: "custom",
      command: "done",
      argument: "with notes",
    });
    expect(resolveComposerSlashTurn("/done")).toEqual({
      kind: "custom",
      command: "done",
      argument: "",
    });
  });

  it("parses /btw as a client-side aside command", () => {
    expect(parseComposerSlashCommand("/b side lookup")).toEqual({
      kind: "custom",
      command: "btw",
      argument: "side lookup",
    });
    expect(parseComposerSlashCommand("/btw side lookup")).toEqual({
      kind: "custom",
      command: "btw",
      argument: "side lookup",
    });
    expect(resolveComposerSlashTurn("/btw side lookup")).toEqual({
      kind: "custom",
      command: "btw",
      argument: "side lookup",
    });
  });

  it("renders whole command labels with shortcut parts split out", () => {
    expect(getSlashCommandMenuParts("fast")).toEqual({
      shortcut: "/f",
      rest: "ast turn",
      label: "/fast turn",
    });
    expect(getSlashCommandMenuParts("run")).toEqual({
      shortcut: "/r",
      rest: "un exactly",
      label: "/run exactly",
    });
    expect(getSlashCommandMenuParts("btw")).toEqual({
      shortcut: "/b",
      rest: "tw aside",
      label: "/btw aside",
    });
    expect(getSlashCommandMenuParts("model")).toEqual({
      shortcut: "/m",
      rest: "odel",
      label: "/model",
    });
    expect(getSlashCommandMenuParts("compact")).toEqual({
      shortcut: "",
      rest: "/compact",
      label: "/compact",
    });
  });

  it("turns /fast into a thinking-off message", () => {
    expect(resolveComposerSlashTurn("/f summarize this")).toEqual({
      kind: "message",
      text: "summarize this",
      command: "fast",
      thinking: "off",
    });
  });

  it("turns /run into a thinking-off exact-run instruction", () => {
    const resolved = resolveComposerSlashTurn("/r git diff -- README.md");

    expect(resolved.kind).toBe("message");
    if (resolved.kind !== "message") {
      throw new Error("Expected a message turn");
    }
    expect(resolved.command).toBe("run");
    expect(resolved.thinking).toBe("off");
    expect(resolved.text).toContain("Run exactly this shell command");
    expect(resolved.text).toContain("    git diff -- README.md");
  });

  it("returns errors for slash commands that need an argument", () => {
    expect(resolveComposerSlashTurn("/f")).toEqual({
      kind: "error",
      command: "fast",
      message: "Add a request after /fast or /f.",
    });
    expect(resolveComposerSlashTurn("/run")).toEqual({
      kind: "error",
      command: "run",
      message: "Add a shell command after /run or /r.",
    });
  });

  it("keeps unknown provider slash commands as normal messages", () => {
    expect(resolveComposerSlashTurn("/permissions")).toEqual({
      kind: "message",
      text: "/permissions",
    });
  });

  it("indents every command line in exact-run prompts", () => {
    expect(buildRunExactlyPrompt("printf one\nprintf two")).toContain(
      "    printf one\n    printf two",
    );
  });
});
