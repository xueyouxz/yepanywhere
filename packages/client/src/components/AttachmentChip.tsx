import { useEffect, useMemo, useRef, useState } from "react";
import { planThumbnail, toUrlProjectId } from "@yep-anywhere/shared";
import { useInlineImages } from "../hooks/useInlineImages";
import { useRemoteImage } from "../hooks/useRemoteImage";
import { loadCachedAttachmentPreview } from "../lib/attachmentPreviewCache";
import { Modal } from "./ui/Modal";

export interface AttachmentChipProps {
  attachmentId?: string;
  originalName: string;
  path: string;
  mimeType: string;
  sizeLabel: string;
  imageWidth?: number;
  imageHeight?: number;
  previewUrl?: string;
  onRemove?: () => void;
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

const ATTACHMENT_NAME_SOFT_LIMIT = 24;
const ATTACHMENT_NAME_SEPARATOR_WINDOW = 8;

function isNameSeparator(char: string | undefined): boolean {
  return char === "-" || char === "_" || char === " ";
}

export function formatAttachmentName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= ATTACHMENT_NAME_SOFT_LIMIT) {
    return trimmed;
  }

  const overshootLimit =
    ATTACHMENT_NAME_SOFT_LIMIT + ATTACHMENT_NAME_SEPARATOR_WINDOW;

  for (
    let index = ATTACHMENT_NAME_SOFT_LIMIT;
    index < trimmed.length;
    index += 1
  ) {
    if (isNameSeparator(trimmed[index])) {
      if (index <= overshootLimit) {
        return `${trimmed.slice(0, index).replace(/[ -_]+$/u, "")}...`;
      }
      break;
    }
  }

  for (let index = ATTACHMENT_NAME_SOFT_LIMIT - 1; index >= 0; index -= 1) {
    if (isNameSeparator(trimmed[index])) {
      return `${trimmed.slice(0, index).replace(/[ -_]+$/u, "")}...`;
    }
  }

  return `${trimmed.slice(0, ATTACHMENT_NAME_SOFT_LIMIT).replace(/[ -_]+$/u, "")}...`;
}

function getUploadUrl(filePath: string): string | null {
  const parts = filePath.split("/");
  if (parts.length < 3) return null;

  const filename = parts[parts.length - 1];
  const sessionId = parts[parts.length - 2];
  const projectSegment = parts[parts.length - 3];

  if (!filename || !sessionId || !projectSegment) return null;

  if (projectSegment === ".attachments") {
    const projectPath = parts.slice(0, -3).join("/");
    if (!projectPath) return null;
    const projectId = toUrlProjectId(projectPath);
    return `/api/projects/${projectId}/sessions/${sessionId}/upload/${encodeURIComponent(filename)}`;
  }

  if (!/^[0-9a-f-]{36}_/.test(filename)) return null;
  return `/api/projects/${projectSegment}/sessions/${sessionId}/upload/${encodeURIComponent(filename)}`;
}

