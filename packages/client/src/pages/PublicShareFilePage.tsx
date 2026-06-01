import type { FileContentResponse } from "@yep-anywhere/shared";
import { DEFAULT_RELAY_URL, normalizeRelayUrl } from "@yep-anywhere/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  PublicShareProvider,
  rewritePublicShareLocalAppLinks,
  type PublicShareContextValue,
} from "../contexts/PublicShareContext";
import { useI18n } from "../i18n";
import {
  fetchPublicShareBlobViaRelay,
  fetchPublicShareJsonViaRelay,
} from "../lib/publicShareRelay";

function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
}

function isImageFile(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function PublicShareFilePage() {
  const { t } = useI18n();
  const { secret } = useParams<{ secret: string }>();
  const [searchParams] = useSearchParams();
  const filePath = searchParams.get("path") ?? "";
  const projectId = searchParams.get("projectId");
  const relayUsername = searchParams.get("h") ?? "";
  const lineNumber = parsePositiveInteger(searchParams.get("line"));
  const [fileData, setFileData] = useState<FileContentResponse | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const markdownPreviewRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!secret || !relayUsername || !filePath) {
      setError(t("fileInvalidUrl" as never));
      setLoading(false);
      return;
    }
    if (relayConfig.error) {
      setError(relayConfig.error);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setBlobUrl(null);
    const params = new URLSearchParams({ highlight: "true", path: filePath });
    void fetchPublicShareJsonViaRelay<FileContentResponse>({
      relayUrl: relayConfig.url,
      relayUsername,
      path: `/public-api/shares/${encodeURIComponent(secret)}/files?${params}`,
    })
      .then((data) => {
        if (cancelled) return;
        setFileData(data);
        setShowPreview(
          lineNumber === undefined &&
            isMarkdownFile(filePath) &&
            Boolean(data.renderedMarkdownHtml),
        );
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    filePath,
    lineNumber,
    relayConfig.error,
    relayConfig.url,
    relayUsername,
    secret,
    t,
  ]);

  useEffect(() => {
    if (!fileData || !isImageFile(fileData.metadata.mimeType)) {
      return;
    }
    if (!secret || !relayUsername || relayConfig.error) {
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ path: filePath });
    void fetchPublicShareBlobViaRelay({
      relayUrl: relayConfig.url,
      relayUsername,
      path: `/public-api/shares/${encodeURIComponent(secret)}/files/raw?${params}`,
    })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setBlobUrl(url);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [
    fileData,
    filePath,
    relayConfig.error,
    relayConfig.url,
    relayUsername,
    secret,
  ]);

  useEffect(() => {
    if (!publicShareContext || !markdownPreviewRef.current) {
      return;
    }
    rewritePublicShareLocalAppLinks(
      markdownPreviewRef.current,
      publicShareContext,
    );
  }, [fileData?.renderedMarkdownHtml, publicShareContext, showPreview]);

  useEffect(
    () => () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    },
    [blobUrl],
  );

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

  const body = (() => {
    if (loading) {
      return (
        <div className="file-viewer-loading">
          {t("fileViewerLoading" as never, { name: getFileName(filePath) })}
        </div>
      );
    }
    if (error || !fileData) {
      return (
        <div className="file-viewer-error">
          {error || t("fileViewerNotFound" as never)}
        </div>
      );
    }

    if (isImageFile(fileData.metadata.mimeType)) {
      return (
        <div className="file-viewer-image">
          {blobUrl ? (
            <img src={blobUrl} alt={getFileName(filePath)} />
          ) : (
            <div className="file-viewer-loading">
              {t("fileViewerLoading" as never, { name: getFileName(filePath) })}
            </div>
          )}
        </div>
      );
    }

    if (fileData.content === undefined) {
      return (
        <div className="file-viewer-binary">
          <p>{t("fileViewerBinary" as never)}</p>
          <p>
            <strong>{t("fileViewerType" as never)}</strong>{" "}
            {fileData.metadata.mimeType}
          </p>
          <p>
            <strong>{t("fileViewerSize" as never)}</strong>{" "}
            {formatFileSize(fileData.metadata.size)}
          </p>
        </div>
      );
    }

    const hasMarkdownPreview =
      isMarkdownFile(filePath) && !!fileData.renderedMarkdownHtml;
    const toggleButton = hasMarkdownPreview && (
      <div className="markdown-view-toggle">
        <button
          type="button"
          className={`toggle-btn ${!showPreview ? "active" : ""}`}
          onClick={() => setShowPreview(false)}
        >
          {t("fileViewerSource" as never)}
        </button>
        <button
          type="button"
          className={`toggle-btn ${showPreview ? "active" : ""}`}
          onClick={() => setShowPreview(true)}
        >
          {t("fileViewerPreview" as never)}
        </button>
      </div>
    );

    if (showPreview && fileData.renderedMarkdownHtml) {
      return (
        <>
          {toggleButton}
          <div className="markdown-preview" ref={markdownPreviewRef}>
            <div
              className="markdown-rendered"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
              dangerouslySetInnerHTML={{
                __html: fileData.renderedMarkdownHtml,
              }}
            />
          </div>
        </>
      );
    }

    const lines = fileData.content.split("\n");
    return (
      <>
        {toggleButton}
        <div className="file-viewer-code">
          <div className="code-highlighter-plain">
            <div className="code-line-numbers">
              {lines.map((_, index) => (
                <div key={`ln-${index + 1}`}>{index + 1}</div>
              ))}
            </div>
            <pre className="code-content">
              <code>
                {lines.map((line, index) => {
                  const number = index + 1;
                  const highlighted = lineNumber === number;
                  return (
                    <div
                      className={highlighted ? "highlighted-line" : undefined}
                      key={`line-${number}`}
                      style={
                        highlighted
                          ? {
                              backgroundColor: "rgba(255, 255, 0, 0.15)",
                              marginLeft: "-0.75rem",
                              marginRight: "-0.75rem",
                              paddingLeft: "0.75rem",
                              paddingRight: "0.75rem",
                            }
                          : undefined
                      }
                    >
                      {line || " "}
                    </div>
                  );
                })}
              </code>
            </pre>
          </div>
        </div>
      </>
    );
  })();

  const content = (
    <div className="file-page">
      <div className="file-page-nav">
        <Link to={shareHref} className="file-page-back-link">
          <span>{t("publicShareBackToShare" as never)}</span>
        </Link>
      </div>
      <div className="file-page-content">
        <div className="file-viewer">
          {fileData && (
            <div className="file-viewer-header">
              <div className="file-viewer-info">
                <span className="file-viewer-path" title={filePath}>
                  {filePath}
                </span>
                <span className="file-viewer-meta">
                  {formatFileSize(fileData.metadata.size)}
                  {fileData.metadata.isText &&
                    fileData.content &&
                    ` \u2022 ${t("fileViewerLines" as never, {
                      count: fileData.content.split("\n").length,
                    })}`}
                </span>
              </div>
            </div>
          )}
          {body}
        </div>
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
