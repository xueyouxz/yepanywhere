import { memo, type ReactNode, useState } from "react";
import { useI18n } from "../../i18n";
import {
  type UploadedFileInfo,
  getFilename,
  parseUserPrompt,
} from "../../lib/parseUserPrompt";
import type { ContentBlock } from "../../types";
import { AttachmentChip } from "../AttachmentChip";
import { CopyTextButton } from "../ui/CopyTextButton";

const MAX_LINES = 12;
const MAX_CHARS = MAX_LINES * 100;
const STACK_ACTIONS_MIN_CHARS = 80;

interface Props {
  content: string | ContentBlock[];
  onCorrect?: () => void;
  onTrimBefore?: () => void;
  /** Fork the session from just before this turn (real prefix fork only). */
  onForkBefore?: () => void;
  extraActions?: ReactNode;
}

interface InputImageBlock extends ContentBlock {
  type: "input_image";
  file_path?: string;
  image_url?: string;
  mime_type?: string;
}

interface CorrectionDisplay {
  correctedText: string;
  change?: string;
}

const CORRECTION_PREFIX = "Correction to previous message:\n";
const CORRECTION_CHANGE_SEPARATOR = "\n\nChange: ";

function parseCorrectionDisplay(text: string): CorrectionDisplay | null {
  if (!text.startsWith(CORRECTION_PREFIX)) {
    return null;
  }

  const body = text.slice(CORRECTION_PREFIX.length);
  const changeIndex = body.indexOf(CORRECTION_CHANGE_SEPARATOR);
  const correctedText = changeIndex === -1 ? body : body.slice(0, changeIndex);
  const change =
    changeIndex === -1
      ? undefined
      : body.slice(changeIndex + CORRECTION_CHANGE_SEPARATOR.length).trim();

  if (!correctedText.trim()) {
    return null;
  }

  return {
    correctedText,
    ...(change ? { change } : {}),
  };
}

function getUserPromptCopyText(text: string): string {
  const correction = parseCorrectionDisplay(text);
  if (!correction) {
    return text;
  }

  return correction.change
    ? `${correction.correctedText}\n\nChange: ${correction.change}`
    : correction.correctedText;
}

function shouldStackUserPromptActions(text: string): boolean {
  return (
    text.length >= STACK_ACTIONS_MIN_CHARS ||
    text.split(/\r\n|\r|\n/).length > 1
  );
}

/**
 * Renders file metadata (opened files) below the user prompt
 */
function OpenedFilesMetadata({ files }: { files: string[] }) {
  if (files.length === 0) return null;

  return (
    <div className="user-prompt-metadata">
      {files.map((filePath) => (
        <span
          key={filePath}
          className="opened-file"
          title={`file was opened in editor: ${filePath}`}
        >
          {getFilename(filePath)}
        </span>
      ))}
    </div>
  );
}

function isInputImageBlock(block: ContentBlock): block is InputImageBlock {
  return block.type === "input_image";
}

function stripCodexImageMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "<image>")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseInlineImageData(imageUrl: string): {
  mimeType?: string;
  bytes?: number;
} {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(imageUrl);
  if (!match) return {};

  const rawMime = match[1]?.trim();
  const mimeType = rawMime || undefined;
  const isBase64 = Boolean(match[2]);
  const payload = (match[3] ?? "").trim();
  if (!payload) return { mimeType };

  if (!isBase64) {
    const decoded = decodeURIComponent(payload);
    return { mimeType, bytes: decoded.length };
  }

  const sanitized = payload.replace(/\s+/g, "");
  const padding = sanitized.endsWith("==")
    ? 2
    : sanitized.endsWith("=")
      ? 1
      : 0;
  const bytes = Math.max(0, Math.floor((sanitized.length * 3) / 4) - padding);
  return { mimeType, bytes };
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
}

function getMimeTypeFromPath(path: string): string | undefined {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg"))
    return "image/jpeg";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".bmp")) return "image/bmp";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  return undefined;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/svg+xml") return "svg";
  const slashIndex = normalized.indexOf("/");
  if (slashIndex === -1) return "png";
  const ext = normalized.slice(slashIndex + 1);
  return ext || "png";
}

