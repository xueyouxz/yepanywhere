/**
 * Render terminal output with ANSI CSI SGR escape codes into safe HTML.
 *
 * Supports the 16 basic colors (fg/bg), bright variants, and attributes
 * (bold, italic, underline, inverse, strikethrough). 256-color and
 * truecolor SGR sequences are parsed for correct stream offset, but the
 * color falls back to the current default (attributes still apply).
 * Non-SGR escape sequences (cursor moves, OSC, etc.) are stripped. HTML
 * special characters in the payload are escaped.
 *
 * Hand-rolled rather than pulled from a dep; see DEVELOPMENT.md
 * Contribution Ethos.
 */

const BASIC_COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

interface SgrState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strikethrough: boolean;
}

function emptyState(): SgrState {
  return {
    fg: null,
    bg: null,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    strikethrough: false,
  };
}

function stateClasses(state: SgrState): string[] {
  const classes: string[] = [];
  // ANSI "reverse video" semantically swaps fg/bg for the duration.
  const fg = state.inverse ? state.bg : state.fg;
  const bg = state.inverse ? state.fg : state.bg;
  if (fg) classes.push(`ansi-fg-${fg}`);
  if (bg) classes.push(`ansi-bg-${bg}`);
  if (state.inverse && !fg && !bg) classes.push("ansi-inverse");
  if (state.bold) classes.push("ansi-bold");
  if (state.italic) classes.push("ansi-italic");
  if (state.underline) classes.push("ansi-underline");
  if (state.strikethrough) classes.push("ansi-strikethrough");
  return classes;
}

function applySgr(state: SgrState, params: number[]): void {
  let i = 0;
  while (i < params.length) {
    const p = params[i] ?? 0;
    if (p === 0) {
      Object.assign(state, emptyState());
    } else if (p === 1) state.bold = true;
    else if (p === 3) state.italic = true;
    else if (p === 4) state.underline = true;
    else if (p === 7) state.inverse = true;
    else if (p === 9) state.strikethrough = true;
    else if (p === 22) state.bold = false;
    else if (p === 23) state.italic = false;
    else if (p === 24) state.underline = false;
    else if (p === 27) state.inverse = false;
    else if (p === 29) state.strikethrough = false;
    else if (p >= 30 && p <= 37) state.fg = BASIC_COLORS[p - 30] ?? null;
    else if (p === 38) {
      // Extended color: 38;5;N (indexed) or 38;2;R;G;B (truecolor).
      // Advance past the sub-params; fall back to default color.
      const kind = params[i + 1];
      if (kind === 5) i += 2;
      else if (kind === 2) i += 4;
      state.fg = null;
    } else if (p === 39) state.fg = null;
    else if (p >= 40 && p <= 47) state.bg = BASIC_COLORS[p - 40] ?? null;
    else if (p === 48) {
      const kind = params[i + 1];
      if (kind === 5) i += 2;
      else if (kind === 2) i += 4;
      state.bg = null;
    } else if (p === 49) state.bg = null;
    else if (p >= 90 && p <= 97) {
      state.fg = `bright-${BASIC_COLORS[p - 90]}`;
    } else if (p >= 100 && p <= 107) {
      state.bg = `bright-${BASIC_COLORS[p - 100]}`;
    }
    // Unknown params are ignored.
    i++;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const CSI_PARAM_RE = /[\d;:?\s]/;

/** True if text contains any ANSI CSI introducer. */
export function hasAnsiEscapes(text: string): boolean {
  return text.indexOf("\x1b[") !== -1;
}

/**
 * Render ANSI-colored text to HTML. Output is a sequence of escaped text
 * runs and `<span class="ansi-...">` wrappers; it contains no inline
 * styles, script, or unrecognized tags.
 */
export function renderAnsiToHtml(text: string): string {
  const state = emptyState();
  let out = "";
  let pending = "";
  let i = 0;

  const flushPending = (): void => {
    if (pending.length === 0) return;
    const classes = stateClasses(state);
    if (classes.length > 0) {
      out += `<span class="${classes.join(" ")}">${escapeHtml(pending)}</span>`;
    } else {
      out += escapeHtml(pending);
    }
    pending = "";
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === "\x1b" && text[i + 1] === "[") {
      // CSI sequence. Collect parameter bytes until a final byte.
      flushPending();
      let j = i + 2;
      let paramStr = "";
      while (j < text.length && CSI_PARAM_RE.test(text[j] ?? "")) {
        paramStr += text[j];
        j++;
      }
      const final = text[j] ?? "";
      if (final === "m") {
        const params =
          paramStr.length > 0
            ? paramStr.split(";").map((p) => parseInt(p, 10) || 0)
            : [0];
        applySgr(state, params);
      }
      // Non-SGR CSI (cursor moves, erases, etc.) are simply dropped.
      i = j + (final ? 1 : 0);
    } else if (ch === "\x1b" && text[i + 1] === "]") {
      // OSC sequence: strip until BEL (\x07) or ST (ESC \\).
      flushPending();
      let j = i + 2;
      while (j < text.length) {
        const cj = text[j];
        if (cj === "\x07") {
          j++;
          break;
        }
        if (cj === "\x1b" && text[j + 1] === "\\") {
          j += 2;
          break;
        }
        j++;
      }
      i = j;
    } else if (ch === "\x1b") {
      // Bare ESC or unrecognized introducer: drop ESC + next byte.
      flushPending();
      i += text[i + 1] !== undefined ? 2 : 1;
    } else {
      pending += ch;
      i++;
    }
  }
  flushPending();
  return out;
}
