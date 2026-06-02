import {
  type LocalResourceAttributes,
  type LocalResourceMediaType,
  type LocalResourceRef,
  parseLocalResourceLink,
} from "@yep-anywhere/shared";
import { type MouseEvent, type RefObject, useEffect, useState } from "react";
import { useFetchedImage } from "../hooks/useRemoteImage";
import { getGlobalConnection, isRemoteMode } from "../lib/connection";
import { Modal } from "./ui/Modal";

interface LocalMediaModalProps {
  path: string;
  mediaType: LocalResourceMediaType;
  onClose: () => void;
}

const REMOTE_LOCAL_FILE_BLOCKED_MESSAGE =
  "This local file link needs an in-app viewer before it can open through Remote Access.";

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function localMediaApiPath(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(path)}`;
}

function isLocalMediaType(
  value: string | null,
): value is LocalResourceMediaType {
  return value === "image" || value === "video";
}

async function copyImageBlobToClipboard(blob: Blob): Promise<void> {
  const ClipboardItemCtor = globalThis.ClipboardItem;
  if (!navigator.clipboard?.write || !ClipboardItemCtor) {
    throw new Error("Image clipboard is not available");
  }
  const clipboardBlob =
    blob.type === "image/png" ? blob : await toPngBlob(blob);
  await navigator.clipboard.write([
    new ClipboardItemCtor({
      [clipboardBlob.type || "image/png"]: clipboardBlob,
    }),
  ]);
}

async function toPngBlob(blob: Blob): Promise<Blob> {
  const sourceUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to decode image"));
    });
    image.src = sourceUrl;
    await loaded;

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas is not available");
    }
    context.drawImage(image, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
        } else {
          reject(new Error("Failed to encode PNG"));
        }
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function fetchMediaBlob(apiPath: string): Promise<Blob> {
  if (isRemoteMode()) {
    const connection = getGlobalConnection();
    if (!connection) {
      throw new Error("No connection available");
    }
    return connection.fetchBlob(apiPath);
  }

  const response = await fetch(apiPath, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.blob();
}

function renderInlinePreview(
  target: HTMLElement,
  path: string,
  mediaType: LocalResourceMediaType,
  blob: Blob,
  objectUrl: string,
) {
  const frame = document.createElement("span");
  frame.className = "local-media-inline-frame";

  if (mediaType === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.muted = true;
    video.className = "local-media-inline-player";
    video.src = objectUrl;
    frame.append(video);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "local-media-inline-image-button";
    button.title = "Copy image";
    button.setAttribute("aria-label", `Copy ${getFileName(path)}`);

    const image = document.createElement("img");
    image.className = "local-media-inline-image";
    image.src = objectUrl;
    image.alt = getFileName(path);
    button.append(image);

    button.addEventListener("click", async () => {
      try {
        await copyImageBlobToClipboard(blob);
        button.classList.add("copied");
        button.title = "Copied";
        button.setAttribute("aria-label", "Copied image");

        const copied = document.createElement("span");
        copied.className = "local-media-inline-copied";
        copied.textContent = "Copied";
        frame.append(copied);
        setTimeout(() => {
          button.classList.remove("copied");
          button.title = "Copy image";
          button.setAttribute("aria-label", `Copy ${getFileName(path)}`);
          copied.remove();
        }, 1500);
      } catch (err) {
        console.error("[LocalMediaInlinePreview] Failed to copy image:", err);
      }
    });

    frame.append(button);
  }

  target.replaceChildren(frame);
}

/**
 * Modal for viewing local media files (images and videos).
 * Fetches the file via the local-image API with proper auth handling.
 */
export function LocalMediaModal({
  path,
  mediaType,
  onClose,
}: LocalMediaModalProps) {
  const apiPath = localMediaApiPath(path);
  const { url, loading, error } = useFetchedImage(apiPath);
  const fileName = getFileName(path);

  return (
    <Modal title={fileName} onClose={onClose}>
      <div className="local-media-modal-content">
        {loading && <div className="local-media-loading">Loading...</div>}
        {error && <div className="local-media-error">{error}</div>}
        {url &&
          (mediaType === "video" ? (
            // biome-ignore lint/a11y/useMediaCaption: user-generated local files, no captions available
            <video controls autoPlay className="local-media-player" src={url} />
          ) : (
            <img className="local-media-image" src={url} alt={fileName} />
          ))}
      </div>
    </Modal>
  );
}

export function LocalResourceNotice({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="local-resource-notice" role="status">
      <span>{message}</span>
      {onDismiss ? (
        <button
          type="button"
          className="local-resource-notice-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss local resource notice"
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

/**
 * Extract YA-owned semantic resource attributes from a rendered link.
 *
 * These attributes are routing hints. Authorization remains with the route
 * that ultimately serves the resource.
 */
function getLocalResourceAttributes(
  target: HTMLAnchorElement,
): LocalResourceAttributes {
  return {
    "data-ya-resource": target.getAttribute("data-ya-resource"),
    "data-ya-path": target.getAttribute("data-ya-path"),
    "data-ya-project-id": target.getAttribute("data-ya-project-id"),
    "data-ya-line": target.getAttribute("data-ya-line"),
    "data-ya-line-end": target.getAttribute("data-ya-line-end"),
    "data-ya-column": target.getAttribute("data-ya-column"),
    "data-ya-render-markdown": target.getAttribute("data-ya-render-markdown"),
    "data-ya-download": target.getAttribute("data-ya-download"),
    "data-ya-media-type": target.getAttribute("data-ya-media-type"),
  };
}

function getClickedAnchor(
  target: EventTarget | null,
): HTMLAnchorElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest("a[href]");
}

function getCurrentHref(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.href;
}

function shouldBlockRemoteRawNavigation(resource: LocalResourceRef): boolean {
  return resource.kind === "local-file" || resource.kind === "project-raw-file";
}

function getLocalMediaType(
  resource: LocalResourceRef,
  target: HTMLAnchorElement,
): LocalResourceMediaType {
  const mediaTypeAttribute = target.getAttribute("data-media-type");
  if (resource.mediaType) {
    return resource.mediaType;
  }
  if (isLocalMediaType(mediaTypeAttribute)) {
    return mediaTypeAttribute;
  }
  return "image";
}

/**
 * Hook that provides a delegated click handler for rendered HTML containing
 * local-resource links. Local media opens the existing modal. Raw local-file
 * API links are blocked in remote mode until the file viewer branch is wired.
 */
export function useLocalResourceClick() {
  const [modal, setModal] = useState<{
    path: string;
    mediaType: LocalResourceMediaType;
  } | null>(null);
  const [resourceNotice, setResourceNotice] = useState<string | null>(null);

  const handleClick = (e: MouseEvent) => {
    if (!(e.target instanceof Element)) {
      return;
    }

    const toggle = e.target.closest(
      "button.local-media-inline-toggle",
    ) as HTMLButtonElement | null;
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();

      const mediaTypeAttribute = toggle.getAttribute("data-media-type");
      const mediaType = isLocalMediaType(mediaTypeAttribute)
        ? mediaTypeAttribute
        : "image";
      const expanded = toggle.getAttribute("data-expanded") !== "false";
      const nextExpanded = !expanded;
      const preview =
        toggle.closest(".local-media-link-group")?.nextElementSibling ?? null;

      toggle.dataset.expanded = String(nextExpanded);
      toggle.setAttribute("aria-expanded", String(nextExpanded));
      toggle.setAttribute(
        "aria-label",
        `${nextExpanded ? "Collapse" : "Expand"} ${mediaType}`,
      );
      toggle.title = nextExpanded
        ? "Collapse inline preview"
        : "Expand inline preview";
      toggle.textContent = nextExpanded ? "-" : "+";
      if (preview?.classList.contains("local-media-inline-preview")) {
        preview.setAttribute("data-expanded", String(nextExpanded));
      }
      return;
    }

    const target = getClickedAnchor(e.target);
    if (!target) return;

    const href = target.getAttribute("href");
    const resource = parseLocalResourceLink(
      {
        attributes: getLocalResourceAttributes(target),
        href,
      },
      { currentHref: getCurrentHref() },
    );
    if (!resource) return;

    if (resource.kind === "local-media") {
      e.preventDefault();
      e.stopPropagation();
      setResourceNotice(null);
      setModal({
        path: resource.path,
        mediaType: getLocalMediaType(resource, target),
      });
      return;
    }

    if (isRemoteMode() && shouldBlockRemoteRawNavigation(resource)) {
      e.preventDefault();
      e.stopPropagation();
      setResourceNotice(REMOTE_LOCAL_FILE_BLOCKED_MESSAGE);
    }
  };

  const closeModal = () => setModal(null);
  const clearResourceNotice = () => setResourceNotice(null);

  return {
    modal,
    resourceNotice,
    handleClick,
    closeModal,
    clearResourceNotice,
  };
}

/**
 * Compatibility alias for existing callers during the local-resource migration.
 */
export function useLocalMediaClick() {
  return useLocalResourceClick();
}

export function useLocalMediaInlinePreviews(
  rootRef: RefObject<HTMLElement | null>,
  refreshKey?: unknown,
) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const objectUrls = new Set<string>();

    const refresh = () => {
      const elements = Array.from(
        root.querySelectorAll<HTMLElement>(".local-media-inline-preview"),
      );
      for (const element of elements) {
        if (element.dataset.inlineMounted === "true") continue;
        const path = element.getAttribute("data-media-path");
        if (!path) continue;
        const mediaType =
          (element.getAttribute("data-media-type") as "image" | "video") ??
          "image";
        element.dataset.inlineMounted = "true";
        element.replaceChildren();

        const loading = document.createElement("span");
        loading.className = "local-media-inline-loading";
        loading.textContent = "Loading...";
        element.append(loading);

        fetchMediaBlob(localMediaApiPath(path))
          .then((blob) => {
            const objectUrl = URL.createObjectURL(blob);
            objectUrls.add(objectUrl);
            renderInlinePreview(element, path, mediaType, blob, objectUrl);
          })
          .catch((err) => {
            const error = document.createElement("span");
            error.className = "local-media-inline-error";
            error.textContent =
              err instanceof Error ? err.message : "Failed to load media";
            element.replaceChildren(error);
          });
      }
    };

    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const url of objectUrls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [rootRef, refreshKey]);
}
