import { memo, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileViewer } from "./FileViewer";

interface FilePathLinkProps {
  /** The file path to display and link to */
  filePath: string;
  /** Project ID for fetching file content */
  projectId: string;
  /** Optional line number to display */
  lineNumber?: number;
  /** Optional column number to display */
  columnNumber?: number;
  /** Optional custom display text (defaults to filename) */
  displayText?: string;
  /** Whether to show full path or just filename */
  showFullPath?: boolean;
}

/**
 * Get filename from path.
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * FilePathLink - A clickable link component that opens a file viewer modal.
 * Used to make file paths in messages interactive.
 */
export const FilePathLink = memo(function FilePathLink({
  filePath,
  projectId,
  lineNumber,
  columnNumber,
  displayText,
  showFullPath = false,
}: FilePathLinkProps) {
  const [showModal, setShowModal] = useState(false);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowModal(true);
  }, []);

  const handleClose = useCallback(() => {
    setShowModal(false);
  }, []);

  const handleOpenInNewTab = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const url = `/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`;
      window.open(url, "_blank");
    },
    [projectId, filePath],
  );

  // Format the display text
  const fileName = showFullPath ? filePath : getFileName(filePath);
  const text = displayText || fileName;

  // Build line/column suffix
  let suffix = "";
  if (lineNumber !== undefined) {
    suffix = `:${lineNumber}`;
    if (columnNumber !== undefined) {
      suffix += `:${columnNumber}`;
    }
  }

  return (
    <>
      <button
        type="button"
        className="file-path-link"
        onClick={handleClick}
        onAuxClick={handleOpenInNewTab}
        title={`${filePath}${suffix}\nClick to view, middle-click to open in new tab`}
      >
        <span className="file-path-link-name">{text}</span>
        {suffix && <span className="file-path-link-line">{suffix}</span>}
      </button>
      {showModal &&
        createPortal(
          <FileViewerModal
            projectId={projectId}
            filePath={filePath}
            lineNumber={lineNumber}
            onClose={handleClose}
          />,
          document.body,
        )}
    </>
  );
});

/**
 * Modal wrapper for FileViewer.
 */
export function FileViewerModal({
  projectId,
  filePath,
  lineNumber,
  onClose,
}: {
  projectId: string;
  filePath: string;
  lineNumber?: number;
  onClose: () => void;
}) {
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled in useEffect, click is for overlay dismiss
    <div
      className="modal-overlay"
      onClick={handleOverlayClick}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation, keyboard handled globally */}
      <dialog
        className="modal file-viewer-modal"
        open
        onClick={(e) => e.stopPropagation()}
      >
        <FileViewer
          projectId={projectId}
          filePath={filePath}
          lineNumber={lineNumber}
          onClose={onClose}
        />
      </dialog>
    </div>
  );
}
