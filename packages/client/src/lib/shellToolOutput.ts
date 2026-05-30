export interface ParsedShellToolOutput {
  output: string;
  exitCode?: number;
  wallTime?: string;
  hasEnvelope: boolean;
}

function extractExitCode(text: string): number | undefined {
  const match = text.match(
    /(?:^|\n)\s*(?:Process exited with code|Exit code:)\s*(-?\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function extractWallTime(text: string): string | undefined {
  const match = text.match(/(?:^|\n)\s*Wall time:\s*([^\n]+)\s*(?:\n|$)/i);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1].trim();
}

export function parseShellToolOutput(text: string): ParsedShellToolOutput {
  const outputMatch = text.match(/(?:^|\n)\s*Output:\s*\n([\s\S]*)$/i);
  const hasEnvelope = !!outputMatch;
  const output = (outputMatch?.[1] ?? text).trimEnd();

  return {
    output,
    exitCode: extractExitCode(text),
    wallTime: extractWallTime(text),
    hasEnvelope,
  };
}
