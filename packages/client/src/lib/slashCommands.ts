import type { ThinkingOption } from "@yep-anywhere/shared";

export const CLIENT_SLASH_COMMANDS = [
  "fast",
  "run",
  "btw",
  "done",
  "model",
] as const;

export type ComposerSlashCommand =
  | { kind: "fast"; argument: string }
  | { kind: "run"; argument: string }
  | { kind: "custom"; command: string; argument: string };

export type ComposerSlashTurn =
  | {
      kind: "message";
      text: string;
      command?: "fast" | "run";
      thinking?: ThinkingOption;
    }
  | { kind: "custom"; command: string; argument: string }
  | { kind: "error"; command: "fast" | "run"; message: string };

const COMMAND_DISPLAY: Record<string, { label: string; shortcut: string }> = {
  fast: { label: "fast turn", shortcut: "/f" },
  run: { label: "run exactly", shortcut: "/r" },
  btw: { label: "btw aside", shortcut: "/b" },
  done: { label: "done with aside", shortcut: "/d" },
  model: { label: "model", shortcut: "/m" },
};

export function getSlashCommandMenuParts(command: string): {
  shortcut: string;
  rest: string;
  label: string;
} {
  const normalized = command.startsWith("/") ? command.slice(1) : command;
  const display = COMMAND_DISPLAY[normalized];
  if (!display) {
    const label = `/${normalized}`;
    return {
      shortcut: "",
      rest: label,
      label,
    };
  }

  const label = `/${display.label}`;
  return {
    shortcut: display.shortcut,
    rest: label.slice(display.shortcut.length),
    label,
  };
}

export function parseComposerSlashCommand(
  text: string,
): ComposerSlashCommand | null {
  const match = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }

  const command = match[1]?.toLowerCase() ?? "";
  const argument = match[2] ?? "";

  if (command === "f" || command === "fast") {
    return { kind: "fast", argument };
  }
  if (command === "r" || command === "run") {
    return { kind: "run", argument };
  }
  if (command === "m" || command === "model") {
    return { kind: "custom", command: "model", argument };
  }
  if (command === "b" || command === "btw") {
    return { kind: "custom", command: "btw", argument };
  }
  if (command === "d" || command === "done") {
    return { kind: "custom", command: "done", argument };
  }
  if (command === "compact") {
    return { kind: "custom", command, argument };
  }

  return null;
}

export function buildRunExactlyPrompt(command: string): string {
  const indentedCommand = command.replace(/^/gm, "    ");
  return [
    "Run exactly this shell command. Treat the indented block as literal shell text; do not rewrite, shorten, or add arguments.",
    "Use the shell execution tool directly. If it may run for more than a moment, run it in a PTY/session and return after the initial output.",
    "Do not keep polling, summarize, or analyze the full output unless I ask.",
    "",
    indentedCommand,
  ].join("\n");
}

export function resolveComposerSlashTurn(text: string): ComposerSlashTurn {
  const parsed = parseComposerSlashCommand(text);
  if (!parsed) {
    return { kind: "message", text };
  }

  if (parsed.kind === "custom") {
    return parsed;
  }

  const argument = parsed.argument.trim();
  if (!argument) {
    const command = parsed.kind;
    return {
      kind: "error",
      command,
      message:
        command === "fast"
          ? "Add a request after /fast or /f."
          : "Add a shell command after /run or /r.",
    };
  }

  if (parsed.kind === "fast") {
    return {
      kind: "message",
      text: argument,
      command: "fast",
      thinking: "off",
    };
  }

  return {
    kind: "message",
    text: buildRunExactlyPrompt(argument),
    command: "run",
    thinking: "off",
  };
}
