import { useState } from "react";
import { useFetchedImage } from "../../../hooks/useRemoteImage";
import { getPathBasename, makeDisplayPath } from "../../../lib/text";
import { Modal } from "../../ui/Modal";
import type { ToolRenderer } from "./types";

interface ViewImageInput {
  path: string;
}

function getFileName(path: string): string {
  return getPathBasename(path);
}

/**
 * Modal content that fetches the image only when mounted (i.e. when modal opens).
 */
function ViewImageModalContent({ path, alt }: { path: string; alt: string }) {
  const apiPath = `/api/local-image?path=${encodeURIComponent(path)}`;
  const { url, loading, error } = useFetchedImage(apiPath);

  if (loading) {
    return <div className="viewimage-loading">Loading image...</div>;
  }

  if (error || !url) {
    return (
      <div className="viewimage-error">{error ?? "Failed to load image"}</div>
    );
  }

  return (
    <div className="read-image-result">
      <img
        className="read-image"
        src={url}
        alt={alt}
        style={{ maxWidth: "100%" }}
      />
    </div>
  );
}

/**
 * Clickable filename button that opens a modal to view the image.
 * Does NOT fetch anything until the modal is opened.
 */
function ViewImageButton({
  path,
  className,
  onClick,
  projectPath,
}: {
  path: string;
  className: string;
  onClick: (e: React.MouseEvent) => void;
  projectPath?: string | null;
}) {
  const displayPath = makeDisplayPath(path, projectPath);
  return (
    <button type="button" className={className} onClick={onClick}>
      {getFileName(displayPath)}
      <span className="file-line-count-inline">(image)</span>
    </button>
  );
}

/**
 * Shared component: clickable filename + lazy-loading modal.
 */
function ViewImageClickable({
  path,
  buttonClass,
  stopPropagation,
  projectPath,
}: {
  path: string;
  buttonClass: string;
  stopPropagation?: boolean;
  projectPath?: string | null;
}) {
  const [showModal, setShowModal] = useState(false);
  const fileName = getFileName(makeDisplayPath(path, projectPath));

  return (
    <>
      <ViewImageButton
        path={path}
        className={buttonClass}
        projectPath={projectPath}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          setShowModal(true);
        }}
      />
      {showModal && (
        <Modal title={fileName} onClose={() => setShowModal(false)}>
          <ViewImageModalContent path={path} alt={fileName} />
        </Modal>
      )}
    </>
  );
}

export const viewImageRenderer: ToolRenderer<ViewImageInput, unknown> = {
  tool: "ViewImage",
  displayName: "View Image",

  renderToolUse(input, context) {
    const { path } = input as ViewImageInput;
    return (
      <div className="read-image-result">
        <ViewImageClickable
          path={path}
          buttonClass="file-link-button"
          projectPath={context.projectPath}
        />
      </div>
    );
  },

  renderToolResult(_result, _isError, context, input) {
    const { path } = input as ViewImageInput;
    return (
      <div className="read-image-result">
        <ViewImageClickable
          path={path}
          buttonClass="file-link-button"
          projectPath={context.projectPath}
        />
      </div>
    );
  },

  getUseSummary(input, context) {
    const path = (input as ViewImageInput)?.path ?? "";
    return getFileName(makeDisplayPath(path, context?.projectPath));
  },

  getResultSummary(_result, isError) {
    return isError ? "Error" : "Image loaded";
  },

  renderInteractiveSummary(input, _result, _isError, context) {
    const { path } = input as ViewImageInput;
    return (
      <ViewImageClickable
        path={path}
        buttonClass="file-link-inline"
        projectPath={context.projectPath}
        stopPropagation
      />
    );
  },
};
