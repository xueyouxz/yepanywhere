import { fromUrlProjectId, isUrlProjectId } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildPublicShareFileHref,
  usePublicShareContext,
} from "../contexts/PublicShareContext";
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

function getProjectFileViewUrl(
  projectId: string,
  filePath: string,
  lineNumber?: number,
): string {
  const params = new URLSearchParams({ path: filePath });
  if (lineNumber !== undefined) {
    params.set("line", String(lineNumber));
  }
  return `/projects/${projectId}/file?${params.toString()}`;
}

function getProjectPath(projectId: string): string | null {
  if (!isUrlProjectId(projectId)) {
    return null;
  }
  try {
    const projectPath = fromUrlProjectId(projectId);
    return projectPath.startsWith("/") ? projectPath.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

function getProjectViewerFilePath(projectId: string, filePath: string): string {
  if (!filePath.startsWith("/")) {
    return filePath;
  }

  const projectPath = getProjectPath(projectId);
  if (!projectPath) {
    return filePath;
  }

  if (filePath === projectPath) {
    return ".";
  }

  const prefix = `${projectPath}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
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
  const publicShareContext = usePublicShareContext();
  const [showModal, setShowModal] = useState(false);
  const viewerFilePath = useMemo(
    () => getProjectViewerFilePath(projectId, filePath),
    [projectId, filePath],
  );
  const publicShareFileViewUrl = publicShareContext
    ? buildPublicShareFileHref(publicShareContext, {
        columnNumber,
        filePath: viewerFilePath,
        lineNumber,
      })
    : null;
  const fileViewUrl =
    publicShareFileViewUrl ??
    getProjectFileViewUrl(projectId, viewerFilePath, lineNumber);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (publicShareFileViewUrl) {
      return;
    }
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    setShowModal(true);
  }, [publicShareFileViewUrl]);

  const handleClose = useCallback(() => {
    setShowModal(false);
  }, []);

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
      <a
        href={fileViewUrl}
        className="file-path-link"
        onClick={handleClick}
        title={`${filePath}${suffix}\nClick to view, or use a browser link gesture to open this file`}
      >
        <span className="file-path-link-name">{text}</span>
        {suffix && <span className="file-path-link-line">{suffix}</span>}
      </a>
      {showModal &&
        createPortal(
          <FileViewerModal
            projectId={projectId}
            filePath={viewerFilePath}
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
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click dismisses the modal; Escape is handled globally
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
