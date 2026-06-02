import type { FileContentResponse } from "@yep-anywhere/shared";
import { DEFAULT_RELAY_URL, normalizeRelayUrl } from "@yep-anywhere/shared";
import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { FileViewer, type FileViewerSource } from "../components/FileViewer";
import {
  buildPublicShareRawFileApiPath,
  normalizePublicShareFilePath,
  PublicShareProvider,
  rewritePublicShareLocalAppLinks,
  type PublicShareContextValue,
} from "../contexts/PublicShareContext";
import { useI18n } from "../i18n";
import { getEmbeddedFileMediaBlob } from "../lib/embeddedFileMedia";
import {
  fetchPublicShareBlobViaRelay,
  fetchPublicShareJsonViaRelay,
} from "../lib/publicShareRelay";

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function rewriteRenderedMarkdownHtml(
  html: string,
  context: PublicShareContextValue,
): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  rewritePublicShareLocalAppLinks(template.content, context);
  return template.innerHTML;
}

export function PublicShareFilePage() {
  const { t } = useI18n();
  const { secret } = useParams<{ secret: string }>();
  const [searchParams] = useSearchParams();
  const filePath = searchParams.get("path") ?? "";
  const projectId = searchParams.get("projectId");
  const relayUsername = searchParams.get("h") ?? "";
  const lineNumber = parsePositiveInteger(searchParams.get("line"));

  const relayConfig = useMemo((): { error: string | null; url: string } => {
    try {
      return {
        error: null,
        url: normalizeRelayUrl(searchParams.get("r") ?? DEFAULT_RELAY_URL),
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        url: DEFAULT_RELAY_URL,
      };
    }
  }, [searchParams]);

  const publicShareContext = useMemo<PublicShareContextValue | null>(() => {
    if (!secret || !relayUsername) {
      return null;
    }
    return {
      projectId,
      relayUrl: relayConfig.url,
      relayUsername,
      secret,
    };
  }, [projectId, relayConfig.url, relayUsername, secret]);

  const shareHref = useMemo(() => {
    if (!secret) {
      return "/share";
    }
    const params = new URLSearchParams();
    if (relayUsername) params.set("h", relayUsername);
    if (relayConfig.url) params.set("r", relayConfig.url);
    if (projectId) params.set("projectId", projectId);
    const query = params.toString();
    return `/share/${encodeURIComponent(secret)}${query ? `?${query}` : ""}`;
  }, [projectId, relayConfig.url, relayUsername, secret]);

  const source = useMemo<FileViewerSource | null>(() => {
    if (!secret || !relayUsername || !filePath || relayConfig.error) {
      return null;
    }
    const fetchRawFileBlob = async (
      fileData: FileContentResponse,
      rawPath: string,
    ): Promise<Blob> => {
      const normalized = publicShareContext
        ? normalizePublicShareFilePath(rawPath, publicShareContext.projectId)
            ?.path
        : null;
      const embedded =
        (normalized ? getEmbeddedFileMediaBlob(fileData, normalized) : null) ??
        getEmbeddedFileMediaBlob(fileData, rawPath);
      if (embedded) {
        return embedded;
      }
      const params = new URLSearchParams({ path: normalized ?? rawPath });
      return await fetchPublicShareBlobViaRelay({
        relayUrl: relayConfig.url,
        relayUsername,
        path: `/public-api/shares/${encodeURIComponent(secret)}/files/raw?${params}`,
      });
    };
    return {
      loadFile: async (_projectId, rawPath, highlight) => {
        const params = new URLSearchParams({ path: rawPath });
        if (highlight) {
          params.set("highlight", "true");
        }
        return await fetchPublicShareJsonViaRelay<FileContentResponse>({
          relayUrl: relayConfig.url,
          relayUsername,
          path: `/public-api/shares/${encodeURIComponent(secret)}/files?${params}`,
        });
      },
      getRawFileUrl: () => null,
      fetchRawFileBlob,
      createMediaSource: (fileData) => ({
        buildApiPath: (rawPath) =>
          publicShareContext
            ? buildPublicShareRawFileApiPath(publicShareContext, rawPath)
            : null,
        fetchBlob: async (rawPath) => {
          if (!publicShareContext) {
            throw new Error("File is outside this public share");
          }
          return await fetchRawFileBlob(
            fileData ??
              ({
                embeddedMedia: {},
              } as FileContentResponse),
            rawPath,
          );
        },
      }),
      transformRenderedMarkdownHtml: (html) =>
        publicShareContext
          ? rewriteRenderedMarkdownHtml(html, publicShareContext)
          : html,
    };
  }, [
    filePath,
    publicShareContext,
    relayConfig.error,
    relayConfig.url,
    relayUsername,
    secret,
  ]);

  const content = (
    <div className="file-page">
      <div className="file-page-nav">
        <Link to={shareHref} className="file-page-back-link">
          <span>{t("publicShareBackToShare" as never)}</span>
        </Link>
      </div>
      <div className="file-page-content">
        {source ? (
          <FileViewer
            projectId={projectId ?? ""}
            filePath={filePath}
            lineNumber={lineNumber}
            source={source}
            standalone
          />
        ) : (
          <div className="file-viewer">
            <div className="file-viewer-error">
              {relayConfig.error || t("fileInvalidUrl" as never)}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return publicShareContext ? (
    <PublicShareProvider value={publicShareContext}>
      {content}
    </PublicShareProvider>
  ) : (
    content
  );
}
