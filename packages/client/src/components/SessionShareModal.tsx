import type {
  PublicSessionShareMode,
  PublicSessionShareSessionStatusResponse,
  PublicSessionShareViewerSummary,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { Modal, type ModalAnchorRect } from "./ui/Modal";
import { ViewerCountIndicator } from "./ViewerCountIndicator";

interface SessionShareModalProps {
  anchorRect?: ModalAnchorRect | null;
  initialPrompt?: string | null;
  projectId: string;
  sessionId: string;
  title?: string | null;
  onStatusChange?: (status: PublicSessionShareSessionStatusResponse) => void;
  onClose: () => void;
}

const CLIPBOARD_WRITE_TIMEOUT_MS = 250;
const STATUS_POLL_MS = 10_000;

type ShareWorkingState =
  | PublicSessionShareMode
  | "freeze-all"
  | "revoke"
  | `disconnect:${string}`
  | `freeze:${string}`;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function writeClipboardText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      const copied = await withTimeout(
        navigator.clipboard.writeText(text).then(() => true),
        CLIPBOARD_WRITE_TIMEOUT_MS,
      );
      if (copied) {
        return true;
      }
    } catch {
      // Fall through to the legacy selection-based copy path.
    }
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.top = "0";
  textArea.style.left = "-9999px";
  textArea.style.opacity = "0";
  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  document.body.appendChild(textArea);
  textArea.focus({ preventScroll: true });
  textArea.select();
  textArea.setSelectionRange(0, textArea.value.length);

  let copied = false;
  try {
    if (typeof document.execCommand === "function") {
      document.execCommand("copy");
      copied = true;
    }
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textArea);
    activeElement?.focus({ preventScroll: true });
  }

  return copied;
}

