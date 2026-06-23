import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRenderModeToggle } from "../../contexts/RenderModeContext";
import {
  createCommentAnchor,
  type CommentAnchor,
} from "../../lib/commentAnchors";
import { useStreamingMarkdownContext } from "../../contexts/StreamingMarkdownContext";
import { useStreamingMarkdown } from "../../hooks/useStreamingMarkdown";
import { useI18n } from "../../i18n";
import {
  getMarkdownSnippetForElement,
  getMarkdownSnippetForSubElement,
  registerMarkdownCopySource,
} from "../../lib/markdownSelectionCopy";
import { FileViewerModal } from "../FilePathLink";
import {
  LocalFileModal,
  LocalMediaModal,
  useLocalMediaInlinePreviews,
  useLocalResourceClick,
} from "../LocalMediaModal";
import { renderFixedFontMath } from "../ui/FixedFontMathToggle";
import { RenderModeGlyph } from "../ui/RenderModeGlyph";

const EMPTY_LOCAL_MATH_PREVIEW = { html: "", changed: false };

// Rendered block-level elements that get their own per-paragraph quote circle.
const PARAGRAPH_BLOCK_SELECTOR =
  "p, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6, table";

/**
 * Top-level rendered blocks inside the copy-source content — paragraphs, lists,
 * etc. — skipping blocks nested inside another block (e.g. a `<p>` inside an
 * `<li>`), so each gets exactly one quote circle.
 */
function collectTopLevelBlocks(content: HTMLElement): HTMLElement[] {
  const all = Array.from(
    content.querySelectorAll<HTMLElement>(PARAGRAPH_BLOCK_SELECTOR),
  );
  return all.filter((element) => {
    const parentBlock = element.parentElement?.closest(
      PARAGRAPH_BLOCK_SELECTOR,
    );
    return !parentBlock || !content.contains(parentBlock);
  });
}

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
  onQuoteBlock?: (anchor: CommentAnchor) => void;
  alwaysShowQuoteCircle?: boolean;
}

