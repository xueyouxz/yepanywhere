import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRenderModeToggle } from "../../contexts/RenderModeContext";
import { useStreamingMarkdownContext } from "../../contexts/StreamingMarkdownContext";
import { useStreamingMarkdown } from "../../hooks/useStreamingMarkdown";
import { registerMarkdownCopySource } from "../../lib/markdownSelectionCopy";
import {
  LocalMediaModal,
  useLocalMediaClick,
  useLocalMediaInlinePreviews,
} from "../LocalMediaModal";
import { renderFixedFontMath } from "../ui/FixedFontMathToggle";
import { RenderModeGlyph } from "../ui/RenderModeGlyph";

const EMPTY_LOCAL_MATH_PREVIEW = { html: "", changed: false };

function htmlToText(html: string): string {
  if (typeof document === "undefined") {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.textContent ?? "";
}

interface Props {
  text: string;
  isStreaming?: boolean;
  /** Pre-rendered HTML from server (for completed messages) */
  augmentHtml?: string;
}

export const TextBlock = memo(function TextBlock({
  text,
  isStreaming = false,
  augmentHtml,
}: Props) {
  const [copied, setCopied] = useState(false);
  const copySourceRef = useRef<HTMLDivElement>(null);
  const localMathPreview = useMemo(
    () => (isStreaming ? EMPTY_LOCAL_MATH_PREVIEW : renderFixedFontMath(text)),
    [isStreaming, text],
  );
  const serverMarkdownChanged = useMemo(() => {
    if (!augmentHtml) return false;
    return htmlToText(augmentHtml).trim() !== text.trim();
  }, [augmentHtml, text]);

  // Streaming markdown hook for server-rendered content
  const streamingMarkdown = useStreamingMarkdown();
  const streamingContext = useStreamingMarkdownContext();

  // Track whether we're actively using streaming markdown (received at least one augment)
  const [useStreamingContent, setUseStreamingContent] = useState(false);

  // Register with context when streaming and context is available
  useEffect(() => {
    if (!isStreaming || !streamingContext) {
      // Reset streaming state when not streaming
      // (HTML is captured to markdownAugments before component remounts)
      if (!isStreaming) {
        setUseStreamingContent(false);
        streamingMarkdown.reset();
      }
      return;
    }

    // Register handlers with the context
    const unregister = streamingContext.registerStreamingHandler({
      onAugment: (augment) => {
        // Mark that we're using streaming content on first augment
        setUseStreamingContent((current) => (current ? current : true));
        streamingMarkdown.onAugment(augment);
      },
      onPending: streamingMarkdown.onPending,
      onStreamEnd: streamingMarkdown.onStreamEnd,
      captureHtml: streamingMarkdown.captureHtml,
    });

    return unregister;
  }, [
    isStreaming,
    streamingContext,
    streamingMarkdown.captureHtml,
    streamingMarkdown.onAugment,
    streamingMarkdown.onPending,
    streamingMarkdown.onStreamEnd,
    streamingMarkdown.reset,
  ]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      console.error("Failed to copy text:", err);
    }
  }, [text]);

  useEffect(() => {
    const element = copySourceRef.current;
    if (!element) {
      return;
    }

    return registerMarkdownCopySource(element, text);
  }, [text]);

  const { modal, handleClick, closeModal } = useLocalMediaClick();
  useLocalMediaInlinePreviews(copySourceRef);

  const showStreamingContent = isStreaming && useStreamingContent;
  const canToggleRendered = serverMarkdownChanged || localMathPreview.changed;
  const { showRendered, toggleLocalMode } = useRenderModeToggle(canToggleRendered, {
    resetDependencies: [isStreaming, isStreaming ? "" : text, augmentHtml ?? ""],
  });

  // Always render streaming container when isStreaming so refs are attached
  // before first augment arrives. Hidden until useStreamingContent becomes true.
  const renderStreamingContainer = isStreaming;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click handler intercepts local media links only
    <div
      className={`text-block text-block-assistant timeline-item${isStreaming ? " streaming" : ""}`}
    >
      <div className="text-block-actions">
        {canToggleRendered && (
          <button
            type="button"
            className={`text-block-toggle ${showRendered ? "is-rendered" : ""}`}
            onClick={toggleLocalMode}
            title={showRendered ? "Show source" : "Show rendered"}
            aria-label={showRendered ? "Show source" : "Show rendered"}
            aria-pressed={showRendered}
          >
            <RenderModeGlyph />
          </button>
        )}
        <button
          type="button"
          className={`text-block-copy ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy markdown"}
          aria-label={copied ? "Copied!" : "Copy markdown"}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>

      <div ref={copySourceRef} className="text-block-content" onClick={handleClick}>
        {/* Always render streaming elements when streaming so refs are ready for augments */}
        {renderStreamingContainer && (
          <div
            style={
              showStreamingContent && showRendered ? undefined : { display: "none" }
            }
          >
            <div
              ref={streamingMarkdown.containerRef}
              className="streaming-blocks"
            />
            <span ref={streamingMarkdown.pendingRef} className="streaming-pending" />
          </div>
        )}

        {/* Show fallback content when not actively streaming */}
        {!showStreamingContent &&
          (showRendered && augmentHtml ? (
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            <div dangerouslySetInnerHTML={{ __html: augmentHtml }} />
          ) : showRendered && localMathPreview.changed ? (
            <div
              className="text-block-local-rendered"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted HTML from local rendering
              dangerouslySetInnerHTML={{ __html: localMathPreview.html }}
            />
          ) : (
            <pre className="text-block-source">
              <code>{text}</code>
            </pre>
          ))}
      </div>

      {modal && (
        <LocalMediaModal
          path={modal.path}
          mediaType={modal.mediaType}
          onClose={closeModal}
        />
      )}
    </div>
  );
});

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5L6.5 12L13 4" />
    </svg>
  );
}