function filenameFromUrl(imageUrl: string): string | null {
  if (imageUrl.startsWith("data:")) return null;

  try {
    const parsed = new URL(imageUrl, "https://codex.local");
    const pathname = parsed.pathname || "";
    const segment = pathname.split("/").filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
}

function extractCodexImageFiles(content: ContentBlock[]): UploadedFileInfo[] {
  const files: UploadedFileInfo[] = [];
  let imageIndex = 0;

  for (const block of content) {
    if (!isInputImageBlock(block)) continue;
    imageIndex += 1;

    const filePath =
      typeof block.file_path === "string" ? block.file_path.trim() : "";
    const imageUrl =
      typeof block.image_url === "string" ? block.image_url.trim() : "";
    const inlineData = imageUrl ? parseInlineImageData(imageUrl) : {};

    const mimeType =
      (typeof block.mime_type === "string" && block.mime_type.trim()) ||
      inlineData.mimeType ||
      (filePath ? getMimeTypeFromPath(filePath) : undefined) ||
      (imageUrl ? getMimeTypeFromPath(imageUrl) : undefined) ||
      "image/*";

    const fileName =
      (filePath && getFilename(filePath)) ||
      (imageUrl && filenameFromUrl(imageUrl)) ||
      `pasted-image-${imageIndex}.${extensionForMimeType(mimeType)}`;

    const path =
      filePath ||
      (imageUrl && !imageUrl.startsWith("data:") ? imageUrl : "") ||
      `codex-inline://image/${imageIndex}`;

    files.push({
      originalName: fileName,
      size: formatFileSize(inlineData.bytes),
      mimeType,
      path,
      previewUrl: imageUrl || undefined,
    });
  }

  return files;
}

function mergeUploadedFiles(
  primary: UploadedFileInfo[],
  secondary: UploadedFileInfo[],
): UploadedFileInfo[] {
  const seen = new Set<string>();
  const merged: UploadedFileInfo[] = [];

  for (const file of [...primary, ...secondary]) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    merged.push(file);
  }

  return merged;
}

/**
 * Renders uploaded file attachments below the user prompt
 */
function UploadedFilesMetadata({ files }: { files: UploadedFileInfo[] }) {
  if (files.length === 0) return null;

  return (
    <div className="user-prompt-metadata">
      {files.map((file) => (
        <AttachmentChip
          key={file.path}
          originalName={file.originalName}
          path={file.path}
          mimeType={file.mimeType}
          sizeLabel={file.size}
          imageWidth={file.width}
          imageHeight={file.height}
          previewUrl={file.previewUrl}
        />
      ))}
    </div>
  );
}

/**
 * Renders text content with optional truncation and "Show more" button
 */
