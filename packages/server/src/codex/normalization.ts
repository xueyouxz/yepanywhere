export const CODEX_TOOL_NAME_ALIASES: Record<string, string> = {
  shell_command: "Bash",
  exec_command: "Bash",
  write_stdin: "WriteStdin",
  update_plan: "UpdatePlan",
  apply_patch: "Edit",
  web_search_call: "WebSearch",
  search_query: "WebSearch",
};

export interface CodexReadShellInfo {
  filePath: string;
  startLine?: number;
  endLine?: number;
  stripLineNumbers: boolean;
}

export interface CodexWriteShellInfo {
  filePath: string;
  content: string;
}

export interface CodexToolCallContext {
  toolName: string;
  input: unknown;
  readShellInfo?: CodexReadShellInfo;
  writeShellInfo?: CodexWriteShellInfo;
}

export interface NormalizedCodexToolInvocation {
  toolName: string;
  input: unknown;
  readShellInfo?: CodexReadShellInfo;
  writeShellInfo?: CodexWriteShellInfo;
}

export interface NormalizedCodexToolOutput {
  content: string;
  structured?: unknown;
  isError: boolean;
}

interface NormalizedCodexToolOutputWithExitCode
  extends NormalizedCodexToolOutput {
  exitCode?: number;
}

const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "dash"]);
const INLINE_IMAGE_DATA_URL_PREFIX_RE = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?,/i;
const INLINE_IMAGE_DATA_URL_GLOBAL_RE =
  /data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[A-Za-z0-9+/=_-]+/gi;

export function parseCodexToolArguments(argumentsText?: string): unknown {
  if (!argumentsText) {
    return {};
  }
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { raw: argumentsText };
  }
}

export function canonicalizeCodexToolName(name: string): string {
  return (
    CODEX_TOOL_NAME_ALIASES[name] ??
    CODEX_TOOL_NAME_ALIASES[name.toLowerCase()] ??
    name
  );
}

export function normalizeCodexToolInvocation(
  toolName: string,
  input: unknown,
): NormalizedCodexToolInvocation {
  if (toolName !== "Bash") {
    return { toolName, input };
  }

  let normalizedInput: unknown = input;
  if (typeof input === "string" && input.trim()) {
    normalizedInput = { command: input };
  } else if (isRecord(input)) {
    const normalized = { ...input };
    if (
      typeof normalized.command !== "string" &&
      typeof normalized.cmd === "string"
    ) {
      normalized.command = normalized.cmd;
    }
    normalizedInput = normalized;
  }

  const command = extractBashCommand(normalizedInput);
  if (!command) {
    return { toolName: "Bash", input: normalizedInput };
  }
  const normalizedCommand = unwrapShellLauncherCommand(command);

  const readShellInfo = parseReadShellCommand(normalizedCommand);
  if (readShellInfo) {
    return {
      toolName: "Read",
      input: createReadToolInput(readShellInfo),
      readShellInfo,
    };
  }

  const grepInput = parseRipgrepCommand(normalizedCommand);
  if (grepInput) {
    return {
      toolName: "Grep",
      input: grepInput,
    };
  }

  const writeShellInfo = parseHeredocWriteShellCommand(normalizedCommand);
  if (writeShellInfo) {
    return {
      toolName: "Write",
      input: createWriteToolInput(writeShellInfo),
      writeShellInfo,
    };
  }

  return { toolName: "Bash", input: normalizedInput };
}

