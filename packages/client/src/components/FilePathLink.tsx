import { fromUrlProjectId, isUrlProjectId } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildPublicShareFileHref,
  usePublicShareContext,
} from "../contexts/PublicShareContext";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { toBrowserAppHref } from "../lib/appHref";
import {
  getPathBasename,
  getProjectRelativePath,
  normalizePathSeparators,
  stripTrailingPathSeparators,
} from "../lib/text";
import {
  FileViewer,
  type FileViewerMode,
  type FileViewerSource,
} from "./FileViewer";
import { createPublicShareFileViewerSource } from "./publicShareFileViewerSource";

interface FilePathLinkProps {
  /** The file path to display and link to */
  filePath: string;
  /** Project ID for fetching file content */
  projectId: string;
  /** Optional line number to display */
  lineNumber?: number;
  /** Optional end line for range highlighting */
  lineEnd?: number;
  /** Optional column number to display */
  columnNumber?: number;
  /** Optional custom display text (defaults to filename) */
  displayText?: string;
  /** Whether to append the line/range suffix to the visible link text */
  showLineSuffix?: boolean;
  /** Whether to show full path or just filename */
  showFullPath?: boolean;
  /** Viewer mode. The range mode shows only the requested line range. */
  viewMode?: FileViewerMode;
}

function getProjectFileViewUrl(
  projectId: string,
  filePath: string,
  lineNumber?: number,
  lineEnd?: number,
  viewMode?: FileViewerMode,
  basePath = "",
): string {
  const params = new URLSearchParams({ path: filePath });
  if (lineNumber !== undefined) {
    params.set("line", String(lineNumber));
  }
  if (lineEnd !== undefined) {
    params.set("lineEnd", String(lineEnd));
  }
  if (viewMode === "range") {
    params.set("view", "range");
  }
  return `${basePath}/projects/${projectId}/file?${params.toString()}`;
}

function getProjectPath(projectId: string): string | null {
  if (!isUrlProjectId(projectId)) {
    return null;
  }
  try {
    const projectPath = fromUrlProjectId(projectId);
    return stripTrailingPathSeparators(projectPath);
  } catch {
    return null;
  }
}

function getProjectViewerFilePath(projectId: string, filePath: string): string {
  const projectPath = getProjectPath(projectId);
  const projectRelativePath = getProjectRelativePath(filePath, projectPath);
  if (projectRelativePath !== null) {
    return projectRelativePath;
  }

  const normalizedPath = normalizePathSeparators(filePath);
  const isAbsolutePath =
    normalizedPath.startsWith("/") || /^[a-zA-Z]:\//.test(normalizedPath);
  return !isAbsolutePath && filePath.includes("\\")
    ? normalizePathSeparators(filePath)
    : filePath;
}

function formatLineSuffix(lineNumber?: number, lineEnd?: number): string {
  if (lineNumber === undefined) {
    return "";
  }
  if (lineEnd !== undefined && lineEnd > lineNumber) {
    return `:${lineNumber}-${lineEnd}`;
  }
  return `:${lineNumber}`;
}

/**
 * FilePathLink - A clickable link component that opens a file viewer modal.
 * Used to make file paths in messages interactive.
 */
export const FilePathLink = memo(function FilePathLink({
  filePath,
  projectId,
  lineNumber,
  lineEnd,
  columnNumber,
  displayText,
  showLineSuffix = true,
  showFullPath = false,
  viewMode = "full",
}: FilePathLinkProps) {
  const publicShareContext = usePublicShareContext();
  const basePath = useRemoteBasePath();
  const [showModal, setShowModal] = useState(false);
  const viewerFilePath = useMemo(
    () => getProjectViewerFilePath(projectId, filePath),
    [projectId, filePath],
  );
  const publicShareFileViewUrl = publicShareContext
    ? buildPublicShareFileHref(publicShareContext, {
        columnNumber,
        filePath: viewerFilePath,
        lineEnd,
        lineNumber,
        viewMode,
      })
    : null;
  const fileViewUrl =
    publicShareContext !== null
      ? publicShareFileViewUrl
      : toBrowserAppHref(
          getProjectFileViewUrl(
            projectId,
            viewerFilePath,
            lineNumber,
            lineEnd,
            viewMode,
            basePath,
          ),
        );
  const publicShareFileViewerSource = useMemo(
    () =>
      publicShareContext
        ? createPublicShareFileViewerSource(publicShareContext)
        : undefined,
    [publicShareContext],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      if (publicShareContext && !publicShareFileViewUrl) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      setShowModal(true);
    },
    [publicShareContext, publicShareFileViewUrl],
  );

  const handleClose = useCallback(() => {
    setShowModal(false);
  }, []);

  // Format the display text
  const fileName = showFullPath ? filePath : getPathBasename(filePath);
  const text = displayText || fileName;

  const lineSuffix = formatLineSuffix(lineNumber, lineEnd);
  const columnSuffix =
    lineSuffix && columnNumber !== undefined && lineEnd === undefined
      ? `:${columnNumber}`
      : "";
  const suffix = `${lineSuffix}${columnSuffix}`;
  const visibleSuffix = showLineSuffix ? suffix : "";

  return (
    <>
      <a
        href={fileViewUrl ?? "#"}
        className="file-path-link"
        onClick={handleClick}
        title={`${filePath}${suffix}\nClick to view, or use a browser link gesture to open this file`}
      >
        <span className="file-path-link-name">{text}</span>
        {visibleSuffix && (
          <span className="file-path-link-line">{visibleSuffix}</span>
        )}
      </a>
      {showModal &&
        createPortal(
          <FileViewerModal
            projectId={projectId}
            filePath={viewerFilePath}
            lineNumber={lineNumber}
            lineEnd={lineEnd}
            viewMode={viewMode}
            source={publicShareFileViewerSource}
            openInNewTabUrl={fileViewUrl}
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
  lineEnd,
  viewMode = "full",
  source,
  openInNewTabUrl,
  onClose,
}: {
  projectId: string;
  filePath: string;
  lineNumber?: number;
  lineEnd?: number;
  viewMode?: FileViewerMode;
  source?: FileViewerSource;
  openInNewTabUrl?: string | null;
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
        className={`modal file-viewer-modal ${
          viewMode === "range" ? "file-viewer-modal-compact" : ""
        }`}
        open
        onClick={(e) => e.stopPropagation()}
      >
        <FileViewer
          projectId={projectId}
          filePath={filePath}
          lineNumber={lineNumber}
          lineEnd={lineEnd}
          viewMode={viewMode}
          source={source}
          openInNewTabUrl={openInNewTabUrl}
          onClose={onClose}
        />
      </dialog>
    </div>
  );
}
