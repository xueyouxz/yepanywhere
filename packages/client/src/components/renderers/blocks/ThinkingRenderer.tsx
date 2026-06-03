import { useState } from "react";
import type { ContentBlock, ContentRenderer, RenderContext } from "../types";

interface ThinkingBlock extends ContentBlock {
  type: "thinking" | "reasoning" | "reasoning_text" | "summary_text";
  thinking?: string;
  text?: string;
  summary?: Array<string | { type?: string; text?: string }>;
  signature?: string; // Never rendered
}

function extractThinkingText(block: ThinkingBlock): string {
  if (typeof block.thinking === "string") {
    return block.thinking;
  }
  const summaryText = block.summary
    ?.map((entry) => (typeof entry === "string" ? entry : entry.text))
    .filter((text): text is string => typeof text === "string")
    .join("\n")
    .trim();
  if (summaryText) {
    return summaryText;
  }
  if (typeof block.text === "string") {
    return block.text;
  }
  return "";
}

/**
 * Thinking renderer - collapsible block with shared expanded state across all blocks
 */
function ThinkingRendererComponent({
  block,
  context,
}: {
  block: ThinkingBlock;
  context: RenderContext;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const thinking = extractThinkingText(block);
  const isExpanded = context.thinkingExpanded ?? localExpanded;
  const toggleThinkingExpanded =
    context.toggleThinkingExpanded ?? (() => setLocalExpanded((prev) => !prev));

  if (isExpanded) {
    // Expanded: whole block is clickable to collapse
    return (
      <button
        type="button"
        className="thinking-block thinking-block-expanded"
        onClick={toggleThinkingExpanded}
        aria-expanded={true}
      >
        <div className="thinking-toggle-expanded">
          <span className="thinking-label">Thinking</span>
          <span className="thinking-icon">▲</span>
        </div>
        <div className="thinking-content">{thinking}</div>
      </button>
    );
  }

  // Collapsed: small inline button with pulsing when streaming
  const collapsedClass = context.isStreaming
    ? "thinking-block thinking-streaming-collapsed"
    : "thinking-block";

  return (
    <div className={collapsedClass}>
      <button
        type="button"
        className="thinking-toggle-collapsed"
        onClick={toggleThinkingExpanded}
        aria-expanded={false}
      >
        <span className="thinking-label">
          {context.isStreaming ? "Thinking..." : "Thinking"}
        </span>
        <span className="thinking-icon">▼</span>
      </button>
    </div>
  );
}

export const thinkingRenderer: ContentRenderer<ThinkingBlock> = {
  type: ["thinking", "reasoning", "reasoning_text", "summary_text"],
  render(block, context) {
    return (
      <ThinkingRendererComponent
        block={block as ThinkingBlock}
        context={context}
      />
    );
  },
  getSummary(block) {
    const thinking = extractThinkingText(block as ThinkingBlock);
    const firstLine = thinking.split("\n")[0] || "";
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  },
};
