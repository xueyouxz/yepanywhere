import type { SlashCommand } from "@yep-anywhere/shared";
import type { UserMessage } from "./types.js";

const SLASH_COMMAND_SUBMISSION_RE = /^\/(\w+)(?:\s+([\s\S]*))?$/;

export function normalizeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function isSlashCommandSubmission(text: string): boolean {
  return SLASH_COMMAND_SUBMISSION_RE.test(text);
}

export function expandSlashCommandEmulation(
  message: UserMessage,
  commands: SlashCommand[] | null | undefined,
): UserMessage {
  const match = message.text.match(SLASH_COMMAND_SUBMISSION_RE);
  if (!match?.[1] || !commands) {
    return message;
  }

  const commandName = normalizeSlashCommandName(match[1]);
  const command = commands.find(
    (candidate) => normalizeSlashCommandName(candidate.name) === commandName,
  );
  const providerText = command?.emulation?.providerText?.trim();
  if (!providerText) {
    return message;
  }

  return {
    ...message,
    text: providerText.replaceAll("{{argument}}", match[2] ?? "").trimEnd(),
  };
}