export function normalizeCodexToolOutputWithContext(
  output: unknown,
  context?: CodexToolCallContext,
): NormalizedCodexToolOutput {
  const normalized = normalizeCodexToolOutput(output);
  let content = normalized.content;
  let structured = normalized.structured;
  let isError = normalized.isError;
  const exitCode = normalized.exitCode ?? extractExitCodeFromText(content);
  const sessionId = extractSessionIdFromText(content);
  const backgroundTaskId = extractCodexBackgroundTaskId(content);
  const interrupted = isCodexInterruptedToolOutput(content);

  if (context?.toolName === "Grep") {
    const grepContent = extractCodexShellOutputContent(content);
    const grepResult = normalizeRipgrepOutput(grepContent);
    const isNoMatchesResult = exitCode === 1 && grepResult.numFiles === 0;

    if (!isError || isNoMatchesResult) {
      isError = false;
      structured = sessionId
        ? { ...grepResult, session_id: sessionId }
        : grepResult;
      content = grepContent;
    }
  } else if (context?.toolName === "Read" && context.readShellInfo) {
    if (!isError) {
      const readContent = extractCodexShellOutputContent(content);
      const readResult = normalizeReadOutput(
        readContent,
        context.readShellInfo,
      );
      structured = sessionId
        ? { ...readResult, session_id: sessionId }
        : readResult;
      content = readContent;
    }
  } else if (context?.toolName === "Write" && context.writeShellInfo) {
    if (!isError) {
      const writeResult = normalizeWriteOutput(context.writeShellInfo);
      structured = sessionId
        ? { ...writeResult, session_id: sessionId }
        : writeResult;
    }
  } else if (context?.toolName === "Bash") {
    const bashContent = extractCodexShellOutputContent(content);
    if (bashContent !== content || backgroundTaskId || interrupted) {
      structured = createBashToolResult(
        interrupted ? "" : bashContent,
        isError,
        backgroundTaskId,
        interrupted,
      );
    }
  }

  return { content, structured, isError };
}

export function normalizeCodexCommandExecutionOutput(
  execution: {
    aggregatedOutput: string;
    exitCode?: number;
    status?: string;
  },
  context?: CodexToolCallContext,
): NormalizedCodexToolOutput {
  const baseOutput = execution.aggregatedOutput;
  const hasExitCode = execution.exitCode !== undefined;
  let content =
    execution.status === "declined"
      ? "Command execution was declined."
      : baseOutput || "(no output)";

  const isDeclined = execution.status === "declined";
  let isError = !isDeclined && hasExitCode && execution.exitCode !== 0;
  if (!isDeclined && execution.status) {
    const normalizedStatus = execution.status.toLowerCase();
    if (normalizedStatus === "failed" || normalizedStatus === "error") {
      isError = true;
    }
  }

  // Preserve legacy command output formatting for non-zero exits.
  if (
    !isDeclined &&
    execution.exitCode !== undefined &&
    execution.exitCode !== 0 &&
    baseOutput
  ) {
    content = `Exit code: ${execution.exitCode}\n${baseOutput}`;
  }

  let structured: unknown;
  if (context?.toolName === "Grep") {
    const grepResult = normalizeRipgrepOutput(baseOutput);
    const isNoMatchesResult =
      execution.exitCode === 1 && grepResult.numFiles === 0;
    if (!isError || isNoMatchesResult) {
      isError = false;
      structured = grepResult;
      content = baseOutput;
    }
  } else if (
    context?.toolName === "Read" &&
    context.readShellInfo &&
    !isError &&
    execution.status !== "declined"
  ) {
    structured = normalizeReadOutput(baseOutput, context.readShellInfo);
    content = baseOutput;
  } else if (
    context?.toolName === "Write" &&
    context.writeShellInfo &&
    !isError &&
    execution.status !== "declined"
  ) {
    structured = normalizeWriteOutput(context.writeShellInfo);
  } else if (context?.toolName === "Bash" && execution.status !== "declined") {
    structured = createBashToolResult(baseOutput, isError);
  }

  return { content, structured, isError };
}