function CollapsibleText({ text }: { text: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = text.split("\n");
  const exceedsLines = lines.length > MAX_LINES;
  const exceedsChars = text.length > MAX_CHARS;
  const needsTruncation = exceedsLines || exceedsChars;

  if (!needsTruncation || isExpanded) {
    return (
      <div className="text-block">
        {text}
        {isExpanded && needsTruncation && (
          <button
            type="button"
            className="show-more-btn"
            onClick={() => setIsExpanded(false)}
          >
            Show less
          </button>
        )}
      </div>
    );
  }

  // Truncate by lines first, then by characters if still too long
  let truncatedText = exceedsLines
    ? lines.slice(0, MAX_LINES).join("\n")
    : text;
  if (truncatedText.length > MAX_CHARS) {
    truncatedText = truncatedText.slice(0, MAX_CHARS);
  }

  return (
    <div className="text-block collapsible-text">
      <div className="truncated-content">
        {truncatedText}
        <div className="fade-overlay" />
      </div>
      <button
        type="button"
        className="show-more-btn"
        onClick={() => setIsExpanded(true)}
      >
        Show more
      </button>
    </div>
  );
}

function UserPromptActionButtons({
  onCorrect,
  onTrimBefore,
  onForkBefore,
  copyText,
  extraActions,
}: {
  onCorrect?: () => void;
  onTrimBefore?: () => void;
  onForkBefore?: () => void;
  copyText?: string;
  extraActions?: ReactNode;
}) {
  const { t } = useI18n();

  if (
    !onCorrect &&
    !onTrimBefore &&
    !onForkBefore &&
    !copyText &&
    !extraActions
  )
    return null;

  return (
    <div className="user-prompt-actions">
      {copyText && (
        <CopyTextButton
          text={copyText}
          label={t("userPromptCopyAction")}
          className="user-prompt-action user-prompt-action-copy"
        />
      )}
      {onCorrect && (
        <button
          type="button"
          className="user-prompt-action user-prompt-action-edit"
          onClick={onCorrect}
          aria-label={t("userPromptEditAction")}
          title={t("userPromptEditAction")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          <span className="user-prompt-correct-label">Edit</span>
        </button>
      )}
      {onForkBefore && (
        <button
          type="button"
          className="user-prompt-action user-prompt-action-fork-before"
          onClick={onForkBefore}
          aria-label={t("forkBeforeTurnLabel")}
          title={t("forkBeforeTurnTooltip")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="12" r="3" />
            <path d="M6 9v6" />
            <path d="M8.5 7.5 15 11" />
          </svg>
        </button>
      )}
      {onTrimBefore && (
        <button
          type="button"
          className="user-prompt-action user-prompt-action-show-starting"
          onClick={onTrimBefore}
          aria-label={t("userPromptShowStartingHere")}
          title={t("userPromptShowStartingHere")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 7h16" />
            <path d="M4 12h10" />
            <path d="M4 17h6" />
            <path d="m15 16 3 3 3-3" />
            <path d="M18 5v14" />
          </svg>
        </button>
      )}
      {extraActions}
    </div>
  );
}

function UserPromptText({ text }: { text: string }) {
  const correction = parseCorrectionDisplay(text);
  if (!correction) {
    return <CollapsibleText text={text} />;
  }

  return (
    <div className="user-prompt-correction">
      <div className="user-prompt-correction-label">Correction</div>
      <CollapsibleText text={correction.correctedText} />
      {correction.change && (
        <div className="user-prompt-correction-change">
          Change: {correction.change}
        </div>
      )}
    </div>
  );
}

export const UserPromptBlock = memo(function UserPromptBlock({
  content,
  onCorrect,
  onTrimBefore,
  onForkBefore,
  extraActions,
}: Props) {
  if (typeof content === "string") {
    const { text, openedFiles, uploadedFiles } = parseUserPrompt(content);

    // Don't render if there's no actual text content
    if (!text) {
      const hasMetadata = openedFiles.length > 0 || uploadedFiles.length > 0;
      return hasMetadata ? (
        <>
          <UploadedFilesMetadata files={uploadedFiles} />
          <OpenedFilesMetadata files={openedFiles} />
        </>
      ) : null;
    }

    return (
      <div
        className={`user-prompt-container ${shouldStackUserPromptActions(text) ? "has-stacked-actions" : ""}`}
      >
        <div
          className={`message message-user-prompt ${onCorrect ? "user-prompt-correctable" : ""}`}
        >
          <div className="message-content">
            <UserPromptText text={text} />
            <UploadedFilesMetadata files={uploadedFiles} />
          </div>
        </div>
        <UserPromptActionButtons
          onCorrect={onCorrect}
          onTrimBefore={onTrimBefore}
          onForkBefore={onForkBefore}
          copyText={getUserPromptCopyText(text)}
          extraActions={extraActions}
        />
        <OpenedFilesMetadata files={openedFiles} />
      </div>
    );
  }

  // Array content - extract text blocks for display
  const textContent = content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
  const codexImageFiles = extractCodexImageFiles(content);
  const textForParsing =
    codexImageFiles.length > 0
      ? stripCodexImageMarkers(textContent)
      : textContent;

  // Parse the combined text content for metadata
  const { text, openedFiles, uploadedFiles } = parseUserPrompt(textForParsing);
  const allUploadedFiles = mergeUploadedFiles(uploadedFiles, codexImageFiles);

  if (!text) {
    const hasMetadata = openedFiles.length > 0 || allUploadedFiles.length > 0;
    return hasMetadata ? (
      <>
        <UploadedFilesMetadata files={allUploadedFiles} />
        <OpenedFilesMetadata files={openedFiles} />
      </>
    ) : (
      <div className="message message-user-prompt">
        <div className="message-content">
          <div className="text-block">[Complex content]</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`user-prompt-container ${shouldStackUserPromptActions(text) ? "has-stacked-actions" : ""}`}
    >
      <div
        className={`message message-user-prompt ${onCorrect ? "user-prompt-correctable" : ""}`}
      >
        <div className="message-content">
          <UserPromptText text={text} />
          <UploadedFilesMetadata files={allUploadedFiles} />
        </div>
      </div>
      <UserPromptActionButtons
        onCorrect={onCorrect}
        onTrimBefore={onTrimBefore}
        onForkBefore={onForkBefore}
        copyText={getUserPromptCopyText(text)}
        extraActions={extraActions}
      />
      <OpenedFilesMetadata files={openedFiles} />
    </div>
  );
});
