import {
  type LocalResourceAttributes,
  type LocalResourceMediaType,
  type LocalResourceRef,
  parseLocalResourceLink,
} from "@yep-anywhere/shared";
import { type MouseEvent, type RefObject, useEffect, useState } from "react";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { useInlineImages } from "../hooks/useInlineImages";
import { useFetchedImage } from "../hooks/useRemoteImage";
import { getGlobalConnection, isRemoteMode } from "../lib/connection";
import { Modal } from "./ui/Modal";

interface LocalMediaModalProps {
  path: string;
  mediaType: LocalResourceMediaType;
  onClose: () => void;
}

interface LocalFileModalProps {
  resource: LocalResourceRef;
  onClose: () => void;
}

export interface ProjectFileModalTarget {
  projectId: string;
  filePath: string;
  lineNumber?: number;
  lineEnd?: number;
}

interface ProjectContext {
  projectId: string;
  projectPath: string | null;
}

interface NormalizedPath {
  display: string;
  isWindowsDrive: boolean;
}

type PathComparisonMode = "case-sensitive" | "case-insensitive";

interface UseLocalResourceClickOptions {
  projectContext?: ProjectContext | null;
}

interface UseLocalResourceClickResult {
  modal: {
    path: string;
    mediaType: LocalResourceMediaType;
  } | null;
  localFileModal: LocalResourceRef | null;
  projectFileModal: ProjectFileModalTarget | null;
  closeModal: () => void;
  closeLocalFileModal: () => void;
  closeProjectFileModal: () => void;
  handleClick: (e: MouseEvent) => void;
}

type LocalFileViewState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "text";
      contentType: string;
      text: string;
    }
  | {
      status: "html";
      html: string;
    }
  | {
      status: "blob";
      contentType: string;
      objectUrl: string;
    };

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function normalizePathForProjectComparison(path: string): NormalizedPath {
  const display = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return {
    display,
    isWindowsDrive: /^[A-Za-z]:\//.test(display),
  };
}

function getComparisonPath(
  path: NormalizedPath,
  mode: PathComparisonMode,
): string {
  return mode === "case-insensitive"
    ? path.display.toLowerCase()
    : path.display;
}

function getPathComparisonMode(
  filePath: NormalizedPath,
  projectPath: NormalizedPath,
): PathComparisonMode {
  return filePath.isWindowsDrive || projectPath.isWindowsDrive
    ? "case-insensitive"
    : "case-sensitive";
}

function getProjectRelativePath(
  filePath: string,
  projectPath: string | null,
): string | null {
  if (!projectPath) {
    return null;
  }

  const file = normalizePathForProjectComparison(filePath);
  const project = normalizePathForProjectComparison(projectPath);
  if (!file.display || !project.display) {
    return null;
  }

  const mode = getPathComparisonMode(file, project);
  const normalizedFile = getComparisonPath(file, mode);
  const normalizedProject = getComparisonPath(project, mode);
  if (!normalizedFile.startsWith(`${normalizedProject}/`)) {
    return null;
  }

  return file.display.slice(project.display.length + 1);
}

function normalizeResourceForProjectContext(
  resource: LocalResourceRef,
  projectContext: ProjectContext | null | undefined,
): ProjectFileModalTarget | null {
  if (resource.kind !== "local-file" || !projectContext) {
    return null;
  }

  const relativePath = getProjectRelativePath(
    resource.path,
    projectContext.projectPath,
  );
  if (!relativePath) {
    return null;
  }

  return {
    filePath: relativePath,
    lineEnd: resource.lineEnd,
    lineNumber: resource.lineNumber,
    projectId: projectContext.projectId,
  };
}