export const TextBlock = memo(function TextBlock({
  text,
  isStreaming = false,
  augmentHtml,
  onQuoteBlock,
  alwaysShowQuoteCircle = false,
}: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copySourceRef = useRef<HTMLDivElement>(null);
  const textBlockRef = useRef<HTMLDivElement>(null);
  const paragraphBlocksRef = useRef<HTMLElement[]>([]);
  const [paragraphTargets, setParagraphTargets] = useState<
    { top: number; height: number }[]
  >([]);
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

  const handleQuoteBlock = useCallback(() => {
    const element = copySourceRef.current;
    if (!element || !onQuoteBlock) {
      return;
    }
    const snippet = getMarkdownSnippetForElement(element);
    if (!snippet) {
      return;
    }
    onQuoteBlock(createCommentAnchor(snippet));
  }, [onQuoteBlock]);

  const quoteParagraph = useCallback(
    (index: number) => {
      const sourceElement = copySourceRef.current;
      const blockElement = paragraphBlocksRef.current[index];
      if (!sourceElement || !blockElement || !onQuoteBlock) {
        return;
      }
      const snippet = getMarkdownSnippetForSubElement(
        sourceElement,
        blockElement,
      );
      if (!snippet) {
        return;
      }
      onQuoteBlock(createCommentAnchor(snippet));
    },
    [onQuoteBlock],
  );

  useEffect(() => {
    const element = copySourceRef.current;
    if (!element) {
      return;
    }

    return registerMarkdownCopySource(element, text);
  }, [text]);

  const {
    modal,
    localFileModal,
    projectFileModal,
    handleClick,
    closeModal,
    closeLocalFileModal,
    closeProjectFileModal,
  } = useLocalResourceClick();
  useLocalMediaInlinePreviews(copySourceRef);

  const showStreamingContent = isStreaming && useStreamingContent;
  const canToggleRendered = serverMarkdownChanged || localMathPreview.changed;
  const { showRendered, toggleLocalMode } = useRenderModeToggle(
    canToggleRendered,
    {
      participateInGlobalMode: false,
      resetDependencies: [
        isStreaming,
        isStreaming ? "" : text,
        augmentHtml ?? "",
      ],
    },
  );

  // Always render streaming container when isStreaming so refs are attached
  // before first augment arrives. Hidden until useStreamingContent becomes true.
  const renderStreamingContainer = isStreaming;

  // Measure each rendered top-level block so a per-paragraph quote circle can
  // sit at its end. Skipped while streaming (paragraph boundaries are still
  // moving); re-measured on reflow via ResizeObserver.
  useEffect(() => {
    const content = copySourceRef.current;
    const block = textBlockRef.current;
    if (!onQuoteBlock || !content || !block || showStreamingContent) {
      // Clear without churning state when already empty: the no-quote path must
      // render identically to a TextBlock without quote circles. A stray extra
      // render here disturbs other post-render content effects (inline media).
      if (paragraphBlocksRef.current.length > 0) {
        paragraphBlocksRef.current = [];
        setParagraphTargets([]);
      }
      return;
    }

    const measure = () => {
      const blocks = collectTopLevelBlocks(content);
      const blockRect = block.getBoundingClientRect();
      paragraphBlocksRef.current = blocks;
      setParagraphTargets(
        blocks.map((element) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top - blockRect.top, height: rect.height };
        }),
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [onQuoteBlock, showStreamingContent, showRendered, text, augmentHtml]);

  return (
    <div
      ref={textBlockRef}
      className={`text-block text-block-assistant timeline-item${isStreaming ? " streaming" : ""}`}
    >
      {onQuoteBlock && paragraphTargets.length > 0 && (
        <div className="text-block-quote-rail" aria-hidden="true">
          {paragraphTargets.map((target, index) => (
            <button
              key={index}
              type="button"
              className={`text-block-quote text-block-quote-paragraph ${alwaysShowQuoteCircle ? "always-visible" : ""}`}
              style={{ top: `${target.top + target.height}px` }}
              onClick={() => quoteParagraph(index)}
              title={t("sessionQuoteBlock")}
              aria-label={t("sessionQuoteBlock")}
            >
              &gt;
            </button>
          ))}
        </div>
      )}
      <div className="text-block-actions">
        {onQuoteBlock && paragraphTargets.length === 0 && (
          <button
            type="button"
            className={`text-block-quote ${alwaysShowQuoteCircle ? "always-visible" : ""}`}
            onClick={handleQuoteBlock}
            title={t("sessionQuoteBlock")}
            aria-label={t("sessionQuoteBlock")}
          >
            &gt;
          </button>
        )}
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

      {/* biome-ignore lint/a11y/noStaticElementInteractions: click is delegated to media/link elements inside rendered markdown */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation remains on the descendant links/controls */}
      <div
        ref={copySourceRef}
        className="text-block-content"
        onClick={handleClick}
      >
        {/* Always render streaming elements when streaming so refs are ready for augments */}
        {renderStreamingContainer && (
          <div
            style={
              showStreamingContent && showRendered
                ? undefined
                : { display: "none" }
            }
          >
            <div
              ref={streamingMarkdown.containerRef}
              className="streaming-blocks"
            />
            <span
              ref={streamingMarkdown.pendingRef}
              className="streaming-pending"
            />
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

      {localFileModal && (
        <LocalFileModal
          resource={localFileModal}
          onClose={closeLocalFileModal}
        />
      )}

      {projectFileModal && (
        <FileViewerModal
          projectId={projectFileModal.projectId}
          filePath={projectFileModal.filePath}
          lineNumber={projectFileModal.lineNumber}
          lineEnd={projectFileModal.lineEnd}
          onClose={closeProjectFileModal}
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