export function SessionShareModal({
  anchorRect,
  initialPrompt,
  projectId,
  sessionId,
  title,
  onStatusChange,
  onClose,
}: SessionShareModalProps) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] =
    useState<PublicSessionShareSessionStatusResponse | null>(null);
  const [isWorking, setIsWorking] = useState<ShareWorkingState | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refreshStatus = async () => {
      try {
        const nextStatus = await api.getPublicSessionShareStatus(
          projectId,
          sessionId,
        );
        if (!cancelled) {
          setStatus(nextStatus);
          onStatusChange?.(nextStatus);
        }
      } catch {
        if (!cancelled) {
          setStatus(null);
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(refreshStatus, STATUS_POLL_MS);
        }
      }
    };

    void refreshStatus();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [onStatusChange, projectId, sessionId]);

  const copyUrl = async (nextUrl: string) => {
    const copied = await writeClipboardText(nextUrl);
    if (copied) {
      setResult(t("sessionShareCopiedReadOnly"));
      return;
    }
    window.setTimeout(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    }, 0);
    setResult(t("sessionShareManualCopy"));
  };

  const createAndCopyShare = async (mode: PublicSessionShareMode) => {
    setIsWorking(mode);
    setError(null);
    setResult(null);
    try {
      const result = await api.createPublicSessionShare({
        projectId: projectId as UrlProjectId,
        sessionId,
        mode,
        initialPrompt: initialPrompt ?? undefined,
        title: title ?? undefined,
      });
      setUrl(result.url);
      await copyUrl(result.url);
      setStatus((current) => {
        const frozenDelta = mode === "frozen" ? 1 : 0;
        const liveDelta = mode === "live" ? 1 : 0;
        const nextStatus = {
          activeCount: (current?.activeCount ?? 0) + 1,
          frozenCount: (current?.frozenCount ?? 0) + frozenDelta,
          liveCount: (current?.liveCount ?? 0) + liveDelta,
          activeViewerCount: current?.activeViewerCount ?? 0,
          viewers: current?.viewers ?? [],
        };
        onStatusChange?.(nextStatus);
        return nextStatus;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sessionShareFailed"));
    } finally {
      setIsWorking(null);
    }
  };

  const revokeAll = async () => {
    setIsWorking("revoke");
    setError(null);
    setResult(null);
    try {
      const response = await api.revokePublicSessionShares(projectId, sessionId);
      setStatus(response);
      onStatusChange?.(response);
      setUrl(null);
      setResult(t("sessionShareRevoked", { count: response.revokedCount }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sessionShareRevokeFailed"));
    } finally {
      setIsWorking(null);
    }
  };

  const freezeAllLive = async () => {
    setIsWorking("freeze-all");
    setError(null);
    setResult(null);
    try {
      const response = await api.freezePublicSessionLiveShares(
        projectId,
        sessionId,
      );
      setStatus(response);
      onStatusChange?.(response);
      setResult(
        t("sessionShareFrozenLiveLinks", {
          count: response.convertedCount,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sessionShareFreezeFailed"));
    } finally {
      setIsWorking(null);
    }
  };

  const freezeViewerToken = async (viewer: PublicSessionShareViewerSummary) => {
    setIsWorking(`freeze:${viewer.viewerId}`);
    setError(null);
    setResult(null);
    try {
      const response = await api.freezePublicSessionViewerToken(
        projectId,
        sessionId,
        viewer.viewerId,
      );
      setStatus(response);
      onStatusChange?.(response);
      setResult(t("sessionShareViewerFrozen", { token: viewer.shortId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sessionShareFreezeFailed"));
    } finally {
      setIsWorking(null);
    }
  };

  const disconnectViewerToken = async (
    viewer: PublicSessionShareViewerSummary,
  ) => {
    setIsWorking(`disconnect:${viewer.viewerId}`);
    setError(null);
    setResult(null);
    try {
      const response = await api.disconnectPublicSessionViewerToken(
        projectId,
        sessionId,
        viewer.viewerId,
      );
      setStatus(response);
      onStatusChange?.(response);
      setResult(t("sessionShareViewerDisconnected", { token: viewer.shortId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sessionShareRevokeFailed"));
    } finally {
      setIsWorking(null);
    }
  };

  const hasActiveShares = (status?.activeCount ?? 0) > 0;
  const activeViewerCount = status?.activeViewerCount ?? 0;
  const viewers = status?.viewers ?? [];
  const viewerSummary = t("sessionShareViewerSummary", {
    active: activeViewerCount,
    total: viewers.length,
    live: status?.liveCount ?? 0,
    frozen: status?.frozenCount ?? 0,
  });

  return (
    <Modal
      anchorRect={anchorRect}
      title={t("sessionShareTitle")}
      onClose={onClose}
    >
      <div className="session-share-modal">
        <p className="session-share-readonly-note">
          {t("sessionShareReadOnlyNote")}
        </p>
        <div className="session-share-actions">
          <button
            type="button"
            className="session-share-action"
            onClick={() => void createAndCopyShare("frozen")}
            disabled={isWorking !== null}
          >
            <span className="session-share-option-title">
              {isWorking === "frozen"
                ? t("sessionShareCopying")
                : t("sessionShareCopyFrozenReadOnly")}
            </span>
            <span className="session-share-option-description">
              {t("sessionShareFrozenDescription")}
            </span>
          </button>
          <button
            type="button"
            className="session-share-action"
            onClick={() => void createAndCopyShare("live")}
            disabled={isWorking !== null}
          >
            <span className="session-share-option-title">
              {isWorking === "live"
                ? t("sessionShareCopying")
                : t("sessionShareCopyLiveReadOnly")}
            </span>
            <span className="session-share-option-description">
              {t("sessionShareLiveDescription")}
            </span>
          </button>
        </div>

        {url && (
          <label className="session-share-url-field">
            <span>{t("sessionShareUrlLabel")}</span>
            <input
              ref={urlInputRef}
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
        )}

        {error && <div className="session-share-error">{error}</div>}
        {result && <div className="session-share-status">{result}</div>}

        {hasActiveShares && (
          <>
            <div className="session-share-management">
              <div className="session-share-management-header">
                <ViewerCountIndicator
                  className="session-share-viewer-count"
                  count={activeViewerCount}
                  label={viewerSummary}
                />
                <div className="session-share-global-controls">
                  <button
                    type="button"
                    className="session-share-small-button"
                    onClick={() => void freezeAllLive()}
                    disabled={isWorking !== null || (status?.liveCount ?? 0) === 0}
                    title={t("sessionShareFreezeLiveTitle")}
                  >
                    {isWorking === "freeze-all"
                      ? t("sessionShareFreezing")
                      : t("sessionShareFreezeLive")}
                  </button>
                  <button
                    type="button"
                    className="session-share-revoke-button"
                    onClick={() => void revokeAll()}
                    disabled={isWorking !== null}
                    title={t("sessionShareRevokeAllTitle")}
                  >
                    {isWorking === "revoke"
                      ? t("sessionShareRevoking")
                      : t("sessionShareRevokeAll")}
                  </button>
                </div>
              </div>
              {viewers.length > 0 && (
                <div
                  className="session-share-viewer-list"
                  aria-label={t("sessionShareViewerList")}
                >
                  {viewers.map((viewer) => (
                    <div
                      className="session-share-viewer-row"
                      key={viewer.viewerId}
                    >
                      <div className="session-share-viewer-main">
                        <span className="session-share-viewer-token">
                          {viewer.shortId}
                        </span>
                        <span className="session-share-viewer-meta">
                          {t("sessionShareViewerMeta", {
                            count: viewer.accessCount,
                            time: new Date(viewer.lastSeenAt).toLocaleString(),
                          })}
                        </span>
                      </div>
                      <div className="session-share-viewer-state">
                        {viewer.disconnected
                          ? t("sessionShareViewerDisconnectedState")
                          : viewer.frozen
                            ? t("sessionShareViewerFrozenState")
                            : viewer.active
                              ? t("sessionShareViewerActiveState")
                              : t("sessionShareViewerInactiveState")}
                      </div>
                      <div className="session-share-viewer-actions">
                        <button
                          type="button"
                          className="session-share-icon-button"
                          onClick={() => void freezeViewerToken(viewer)}
                          disabled={
                            isWorking !== null ||
                            viewer.disconnected ||
                            viewer.frozen ||
                            (status?.liveCount ?? 0) === 0
                          }
                          title={t("sessionShareFreezeViewerTitle", {
                            token: viewer.shortId,
                          })}
                          aria-label={t("sessionShareFreezeViewerTitle", {
                            token: viewer.shortId,
                          })}
                        >
                          |||
                        </button>
                        <button
                          type="button"
                          className="session-share-icon-button session-share-icon-button-danger"
                          onClick={() => void disconnectViewerToken(viewer)}
                          disabled={isWorking !== null || viewer.disconnected}
                          title={t("sessionShareDisconnectViewerTitle", {
                            token: viewer.shortId,
                          })}
                          aria-label={t("sessionShareDisconnectViewerTitle", {
                            token: viewer.shortId,
                          })}
                        >
                          x
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
