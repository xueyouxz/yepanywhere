/**
 * Recent-activity excerpt helpers for the session hover card: derive the "last
 * regular agent turn" line shown beneath the meta row. Shared so every path
 * (the Claude summary/fast-scan and the provider-independent normalized-message
 * path) produces identical output. See topics/session-hovercard-recent-activity.md.
 */
import { isIdeMetadata, stripIdeMetadata } from "@yep-anywhere/shared";
import type { Message } from "../supervisor/types.js";

// The excerpt keeps only the tail of the latest turn (where an agent's
// conclusion/question lands) and caps length, so the session index stays small.
// CSS line-clamp shows the *first* N lines, so the "last N" selection has to
// happen here, at the data layer, not in the view.
const AGENT_EXCERPT_MAX_LINES = 3;
const AGENT_EXCERPT_MAX_CHARS = 280;

/**
 * Conservative markdown de-noise for one line: drop a leading list/heading/
 * quote marker and strip bold/backtick clutter that reads as noise in a
 * tooltip. Single `*`/`_` are left alone to avoid mangling prose and
 * identifiers — full markdown rendering is deliberately out of scope here.
 */
function stripLightMarkdown(line: string): string {
  return line
    .replace(/^\s{0,3}(?:[-*+]\s+|#{1,6}\s+|\d+\.\s+|>\s?)/, "")
    .replace(/\*\*/g, "")
    .replace(/`+/g, "");
}

/**
 * Reduce raw agent-turn text to the hover-card excerpt: strip IDE metadata,
 * lightly strip markdown, collapse blank lines, keep the last few lines, and
 * cap length favoring the end. Returns "" when there is no displayable prose.
 */
export function formatAgentExcerpt(raw: string): string {
  const lines = stripIdeMetadata(raw)
    .split("\n")
    .map((line) => stripLightMarkdown(line).trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";
  let excerpt = lines.slice(-AGENT_EXCERPT_MAX_LINES).join("\n").trim();
  if (excerpt.length > AGENT_EXCERPT_MAX_CHARS) {
    excerpt = `…${excerpt.slice(-AGENT_EXCERPT_MAX_CHARS).trimStart()}`;
  }
  return excerpt;
}

/**
 * Pull the prose text and the first tool name from an assistant message's
 * content (string or block array), skipping IDE metadata. Works on both raw
 * Claude entries and the normalized cross-provider `Message` content, which
 * share the `{ type: "text", text }` / `{ type: "tool_use", name }` block shape.
 */
export function assistantContentParts(content: unknown): {
  text: string;
  toolName?: string;
} {
  if (content == null) return { text: "" };
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const blocks = content as Array<{
    type?: string;
    text?: string;
    name?: string;
  }>;
  const text = blocks
    .filter(
      (b): b is { type: "text"; text: string } =>
        b?.type === "text" &&
        typeof b.text === "string" &&
        !isIdeMetadata(b.text),
    )
    .map((b) => b.text)
    .join("\n");
  const tool = blocks.find(
    (b) => b?.type === "tool_use" && typeof b.name === "string",
  );
  return { text, toolName: tool?.name };
}

/**
 * Provider-independent recent-activity excerpt from normalized messages (the
 * uniform `Message[]` every provider's reader produces via `normalizeSession`).
 * Scans backward for the latest assistant message carrying prose; falls back to
 * an earlier text block, then to a "⚙ <tool>" label when the latest turns are
 * tool-only. Mirrors the Claude fast path so output is identical across
 * providers.
 */
export function extractLastAgentExcerpt(
  messages: Message[],
): string | undefined {
  let trailingTool: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const isAssistant =
      m?.type === "assistant" || m?.message?.role === "assistant";
    if (!isAssistant) continue;
    const { text, toolName } = assistantContentParts(m.message?.content);
    const excerpt = formatAgentExcerpt(text);
    if (excerpt) return excerpt;
    if (!trailingTool && toolName) trailingTool = toolName;
  }
  return trailingTool ? `⚙ ${trailingTool}` : undefined;
}