function useCachedAttachmentImage(
  attachmentId: string,
  path: string,
  enabled: boolean,
  remotePreviewEnabled: boolean,
  previewUrl?: string,
): {
  previewUrl: string | null;
  fullUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  loading: boolean;
  error: string | null;
} {
  const [cachePreviewUrl, setCachePreviewUrl] = useState<string | null>(null);
  const [cacheFullUrl, setCacheFullUrl] = useState<string | null>(null);
  const [cachePreviewWidth, setCachePreviewWidth] = useState<number | null>(
    null,
  );
  const [cachePreviewHeight, setCachePreviewHeight] = useState<number | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const fullUrlRef = useRef<string | null>(null);

  const remotePath = useMemo(() => getUploadUrl(path), [path]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setCachePreviewUrl(null);
    setCacheFullUrl(null);
    setCachePreviewWidth(null);
    setCachePreviewHeight(null);

    if (!enabled) {
      setLoading(false);
      setRemoteEnabled(false);
      return () => {
        if (previewUrlRef.current) {
          URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = null;
        }
        if (fullUrlRef.current) {
          URL.revokeObjectURL(fullUrlRef.current);
          fullUrlRef.current = null;
        }
      };
    }

    if (previewUrl) {
      setLoading(false);
      setRemoteEnabled(false);
      return () => {
        if (previewUrlRef.current) {
          URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = null;
        }
        if (fullUrlRef.current) {
          URL.revokeObjectURL(fullUrlRef.current);
          fullUrlRef.current = null;
        }
      };
    }

    setLoading(true);
    setRemoteEnabled(false);
    loadCachedAttachmentPreview(attachmentId, path)
      .then((entry) => {
        if (cancelled) return;
        if (!entry) {
          setLoading(false);
          setRemoteEnabled(true);
          return;
        }

        const thumbBlob = entry.thumbnailBlob ?? entry.fullBlob;
        const previewObjectUrl = URL.createObjectURL(thumbBlob);
        const fullObjectUrl = URL.createObjectURL(entry.fullBlob);
        previewUrlRef.current = previewObjectUrl;
        fullUrlRef.current = fullObjectUrl;
        setCachePreviewUrl(previewObjectUrl);
        setCacheFullUrl(fullObjectUrl);
        setCachePreviewWidth(entry.thumbnailWidth ?? null);
        setCachePreviewHeight(entry.thumbnailHeight ?? null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (remotePath) {
          setError(null);
          setRemoteEnabled(true);
        } else {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load attachment preview",
          );
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      if (fullUrlRef.current) {
        URL.revokeObjectURL(fullUrlRef.current);
        fullUrlRef.current = null;
      }
    };
  }, [attachmentId, enabled, path, previewUrl, remotePath]);

  const remote = useRemoteImage(
    remotePath,
    enabled && remotePreviewEnabled && remoteEnabled && !previewUrl,
  );

  return {
    previewUrl: enabled ? (previewUrl ?? cachePreviewUrl ?? remote.url) : null,
    fullUrl: enabled ? (previewUrl ?? cacheFullUrl ?? remote.url) : null,
    previewWidth: cachePreviewWidth,
    previewHeight: cachePreviewHeight,
    loading: loading || remote.loading,
    error: error ?? remote.error,
  };
}

export function AttachmentChip({
  attachmentId,
  originalName,
  path,
  mimeType,
  sizeLabel,
  imageWidth,
  imageHeight,
  previewUrl,
  onRemove,
}: AttachmentChipProps) {
  const [showModal, setShowModal] = useState(false);
  const { inlineImagesEnabled } = useInlineImages();
  const isImage = isImageMimeType(mimeType);
  const cacheKey = attachmentId ?? path;
  const imageLoadEnabled = inlineImagesEnabled || showModal;
  const {
    previewUrl: imagePreviewUrl,
    fullUrl,
    previewWidth,
    previewHeight,
    loading,
    error,
  } = useCachedAttachmentImage(
    cacheKey,
    path,
    imageLoadEnabled,
    showModal,
    previewUrl,
  );
  const previewPlan =
    previewWidth && previewHeight
      ? { width: previewWidth, height: previewHeight }
      : imageWidth && imageHeight
        ? planThumbnail(imageWidth, imageHeight)
        : null;
  const previewStyle = previewPlan
    ? {
        width: `${previewPlan.width}px`,
        height: `${previewPlan.height}px`,
      }
    : undefined;

  if (!isImage) {
    return (
      <span className="attachment-chip" title={`${mimeType}, ${sizeLabel}`}>
        <span className="attachment-chip-icon" aria-hidden="true">
          📎
        </span>
        <span className="attachment-name" title={path}>
          {formatAttachmentName(originalName)}
        </span>
        <span className="attachment-size">{sizeLabel}</span>
        {onRemove && (
          <button
            type="button"
            className="attachment-remove"
            onClick={onRemove}
            aria-label={`Remove ${originalName}`}
          >
            x
          </button>
        )}
      </span>
    );
  }

  return (
    <>
      <div
        className="attachment-chip attachment-chip-image"
        title={`${mimeType}, ${sizeLabel}`}
      >
        <button
          type="button"
          className="attachment-chip-main"
          onClick={() => setShowModal(true)}
          aria-label={`Open ${originalName}`}
          title={`${mimeType}, ${sizeLabel}`}
        >
          {inlineImagesEnabled && (
            <span
              className="attachment-preview"
              aria-hidden="true"
              style={previewStyle}
            >
              {imagePreviewUrl ? (
                <img src={imagePreviewUrl} alt="" />
              ) : (
                <span className="attachment-preview-fallback">📎</span>
              )}
            </span>
          )}
          <span className="attachment-name" title={path}>
            {formatAttachmentName(originalName)}
          </span>
          <span className="attachment-size">{sizeLabel}</span>
        </button>
        {onRemove && (
          <button
            type="button"
            className="attachment-remove"
            onClick={onRemove}
            aria-label={`Remove ${originalName}`}
          >
            x
          </button>
        )}
      </div>
      {showModal && (
        <Modal title={originalName} onClose={() => setShowModal(false)}>
          <div className="uploaded-image-modal">
            {loading && <div className="image-loading">Loading...</div>}
            {error && <div className="image-error">Failed to load image</div>}
            {fullUrl && <img src={fullUrl} alt={originalName} />}
          </div>
        </Modal>
      )}
    </>
  );
}
