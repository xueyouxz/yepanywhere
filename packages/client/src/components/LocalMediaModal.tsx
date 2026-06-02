import { type RefObject, useEffect, useState } from "react";
import { getGlobalConnection, isRemoteMode } from "../lib/connection";
import { Modal } from "./ui/Modal";

export interface LocalMediaSource {
  buildApiPath?: (path: string) => string | null;
  fetchBlob?: (
    path: string,
    apiPath: string,
    purpose: "inline" | "modal",
  ) => Promise<Blob>;
}

interface LocalMediaModalProps {
  path: string;
  mediaType: "image" | "video";
  mediaSource?: LocalMediaSource;
  onClose: () => void;
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function localMediaApiPath(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(path)}`;
}

async function copyImageBlobToClipboard(blob: Blob): Promise<void> {
  const ClipboardItemCtor = globalThis.ClipboardItem;
  if (!navigator.clipboard?.write || !ClipboardItemCtor) {
    throw new Error("Image clipboard is not available");
  }
  const clipboardBlob = blob.type === "image/png" ? blob : await toPngBlob(blob);
  await navigator.clipboard.write([
    new ClipboardItemCtor({ [clipboardBlob.type || "image/png"]: clipboardBlob }),
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

export async function fetchMediaBlob(apiPath: string): Promise<Blob> {
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

function buildMediaApiPath(
  path: string,
  mediaSource?: LocalMediaSource,
): string | null {
  return mediaSource?.buildApiPath?.(path) ?? localMediaApiPath(path);
}

async function fetchMediaBlobWithSource(
  path: string,
  mediaSource: LocalMediaSource | undefined,
  purpose: "inline" | "modal",
): Promise<Blob> {
  const apiPath = buildMediaApiPath(path, mediaSource);
  if (!apiPath) {
    throw new Error("Media is outside this view");
  }
  return mediaSource?.fetchBlob
    ? mediaSource.fetchBlob(path, apiPath, purpose)
    : fetchMediaBlob(apiPath);
}

function renderInlinePreview(
  target: HTMLElement,
  path: string,
  mediaType: "image" | "video",
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
  mediaSource,
  onClose,
}: LocalMediaModalProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileName = getFileName(path);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setLoading(true);
    setError(null);
    setUrl(null);

    void fetchMediaBlobWithSource(path, mediaSource, "modal")
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load media");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [mediaSource, path]);

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

/**
 * Extract the original file path from a local-image API URL.
 */
function extractPathFromApiUrl(href: string): string | null {
  try {
    // href is like "/api/local-image?path=%2Ftmp%2Ffoo.mp4"
    const url = new URL(href, "http://localhost");
    return url.searchParams.get("path");
  } catch {
    return null;
  }
}

function extractPathFromLocalMediaLink(
  target: HTMLAnchorElement,
): string | null {
  const groupedPath = target
    .closest(".local-media-link-group")
    ?.querySelector<HTMLElement>("[data-media-path]")
    ?.getAttribute("data-media-path");
  return (
    target.getAttribute("data-media-path") ??
    groupedPath ??
    extractPathFromApiUrl(target.getAttribute("href") ?? "")
  );
}

/**
 * Hook that provides a click handler for server-rendered HTML containing
 * .local-media-link elements. Returns modal state and the click handler.
 */
export function useLocalMediaClick() {
  const [modal, setModal] = useState<{
    path: string;
    mediaType: "image" | "video";
  } | null>(null);

  const handleClick = (e: React.MouseEvent) => {
    const toggle = (e.target as HTMLElement).closest?.(
      "button.local-media-inline-toggle",
    ) as HTMLButtonElement | null;
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();

      const mediaType =
        (toggle.getAttribute("data-media-type") as "image" | "video") ??
        "image";
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

    const target = (e.target as HTMLElement).closest?.(
      "a.local-media-link",
    ) as HTMLAnchorElement | null;
    if (!target) return;

    const href = target.getAttribute("href");
    if (!href) return;

    const path = extractPathFromLocalMediaLink(target);
    if (!path) return;

    e.preventDefault();
    e.stopPropagation();

    const mediaType =
      (target.getAttribute("data-media-type") as "image" | "video") ?? "image";
    setModal({ path, mediaType });
  };

  const closeModal = () => setModal(null);

  return { modal, handleClick, closeModal };
}

export function useLocalMediaInlinePreviews(
  rootRef: RefObject<HTMLElement | null>,
  refreshKey?: unknown,
  mediaSource?: LocalMediaSource,
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

        fetchMediaBlobWithSource(path, mediaSource, "inline")
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
  }, [rootRef, refreshKey, mediaSource]);
}
