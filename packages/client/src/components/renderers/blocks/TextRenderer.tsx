import {
  LocalMediaModal,
  LocalResourceNotice,
  useLocalResourceClick,
} from "../../LocalMediaModal";
import type { ContentBlock, ContentRenderer } from "../types";

interface TextBlock extends ContentBlock {
  type: "text";
  text: string;
  /** Server-rendered HTML (if available) */
  _renderedHtml?: string;
}

/**
 * Text renderer - displays text content with markdown rendering
 */
function TextRendererComponent({ block }: { block: TextBlock }) {
  const {
    modal,
    resourceNotice,
    handleClick,
    closeModal,
    clearResourceNotice,
  } = useLocalResourceClick();

  // Prefer server-rendered HTML if available
  if (block._renderedHtml) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: click is delegated to local resource links inside rendered markdown
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation remains on descendant links/controls
      <div className="text-block" onClick={handleClick}>
        <div
          // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered markdown
          dangerouslySetInnerHTML={{ __html: block._renderedHtml }}
        />
        {resourceNotice && (
          <LocalResourceNotice
            message={resourceNotice}
            onDismiss={clearResourceNotice}
          />
        )}
        {modal && (
          <LocalMediaModal
            path={modal.path}
            mediaType={modal.mediaType}
            onClose={closeModal}
          />
        )}
      </div>
    );
  }

  // Fallback to plain text when server-rendered HTML is not available
  return (
    <div className="text-block">
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
        {block.text}
      </pre>
    </div>
  );
}

export const textRenderer: ContentRenderer<TextBlock> = {
  type: "text",
  render(block, _context) {
    return <TextRendererComponent block={block as TextBlock} />;
  },
  getSummary(block) {
    const text = (block as TextBlock).text;
    return text.length > 100 ? `${text.slice(0, 97)}...` : text;
  },
};
