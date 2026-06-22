import { extractRawPatchFromEditInput } from "../../augments/edit-raw-patch.js";

/**
 * Normalize pi tool calls to YA's canonical tool renderer contract.
 *
 * pi names tools in lower case (`read`, `edit`, `write`, `bash`, `grep`, `ls`)
 * and uses its own input field names (`path`, `edits[]` of `{oldText,newText}`).
 * YA's rich tool renderers key on canonical names (`Read`, `Edit`, …) and
 * Claude-style fields (`file_path`, `old_string`, `new_string`). This module
 * maps both so pi tool calls reach the rich renderers (and Edit gets the diff
 * augment) instead of the raw-JSON fallback — the same shared-normalizer shape
 * opencode-tools.ts / gemini-tools.ts use.
 *
 * Field renames are keyed by the *canonical* name, deliberately: pi `grep` uses
 * `path` and so does Claude's Grep, so `path` must NOT be renamed there — only
 * Read/Write/Edit map `path` → `file_path`. pi `edit` is an array of disjoint
 * `{oldText,newText}` replacements; a single-element array is expanded to
 * `old_string`/`new_string` so the common case gets the diff augment. A
 * non-vanilla pi `apply_patch` tool is treated like Codex `apply_patch`: its
 * patch payload maps to canonical `Edit` raw-patch fields, with no effect on
 * vanilla pi sessions that never emit that tool.
 */

export interface NormalizedPiTool {
  /** Canonical YA renderer tool name (e.g. "Edit"), or the original name. */
  name: string;
  /** Input with field names mapped to the YA renderer's expectations. */
  input: Record<string, unknown>;
}

export interface PiToolState {
  input: Record<string, unknown>;
  name: string;
}

interface PiTextFile {
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
}

interface PiToolResultPayload {
  content?: unknown;
  details?: unknown;
}

/** pi lower-case tool name -> YA canonical renderer name. */
const PI_TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  bash: "Bash",
  grep: "Grep",
  ls: "LS",
};

/** Per-canonical-tool input field renames (pi field -> YA/Claude field). */
const PI_TOOL_FIELD_RENAMES: Record<string, Record<string, string>> = {
  Read: { path: "file_path" },
  Write: { path: "file_path" },
  Edit: { path: "file_path" },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = maybeRecord(block);
        return b?.type === "text" && typeof b.text === "string" ? b.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function stringifyPiToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  const record = maybeRecord(result);
  if (record?.content !== undefined) {
    const text = textFromContent(record.content);
    if (text) return text;
  }
  const directText = textFromContent(result);
  if (directText) return directText;
  try {
    return JSON.stringify(result ?? "");
  } catch {
    return String(result ?? "");
  }
}

function renameFields(
  input: Record<string, unknown>,
  renames: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[renames[key] ?? key] = value;
  }
  return out;
}

/**
 * Expand a single-element pi `edits[]` into Claude `old_string`/`new_string`
 * so the diff augment engages. Multi-element edits keep the array unchanged.
 */
function expandSinglePiEdit(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const edits = input.edits;
  if (!Array.isArray(edits) || edits.length !== 1) {
    return input;
  }
  const edit = edits[0];
  if (!edit || typeof edit !== "object") {
    return input;
  }
  const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown };
  const out = { ...input };
  if (typeof oldText === "string") out.old_string = oldText;
  if (typeof newText === "string") out.new_string = newText;
  return out;
}

function attachRawPatchToInput(
  input: Record<string, unknown>,
  rawInput: unknown,
): Record<string, unknown> {
  const rawPatch =
    extractRawPatchFromEditInput(rawInput) ??
    extractRawPatchFromEditInput(input);
  if (!rawPatch) return input;
  const out = { ...input };
  if (!out.rawPatch) out.rawPatch = rawPatch;
  if (!out._rawPatch) out._rawPatch = rawPatch;
  return out;
}

function numberField(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringField(
  input: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

function textLineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function makeTextFileResult(
  filePath: string,
  content: string,
  startLine: number,
): { type: "text"; file: PiTextFile } {
  const numLines = textLineCount(content);
  return {
    type: "text",
    file: {
      filePath,
      content,
      numLines,
      startLine,
      totalLines: startLine + Math.max(0, numLines - 1),
    },
  };
}

function resultPayload(rawResult: unknown): PiToolResultPayload {
  const record = maybeRecord(rawResult);
  if (!record) return { content: rawResult };
  return {
    content: record.content ?? rawResult,
    details: record.details,
  };
}

export function attachPiResultDetailToToolInput(
  toolName: string,
  input: Record<string, unknown>,
  rawResult: unknown,
): void {
  if (toolName !== "Edit") return;
  const details = maybeRecord(resultPayload(rawResult).details);
  const patch = stringField(details, "patch");
  if (!patch) return;
  if (!input.rawPatch) {
    input.rawPatch = patch;
  }
  if (!input._rawPatch) {
    input._rawPatch = patch;
  }
}

/**
 * Map a pi tool name + raw input to YA's canonical name + input.
 */
export function normalizePiTool(
  toolName: string | undefined,
  rawInput: unknown,
): NormalizedPiTool {
  const original = toolName ?? "unknown";
  const name =
    PI_TOOL_NAME_MAP[original] ??
    PI_TOOL_NAME_MAP[original.toLowerCase()] ??
    original;
  let input = asRecord(rawInput);
  const renames = PI_TOOL_FIELD_RENAMES[name];
  if (renames) {
    input = renameFields(input, renames);
  }
  if (name === "Edit") {
    input = attachRawPatchToInput(input, rawInput);
    input = expandSinglePiEdit(input);
  }
  return { name, input };
}

export function normalizePiToolResult(
  toolName: string,
  rawResult: unknown,
  toolInput?: Record<string, unknown>,
  isError = false,
): unknown {
  const canonicalName =
    PI_TOOL_NAME_MAP[toolName] ??
    PI_TOOL_NAME_MAP[toolName.toLowerCase()] ??
    toolName;
  const payload = resultPayload(rawResult);
  const text = stringifyPiToolResult(payload.content);

  if (isError) {
    return text;
  }

  switch (canonicalName) {
    case "Bash":
      return {
        stdout: text,
        stderr: "",
        interrupted: false,
        isImage: false,
      };
    case "Read": {
      const filePath = stringField(toolInput, "file_path") ?? "";
      const startLine = numberField(toolInput ?? {}, "offset") ?? 1;
      return makeTextFileResult(filePath, text, startLine);
    }
    case "Write": {
      const filePath = stringField(toolInput, "file_path") ?? "";
      const content = stringField(toolInput, "content") ?? text;
      return makeTextFileResult(filePath, content, 1);
    }
    case "Edit":
      return {
        filePath: stringField(toolInput, "file_path") ?? "",
        oldString: stringField(toolInput, "old_string") ?? "",
        newString: stringField(toolInput, "new_string") ?? "",
        originalFile: "",
        replaceAll: toolInput?.replace_all === true,
        userModified: false,
        structuredPatch: [],
        piText: text,
        piDetails: payload.details,
      };
    default:
      return undefined;
  }
}
