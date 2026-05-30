import type { SlashCommand } from "@yep-anywhere/shared";
import type { UserMessage } from "./types.js";

const SLASH_COMMAND_SUBMISSION_RE = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;

export interface SlashCommandEmulationOptions {
  unknownCommandPrefix?: string;
  nativeCommandNames?: ReadonlySet<string>;
}

export function normalizeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function isSlashCommandSubmission(text: string): boolean {
  return SLASH_COMMAND_SUBMISSION_RE.test(text);
}

export function expandSlashCommandEmulation(
  message: UserMessage,
  commands: SlashCommand[] | null | undefined,
  options?: SlashCommandEmulationOptions,
): UserMessage {
  const match = message.text.match(SLASH_COMMAND_SUBMISSION_RE);
  if (!match?.[1]) {
    return message;
  }

  const rawCommandName = match[1];
  const commandName = normalizeSlashCommandName(rawCommandName);
  const command = commands?.find(
    (candidate) => normalizeSlashCommandName(candidate.name) === commandName,
  );
  const providerText = command?.emulation?.providerText?.trim();
  if (!providerText) {
    const isNativeCommand =
      command !== undefined || options?.nativeCommandNames?.has(commandName);
    const fallbackPrefix = options?.unknownCommandPrefix;
    if (fallbackPrefix && !isNativeCommand) {
      const argument = match[2] ? ` ${match[2]}` : "";
      return {
        ...message,
        text: `${fallbackPrefix}${rawCommandName}${argument}`,
      };
    }
    return message;
  }

  return {
    ...message,
    text: providerText.replaceAll("{{argument}}", match[2] ?? "").trimEnd(),
  };
}