function extractBashCommand(input: unknown): string {
  if (!isRecord(input)) return "";
  if (typeof input.command === "string" && input.command.trim()) {
    return input.command.trim();
  }
  if (typeof input.cmd === "string" && input.cmd.trim()) {
    return input.cmd.trim();
  }
  return "";
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (!char) continue;

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function getExecutableName(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  return (normalized.split("/").pop() || token).toLowerCase();
}

function isShellExecutable(token: string): boolean {
  return SHELL_EXECUTABLES.has(getExecutableName(token));
}

function getShellLauncherPrefixLength(tokens: string[]): number {
  if (tokens.length < 3) {
    return 0;
  }

  const first = tokens[0] || "";
  const second = tokens[1] || "";
  const third = tokens[2] || "";

  // /usr/bin/env bash -lc "command"
  if (
    getExecutableName(first) === "env" &&
    isShellExecutable(second) &&
    third === "-lc" &&
    tokens.length >= 4
  ) {
    return 3;
  }

  // /bin/bash -lc "command"
  if (isShellExecutable(first) && second === "-lc" && tokens.length >= 3) {
    return 2;
  }

  return 0;
}

function unwrapShellLauncherCommand(command: string): string {
  let normalized = command.trim();

  // Allow nested wrappers, e.g. `bash -lc "env bash -lc \"...\""`
  for (let i = 0; i < 3; i++) {
    const tokens = tokenizeShellCommand(normalized);
    const launcherPrefixLength = getShellLauncherPrefixLength(tokens);
    if (launcherPrefixLength === 0 || tokens.length <= launcherPrefixLength) {
      break;
    }
    normalized = tokens.slice(launcherPrefixLength).join(" ").trim();
  }

  return normalized;
}

function parseLineRangeToken(
  token: string,
): { startLine: number; endLine: number } | null {
  const match = token.match(/^(\d+)(?:,(\d+))?p$/);
  if (!match?.[1]) return null;

  const startLine = Number.parseInt(match[1], 10);
  const endLine = match[2] ? Number.parseInt(match[2], 10) : startLine;
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return null;
  }

  return {
    startLine,
    endLine: Math.max(startLine, endLine),
  };
}

function parseReadShellCommand(command: string): CodexReadShellInfo | null {
  const tokens = tokenizeShellCommand(command);
  if (tokens.length === 0) return null;

  if (tokens[0] === "cat" && tokens.length === 2) {
    const filePath = tokens[1];
    if (!filePath || filePath.startsWith("-")) {
      return null;
    }
    return {
      filePath,
      stripLineNumbers: false,
    };
  }

  if (tokens[0] === "sed" && tokens[1] === "-n" && tokens.length === 4) {
    const range = parseLineRangeToken(tokens[2] ?? "");
    const filePath = tokens[3];
    if (!range || !filePath || filePath.startsWith("-")) {
      return null;
    }
    return {
      filePath,
      startLine: range.startLine,
      endLine: range.endLine,
      stripLineNumbers: false,
    };
  }

  const isNlSedCommand =
    tokens[0] === "nl" &&
    tokens[1] === "-ba" &&
    tokens[3] === "|" &&
    tokens[4] === "sed" &&
    tokens[5] === "-n" &&
    tokens.length === 7;
  if (isNlSedCommand) {
    const filePath = tokens[2];
    const range = parseLineRangeToken(tokens[6] ?? "");
    if (!filePath || !range) return null;
    return {
      filePath,
      startLine: range.startLine,
      endLine: range.endLine,
      stripLineNumbers: true,
    };
  }

  return null;
}

function parseHeredocWriteShellCommand(
  command: string,
): CodexWriteShellInfo | null {
  const normalized = command.replace(/\r\n/g, "\n").trimEnd();
  const lines = normalized.split("\n");
  if (lines.length < 2) {
    return null;
  }

  const header = lines[0]?.trim() ?? "";
  const match =
    /^cat\s+>\s*(?<path>'[^']+'|"[^"]+"|[^\s]+)\s+<<(?<stripTabs>-?)(?<quote>['"]?)(?<marker>[A-Za-z_][A-Za-z0-9_]*)\k<quote>\s*$/.exec(
      header,
    );
  if (!match?.groups) {
    return null;
  }

  const marker = match.groups.marker;
  if (!marker) {
    return null;
  }

  const stripTabs = match.groups.stripTabs === "-";
  const filePath = stripOuterQuotes(match.groups.path ?? "");
  if (!filePath || filePath.startsWith("-")) {
    return null;
  }

  const terminatorLineIndex = lines.findIndex((line, index) => {
    if (index === 0) {
      return false;
    }
    const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
    return candidate.trim() === marker;
  });
  if (terminatorLineIndex < 1) {
    return null;
  }

  const trailingLines = lines.slice(terminatorLineIndex + 1);
  if (trailingLines.some((line) => line.trim().length > 0)) {
    return null;
  }

  const bodyLines = lines.slice(1, terminatorLineIndex);
  let content = bodyLines.join("\n");
  if (bodyLines.length > 0) {
    content += "\n";
  }

  return {
    filePath,
    content,
  };
}

