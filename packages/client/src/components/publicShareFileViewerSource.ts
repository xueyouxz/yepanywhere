import type { FileContentResponse } from "@yep-anywhere/shared";
import {
  buildPublicShareRawFileApiPath,
  normalizePublicShareFilePath,
  type PublicShareContextValue,
  rewritePublicShareLocalAppLinks,
} from "../contexts/PublicShareContext";
import { getEmbeddedFileMediaBlob } from "../lib/embeddedFileMedia";
import {
  fetchPublicShareBlobViaRelay,
  fetchPublicShareJsonViaRelay,
} from "../lib/publicShareRelay";
import type { FileViewerSource } from "./FileViewer";

function rewriteRenderedMarkdownHtml(
  html: string,
  context: PublicShareContextValue,
): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  rewritePublicShareLocalAppLinks(template.content, context);
  return template.innerHTML;
}

export function createPublicShareFileViewerSource(
  context: PublicShareContextValue,
): FileViewerSource {
  const fetchRawFileBlob = async (
    fileData: FileContentResponse,
    rawPath: string,
  ): Promise<Blob> => {
    const normalized = normalizePublicShareFilePath(rawPath, context.projectId);
    const embedded =
      (normalized
        ? getEmbeddedFileMediaBlob(fileData, normalized.path)
        : null) ?? getEmbeddedFileMediaBlob(fileData, rawPath);
    if (embedded) {
      return embedded;
    }
    if (!normalized) {
      throw new Error("File is outside this public share");
    }
    const params = new URLSearchParams({ path: normalized.path });
    return await fetchPublicShareBlobViaRelay({
      relayUrl: context.relayUrl,
      relayUsername: context.relayUsername,
      path: `/public-api/shares/${encodeURIComponent(context.secret)}/files/raw?${params}`,
    });
  };

  return {
    loadFile: async (
      _projectId,
      rawPath,
      highlight,
      lineNumber,
      lineEnd,
      viewMode,
    ) => {
      const params = new URLSearchParams({ path: rawPath });
      if (highlight) {
        params.set("highlight", "true");
      }
      if (lineNumber !== undefined) {
        params.set("line", String(lineNumber));
      }
      if (lineEnd !== undefined) {
        params.set("lineEnd", String(lineEnd));
      }
      if (viewMode === "range") {
        params.set("view", "range");
      }
      return await fetchPublicShareJsonViaRelay<FileContentResponse>({
        relayUrl: context.relayUrl,
        relayUsername: context.relayUsername,
        path: `/public-api/shares/${encodeURIComponent(context.secret)}/files?${params}`,
      });
    },
    getRawFileUrl: () => null,
    fetchRawFileBlob,
    createMediaSource: (fileData) => ({
      buildApiPath: (rawPath) =>
        buildPublicShareRawFileApiPath(context, rawPath),
      fetchBlob: async (rawPath) =>
        await fetchRawFileBlob(
          fileData ??
            ({
              embeddedMedia: {},
            } as FileContentResponse),
          rawPath,
        ),
    }),
    transformRenderedMarkdownHtml: (html) =>
      rewriteRenderedMarkdownHtml(html, context),
  };
}