function localMediaApiPath(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(path)}`;
}

function localResourceApiPath(resource: LocalResourceRef): string {
  if (resource.kind === "project-raw-file") {
    const params = new URLSearchParams({ path: resource.path });
    if (resource.download) {
      params.set("download", "true");
    }
    return `/api/projects/${encodeURIComponent(
      resource.projectId ?? "",
    )}/files/raw?${params.toString()}`;
  }

  const params = new URLSearchParams({ path: resource.path });
  if (resource.renderMarkdown && !isRemoteMode()) {
    params.set("render", "1");
  }
  if (resource.download) {
    params.set("download", "true");
  }
  if (resource.lineNumber !== undefined) {
    params.set("line", String(resource.lineNumber));
  }
  if (resource.columnNumber !== undefined) {
    params.set("column", String(resource.columnNumber));
  }
  return `/api/local-file?${params.toString()}`;
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

async function formatLocalFileFetchError(response: Response): Promise<string> {
  let detail = "";
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim()) {
        detail = body.error.trim();
      }
    } else {
      detail = (await response.text()).trim();
    }
  } catch {
    detail = "";
  }

  const status = `${response.status} ${response.statusText}`.trim();
  return detail ? `API error: ${status}: ${detail}` : `API error: ${status}`;
}

async function fetchLocalResourceBlob(apiPath: string): Promise<Blob> {
  if (isRemoteMode()) {
    const connection = getGlobalConnection();
    if (!connection) {
      throw new Error("No connection available");
    }
    return connection.fetchBlob(apiPath);
  }

  const response = await fetch(apiPath, { credentials: "include" });
  if (!response.ok) {
    throw new Error(await formatLocalFileFetchError(response));
  }
  return response.blob();
}

function readBlobText(blob: Blob): Promise<string> {
  const text = (blob as Blob & { text?: () => Promise<string> }).text;
  if (typeof text === "function") {
    return text.call(blob);
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsText(blob);
  });
}

function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isHtmlContentType(contentType: string): boolean {
  return normalizeContentType(contentType) === "text/html";
}

function isPdfContentType(contentType: string): boolean {
  return normalizeContentType(contentType) === "application/pdf";
}

function isTextContentType(contentType: string): boolean {
  const normalized = normalizeContentType(contentType);
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/x-ndjson" ||
    normalized === "application/xml" ||
    normalized === "application/yaml" ||
    normalized === "application/x-yaml" ||
    normalized === "application/toml" ||
    normalized === "application/x-toml"
  );
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

export function LocalFileModal({ resource, onClose }: LocalFileModalProps) {
  const apiPath = localResourceApiPath(resource);
  const fileName = getFileName(resource.path);
  const [state, setState] = useState<LocalFileViewState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });

    fetchLocalResourceBlob(apiPath)
      .then(async (blob) => {
        if (cancelled) return;
        const contentType = blob.type || "application/octet-stream";

        if (isHtmlContentType(contentType)) {
          const html = await readBlobText(blob);
          if (!cancelled) {
            setState(
              isRemoteMode()
                ? { status: "text", contentType, text: html }
                : { status: "html", html },
            );
          }
          return;
        }

        if (isTextContentType(contentType)) {
          const text = await readBlobText(blob);
          if (!cancelled) {
            setState({ status: "text", contentType, text });
          }
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) {
          setState({ status: "blob", contentType, objectUrl });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          status: "error",
          error: err instanceof Error ? err.message : "Failed to load file",
        });
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [apiPath]);

  return (
    <Modal title={fileName} onClose={onClose}>
      <div className="local-file-modal-content">
        <div className="local-file-modal-meta" title={resource.path}>
          {resource.path}
          {resource.lineNumber !== undefined ? `:${resource.lineNumber}` : ""}
          {resource.columnNumber !== undefined
            ? `:${resource.columnNumber}`
            : ""}
        </div>
        {state.status === "loading" && (
          <div className="local-file-loading">Loading...</div>
        )}
        {state.status === "error" && (
          <div className="local-file-error">{state.error}</div>
        )}
        {state.status === "text" && (
          <div className="local-file-text-frame">
            <pre className="local-file-text">
              <code>{state.text}</code>
            </pre>
          </div>
        )}
        {state.status === "html" && (
          <iframe
            className="local-file-html-frame"
            sandbox=""
            srcDoc={state.html}
            title={fileName}
          />
        )}
        {state.status === "blob" && isPdfContentType(state.contentType) && (
          <iframe
            className="local-file-blob-frame"
            src={state.objectUrl}
            title={fileName}
          />
        )}
        {state.status === "blob" && !isPdfContentType(state.contentType) && (
          <div className="local-file-error">
            Preview is not available for {state.contentType || "this file"}.
          </div>
        )}
      </div>
    </Modal>
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

function isLocalFileResource(resource: LocalResourceRef): boolean {
  return resource.kind === "local-file" || resource.kind === "project-raw-file";
}

function shouldPreserveDirectBrowserGesture(e: MouseEvent): boolean {
  return (
    !isRemoteMode() &&
    (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
  );
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
 * local-resource links. Local media opens the existing modal. Local file paths
 * under the active project root become project file viewer targets.
 */
export function useLocalResourceClick(
  options: UseLocalResourceClickOptions = {},
): UseLocalResourceClickResult {
  const sessionMetadata = useOptionalSessionMetadata();
  const projectContext = options.projectContext ?? sessionMetadata;
  const [modal, setModal] = useState<{
    path: string;
    mediaType: LocalResourceMediaType;
  } | null>(null);
  const [localFileModal, setLocalFileModal] = useState<LocalResourceRef | null>(
    null,
  );
  const [projectFileModal, setProjectFileModal] =
    useState<ProjectFileModalTarget | null>(null);

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

    const projectFileTarget = normalizeResourceForProjectContext(
      resource,
      projectContext,
    );
    if (projectFileTarget) {
      if (shouldPreserveDirectBrowserGesture(e)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setProjectFileModal(projectFileTarget);
      setLocalFileModal(null);
      setModal(null);
      return;
    }

    if (resource.kind === "local-media") {
      e.preventDefault();
      e.stopPropagation();
      setModal({
        path: resource.path,
        mediaType: getLocalMediaType(resource, target),
      });
      setLocalFileModal(null);
      setProjectFileModal(null);
      return;
    }

    if (isLocalFileResource(resource)) {
      if (shouldPreserveDirectBrowserGesture(e)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setLocalFileModal(resource);
      setModal(null);
      setProjectFileModal(null);
    }
  };

  const closeModal = () => setModal(null);
  const closeLocalFileModal = () => setLocalFileModal(null);
  const closeProjectFileModal = () => setProjectFileModal(null);

  return {
    modal,
    localFileModal,
    projectFileModal,
    handleClick,
    closeModal,
    closeLocalFileModal,
    closeProjectFileModal,
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
  const { inlineImagesEnabled } = useInlineImages();

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const objectUrls = new Set<string>();

    const isImageInlineControl = (element: HTMLElement) =>
      element.getAttribute("data-media-type") !== "video";

    const syncInlineImageControls = () => {
      const toggles = root.querySelectorAll<HTMLButtonElement>(
        "button.local-media-inline-toggle",
      );
      for (const toggle of toggles) {
        if (!isImageInlineControl(toggle)) continue;
        toggle.hidden = !inlineImagesEnabled;
        if (inlineImagesEnabled) {
          toggle.removeAttribute("aria-hidden");
          toggle.removeAttribute("tabindex");
        } else {
          toggle.setAttribute("aria-hidden", "true");
          toggle.tabIndex = -1;
        }
      }

      const previews = root.querySelectorAll<HTMLElement>(
        ".local-media-inline-preview",
      );
      for (const preview of previews) {
        if (!isImageInlineControl(preview)) continue;
        preview.hidden = !inlineImagesEnabled;
        if (!inlineImagesEnabled) {
          preview.removeAttribute("data-inline-mounted");
          if (preview.childNodes.length > 0) {
            preview.replaceChildren();
          }
        }
      }
    };

    const refresh = () => {
      syncInlineImageControls();
      const elements = Array.from(
        root.querySelectorAll<HTMLElement>(".local-media-inline-preview"),
      );
      for (const element of elements) {
        if (!inlineImagesEnabled && isImageInlineControl(element)) continue;
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
  }, [inlineImagesEnabled, rootRef, refreshKey]);
}