function createReadToolInput(
  readInfo: CodexReadShellInfo,
): Record<string, unknown> {
  const input: Record<string, unknown> = { file_path: readInfo.filePath };

  if (readInfo.startLine !== undefined) {
    input.offset = readInfo.startLine;
  }
  if (
    readInfo.startLine !== undefined &&
    readInfo.endLine !== undefined &&
    readInfo.endLine >= readInfo.startLine
  ) {
    input.limit = readInfo.endLine - readInfo.startLine + 1;
  }

  return input;
}

function createWriteToolInput(
  writeInfo: CodexWriteShellInfo,
): Record<string, unknown> {
  return {
    file_path: writeInfo.filePath,
    content: writeInfo.content,
  };
}

function parseRipgrepCommand(command: string): Record<string, unknown> | null {
  const tokens = tokenizeShellCommand(command);
  if (tokens[0] !== "rg" || tokens.length < 2) {
    return null;
  }

  if (
    tokens.some((token) => token === "|" || token === "&&" || token === ";")
  ) {
    return null;
  }

  const flagsWithValue = new Set([
    "-g",
    "--glob",
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-m",
    "--max-count",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "-t",
    "--type",
    "-T",
    "--type-not",
  ]);

  let pattern = "";
  const searchPaths: string[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token === "--") {
      const rest = tokens.slice(i + 1).filter(Boolean);
      if (!pattern && rest[0]) {
        pattern = rest[0];
      }
      if (pattern) {
        searchPaths.push(...rest.slice(1));
      }
      break;
    }

    if (token === "-e" || token === "--regexp") {
      const next = tokens[i + 1];
      if (next && !pattern) {
        pattern = next;
      }
      i += 1;
      continue;
    }

    if (flagsWithValue.has(token)) {
      i += 1;
      continue;
    }

    if (token.startsWith("--glob=") || token.startsWith("--regexp=")) {
      if (token.startsWith("--regexp=") && !pattern) {
        pattern = token.slice("--regexp=".length);
      }
      continue;
    }

    if (token.startsWith("-")) {
      continue;
    }

    if (!pattern) {
      pattern = token;
    } else {
      searchPaths.push(token);
    }
  }

  if (!pattern) {
    return null;
  }

  const input: Record<string, unknown> = {
    pattern,
    output_mode: "content",
  };
  if (searchPaths.length > 0) {
    input.path = searchPaths.join(" ");
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseNumericExitCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function extractExitCodeFromRecord(
  record: Record<string, unknown>,
): number | undefined {
  const direct = parseNumericExitCode(record.exit_code ?? record.exitCode);
  if (direct !== undefined) {
    return direct;
  }

  const metadata = record.metadata;
  if (isRecord(metadata)) {
    const nested = parseNumericExitCode(
      metadata.exit_code ?? metadata.exitCode,
    );
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function hasFailedStatus(record: Record<string, unknown>): boolean {
  const status = record.status;
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.toLowerCase();
  return normalized === "failed" || normalized === "error";
}

function extractExitCodeFromText(output: string): number | undefined {
  const match = output.match(
    /(?:^|\n)\s*(?:Exit code:|Process exited with code)\s*(-?\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

export function extractCodexBackgroundTaskId(
  output: unknown,
): string | undefined {
  if (typeof output !== "string") {
    return undefined;
  }
  const match = output.match(
    /(?:^|\n)\s*(?:Process\s+running\s+with\s+session\s+ID|session(?:\s+id)?)\s*:?\s*(\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return match[1];
}

export function isCodexBackgroundProcessOutput(output: unknown): boolean {
  if (typeof output !== "string") {
    return false;
  }
  return (
    extractCodexBackgroundTaskId(output) !== undefined &&
    extractExitCodeFromText(output) === undefined
  );
}

export function isCodexInterruptedToolOutput(output: unknown): boolean {
  return (
    typeof output === "string" &&
    /(?:^|\n)\s*(?:aborted by user|interrupted by user)(?:\s|$)/i.test(output)
  );
}

function extractSessionIdFromText(output: string): number | undefined {
  const taskId = extractCodexBackgroundTaskId(output);
  if (!taskId) {
    return undefined;
  }
  return Number.parseInt(taskId, 10);
}

function normalizeCodexToolOutput(
  output: unknown,
): NormalizedCodexToolOutputWithExitCode {
  if (typeof output === "string") {
    let structured: unknown;
    let isError = false;
    let content = output;
    let exitCode: number | undefined;

    try {
      structured = JSON.parse(output);
      if (typeof structured === "string") {
        const sanitized = sanitizeInlineImageData(structured);
        content =
          typeof sanitized.value === "string" ? sanitized.value : structured;
        structured = sanitized.value;
        exitCode = extractExitCodeFromText(content);
        if (exitCode !== undefined) {
          isError = exitCode !== 0;
        }
      } else if (isRecord(structured)) {
        const sanitized = sanitizeInlineImageData(structured);
        const record = isRecord(sanitized.value)
          ? sanitized.value
          : structured;
        if (sanitized.changed) {
          structured = record;
          content = JSON.stringify(record, null, 2);
        }
        exitCode = extractExitCodeFromRecord(record);
        isError =
          record.is_error === true ||
          (exitCode !== undefined && exitCode !== 0) ||
          hasFailedStatus(record);
      } else if (Array.isArray(structured)) {
        const sanitized = sanitizeInlineImageData(structured);
        if (sanitized.changed) {
          structured = sanitized.value;
          content = JSON.stringify(structured, null, 2);
        }
      }
    } catch {
      structured = undefined;
      const sanitized = sanitizeInlineImageText(output);
      content = sanitized.value;
      exitCode = extractExitCodeFromText(content);
      if (exitCode !== undefined) {
        isError = exitCode !== 0;
      } else {
        isError = /(?:^|\n)\s*(error|fatal|failed):/i.test(content);
      }
    }

    return { content, structured, isError, exitCode };
  }

  if (output === null || output === undefined) {
    return { content: "", isError: false };
  }

  if (typeof output === "number" || typeof output === "boolean") {
    return {
      content: String(output),
      structured: output,
      isError: false,
    };
  }

  if (Array.isArray(output) || isRecord(output)) {
    const sanitized = sanitizeInlineImageData(output);
    const structured = sanitized.value;
    const exitCode = isRecord(structured)
      ? extractExitCodeFromRecord(structured)
      : undefined;
    const isError =
      isRecord(structured) &&
      (structured.is_error === true ||
        (exitCode ?? 0) !== 0 ||
        hasFailedStatus(structured));
    return {
      content: JSON.stringify(structured, null, 2),
      structured,
      isError,
      exitCode,
    };
  }

  return { content: String(output), isError: false };
}

function sanitizeInlineImageData(value: unknown): {
  value: unknown;
  changed: boolean;
} {
  if (typeof value === "string") {
    return sanitizeInlineImageText(value);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const sanitized = value.map((item) => {
      const result = sanitizeInlineImageData(item);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: sanitized, changed } : { value, changed };
  }

  if (!isRecord(value)) {
    return { value, changed: false };
  }

  let changed = false;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const result = sanitizeInlineImageData(item);
    changed ||= result.changed;
    sanitized[key] = result.value;
  }

  return changed ? { value: sanitized, changed } : { value, changed };
}

function sanitizeInlineImageText(value: string): {
  value: string;
  changed: boolean;
} {
  if (!value.includes("data:image/")) {
    return { value, changed: false };
  }

  if (value.startsWith("data:image/")) {
    return { value: summarizeInlineImageDataUrl(value), changed: true };
  }

  const replaced = value.replace(INLINE_IMAGE_DATA_URL_GLOBAL_RE, (match) =>
    summarizeInlineImageDataUrl(match),
  );
  return { value: replaced, changed: replaced !== value };
}

function summarizeInlineImageDataUrl(value: string): string {
  const match = INLINE_IMAGE_DATA_URL_PREFIX_RE.exec(value);
  const mimeType = match?.[1]?.toLowerCase() ?? "image/*";
  const commaIndex = value.indexOf(",");
  const payload = commaIndex >= 0 ? value.slice(commaIndex + 1) : "";
  const bytes = estimateDataUrlPayloadBytes(value, payload);
  return `[inline ${mimeType} data omitted${
    bytes !== undefined ? `, ${formatByteSize(bytes)}` : ""
  }]`;
}

function estimateDataUrlPayloadBytes(
  dataUrl: string,
  payload: string,
): number | undefined {
  if (!payload) return undefined;

  const header = dataUrl.slice(0, Math.max(0, dataUrl.indexOf(",")));
  if (!/;base64(?:;|$)/i.test(header)) {
    try {
      return decodeURIComponent(payload).length;
    } catch {
      return payload.length;
    }
  }

  const sanitized = payload.replace(/\s+/g, "");
  const padding = sanitized.endsWith("==")
    ? 2
    : sanitized.endsWith("=")
      ? 1
      : 0;
  return Math.max(0, Math.floor((sanitized.length * 3) / 4) - padding);
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
}

function extractCodexShellOutputContent(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const inlineMarker = "Output:\n";
  if (normalized.startsWith(inlineMarker)) {
    return normalized.slice(inlineMarker.length);
  }

  const marker = "\nOutput:\n";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) {
    return normalized;
  }

  const rawOutput = normalized.slice(markerIndex + marker.length);
  return rawOutput.startsWith("\n") ? rawOutput.slice(1) : rawOutput;
}

function createBashToolResult(
  output: string,
  isError: boolean,
  backgroundTaskId?: string,
  interrupted = false,
): {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage: false;
  backgroundTaskId?: string;
} {
  return {
    stdout: interrupted || isError ? "" : output,
    stderr: interrupted ? "" : isError ? output : "",
    interrupted,
    isImage: false,
    ...(backgroundTaskId ? { backgroundTaskId } : {}),
  };
}

function normalizeRipgrepOutput(output: string): {
  mode: "files_with_matches" | "content";
  filenames: string[];
  numFiles: number;
  content?: string;
  numLines?: number;
} {
  const normalized = output.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!normalized.trim()) {
    return {
      mode: "files_with_matches",
      filenames: [],
      numFiles: 0,
    };
  }

  const lines = normalized.split("\n");
  const hasLineBasedMatches = lines.some(
    (line) => /^.+:\d+(?::|-)/.test(line) || /^\d+(?::|-)/.test(line),
  );

  if (hasLineBasedMatches) {
    const filenames = Array.from(
      new Set(
        lines
          .map(extractFilenameFromRipgrepLine)
          .filter((file): file is string => !!file),
      ),
    );

    const numFiles = filenames.length > 0 ? filenames.length : 1;
    return {
      mode: "content",
      filenames,
      numFiles,
      content: normalized,
      numLines: lines.length,
    };
  }

  const filenames = Array.from(
    new Set(lines.map((line) => line.trim()).filter((line) => line.length > 0)),
  );
  return {
    mode: "files_with_matches",
    filenames,
    numFiles: filenames.length,
  };
}

function extractFilenameFromRipgrepLine(line: string): string | null {
  const match = line.match(/^(.+?):\d+(?::|-)/);
  if (match?.[1]) {
    return match[1];
  }
  return null;
}

function normalizeReadOutput(
  output: string,
  readInfo: CodexReadShellInfo,
): {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
} {
  const normalized = output.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let startLine = readInfo.startLine ?? 1;

  const contentLines = readInfo.stripLineNumbers
    ? lines.map((line, index) => {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (match?.[1]) {
          if (index === 0) {
            startLine = Number.parseInt(match[1], 10);
          }
          return match[2] ?? "";
        }
        return line;
      })
    : lines;

  const content = contentLines.join("\n");
  const numLines = countContentLines(content);
  const computedEndLine =
    numLines > 0 ? startLine + numLines - 1 : (readInfo.endLine ?? startLine);
  const totalLines = Math.max(
    readInfo.endLine ?? computedEndLine,
    computedEndLine,
  );

  return {
    type: "text",
    file: {
      filePath: readInfo.filePath,
      content,
      numLines,
      startLine,
      totalLines,
    },
  };
}

function normalizeWriteOutput(writeInfo: CodexWriteShellInfo): {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
} {
  const numLines = countContentLines(writeInfo.content);
  return {
    type: "text",
    file: {
      filePath: writeInfo.filePath,
      content: writeInfo.content,
      numLines,
      startLine: 1,
      totalLines: numLines,
    },
  };
}

function countContentLines(content: string): number {
  if (!content) {
    return 0;
  }

  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

function stripOuterQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return value.slice(1, -1);
  }

  return value;
}
