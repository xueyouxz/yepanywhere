import type { ReactNode } from "react";

/**
 * Extended content block with all possible fields from Claude messages
 */
export interface ContentBlock {
  type: string;
  // text block
  text?: string;
  // thinking block
  thinking?: string;
  signature?: string; // Hidden from display
  // tool_use block
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result block
  tool_use_id?: string;
  content?: string | ContentBlock[];
  summary?: Array<string | { type?: string; text?: string }>;
  is_error?: boolean;
}

/**
 * Context passed to every renderer
 */
export interface RenderContext {
  /** True if message is still being streamed */
  isStreaming: boolean;
  /** Current theme */
  theme: "light" | "dark";
  /** Tool use ID (for Task renderer to look up agentId mapping during streaming) */
  toolUseId?: string;
  /** Lookup tool_use by ID (for tool_result rendering) */
  getToolUse?: (id: string) => { name: string; input: unknown } | undefined;
  /** Structured tool result data (from message.toolUseResult) */
  toolUseResult?: unknown;
  /** Whether thinking blocks are expanded (shared state) */
  thinkingExpanded?: boolean;
  /** Toggle thinking blocks expanded state */
  toggleThinkingExpanded?: () => void;
  /** Provider type - tool renderers may use fallback rendering for non-Claude providers */
  provider?: string;
  /** Absolute session project path, used for compact file path display */
  projectPath?: string | null;
  /** Expanded state for a renderer-owned row summary outline. */
  summaryExpanded?: boolean;
  /** Toggle a renderer-owned row summary outline. */
  toggleSummaryExpanded?: () => void;
}

/**
 * Content block renderer interface
 */
export interface ContentRenderer<T extends ContentBlock = ContentBlock> {
  /** Block type(s) this renderer handles */
  type: string | string[];
  /** Render the block */
  render(block: T, context: RenderContext): ReactNode;
  /** Optional summary for collapsed view */
  getSummary?(block: T): string;
}
