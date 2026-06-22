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
 * `old_string`/`new_string` so the common case gets the diff augment (there is
 * no MultiEdit renderer, so multi-edit keeps the array and renders by name).
 */

export interface NormalizedPiTool {
  /** Canonical YA renderer tool name (e.g. "Edit"), or the original name. */
  name: string;
  /** Input with field names mapped to the YA renderer's expectations. */
  input: Record<string, unknown>;
}

/** pi lower-case tool name -> YA canonical renderer name. */
const PI_TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
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

/**
 * Map a pi tool name + raw input to YA's canonical name + input.
 */
export function normalizePiTool(
  toolName: string | undefined,
  rawInput: unknown,
): NormalizedPiTool {
  const original = toolName ?? "unknown";
  const name = PI_TOOL_NAME_MAP[original] ?? original;
  let input = asRecord(rawInput);
  const renames = PI_TOOL_FIELD_RENAMES[name];
  if (renames) {
    input = renameFields(input, renames);
  }
  if (name === "Edit") {
    input = expandSinglePiEdit(input);
  }
  return { name, input };
}
