import type { ProviderName, SlashCommand } from "@yep-anywhere/shared";

export const CODEX_BUILTIN_COMMANDS: readonly SlashCommand[] = [
  {
    name: "compact",
    description: "",
  },
  {
    name: "goal",
    description: "",
  },
];

export function getStaticSlashCommandsForProvider(
  provider: ProviderName | undefined,
): SlashCommand[] | null {
  return provider === "codex" ? [...CODEX_BUILTIN_COMMANDS] : null;
}
