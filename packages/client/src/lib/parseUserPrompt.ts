import {
  parseOpenedFiles,
  getFilename as sharedGetFilename,
  stripIdeMetadata,
} from "@yep-anywhere/shared";

/**
 * Uploaded file attachment metadata
 */
export interface UploadedFileInfo {
  originalName: string;
  size: string;
  mimeType: string;
  path: string;
  width?: number;
  height?: number;
  /** Optional direct preview URL for inline provider attachments (e.g. data: URLs) */
  previewUrl?: string;
}

function normalizeSizeLabel(size: string): string {
  const trimmed = size.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B)$/i);
  if (!match) {
    return trimmed;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return trimmed;
  }

  const unit = (match[2] ?? "").toUpperCase();
  if (unit === "B") {
    return `${Math.round(value)}\u202fb`;
  }
  if (unit === "KB") {
    return `${Math.round(value)}\u202fkb`;
  }
  return `${Math.round(value * 10) / 10}\u202f${unit[0]?.toLowerCase() ?? ""}b`;
}

/**
 * Parsed user prompt with metadata extracted
 */
export interface ParsedUserPrompt {
  /** The actual user message text (without metadata tags) */
  text: string;
  /** Full paths of files the user had open in their IDE */
  openedFiles: string[];
  /** Uploaded file attachments */
  uploadedFiles: UploadedFileInfo[];
}

/**
 * Extracts the filename from a full file path.
 * Re-exported from shared for backward compatibility.
 */
export const getFilename = sharedGetFilename;

/**
 * Parse the uploaded-files section from message content.
 * Supports markdown link lines and the older plain path format.
 */
function parseUploadedFiles(content: string): {
  textWithoutUploads: string;
  uploadedFiles: UploadedFileInfo[];
} {
  const uploadedFiles: UploadedFileInfo[] = [];

  // Match the uploaded-files section
  const markers = [
    "\n\nUser uploaded files in .attachments:\n",
    "\n\nUser uploaded files:\n",
  ];
  const markerIndex = markers
    .map((marker) => content.indexOf(marker))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0];

  if (markerIndex === undefined) {
    return { textWithoutUploads: content, uploadedFiles: [] };
  }

  const uploadMarker = markers.find((marker) =>
    content.startsWith(marker, markerIndex),
  );
  if (!uploadMarker) {
    return { textWithoutUploads: content, uploadedFiles: [] };
  }

  const textWithoutUploads = content.slice(0, markerIndex);
  const uploadSection = content.slice(markerIndex + uploadMarker.length);

  // Parse each line:
  // - [name](path) (size, mimetype)
  // - [name](path) (size, mimetype, WxH)
  // - filename (size, mimetype): path
  const markdownRegex =
    /^- \[(.+?)\]\((?:<(.+?)>|(.+?))\) \(([^,]+), ([^,()]+?)(?:, (\d+)x(\d+))?\)$/;
  const legacyRegex = /^- (.+?) \(([^,]+), ([^)]+)\): (.+)$/;
  for (const line of uploadSection.split("\n")) {
    const markdownMatch = line.match(markdownRegex);
    if (markdownMatch) {
      uploadedFiles.push({
        originalName: markdownMatch[1] ?? "",
        path: markdownMatch[2] ?? markdownMatch[3] ?? "",
        size: normalizeSizeLabel(markdownMatch[4] ?? ""),
        mimeType: markdownMatch[5] ?? "",
        width: markdownMatch[6] ? Number(markdownMatch[6]) : undefined,
        height: markdownMatch[7] ? Number(markdownMatch[7]) : undefined,
      });
      continue;
    }
    const legacyMatch = line.match(legacyRegex);
    if (legacyMatch) {
      uploadedFiles.push({
        originalName: legacyMatch[1] ?? "",
        size: normalizeSizeLabel(legacyMatch[2] ?? ""),
        mimeType: legacyMatch[3] ?? "",
        path: legacyMatch[4] ?? "",
      });
    }
  }

  return { textWithoutUploads, uploadedFiles };
}

/**
 * Parses user prompt content, extracting ide_opened_file metadata tags
 * and "User uploaded files:" sections.
 * Returns the cleaned text, list of opened file paths, and uploaded files.
 *
 * Also handles <ide_selection> tags by stripping them from the text.
 */
export function parseUserPrompt(content: string): ParsedUserPrompt {
  // First extract uploaded files section
  const { textWithoutUploads, uploadedFiles } = parseUploadedFiles(content);

  // Then process IDE metadata on the remaining text
  return {
    text: stripIdeMetadata(textWithoutUploads),
    openedFiles: parseOpenedFiles(textWithoutUploads),
    uploadedFiles,
  };
}
