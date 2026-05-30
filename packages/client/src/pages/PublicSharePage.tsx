import {
  sanitizeSessionTitle,
  type PublicSessionShareMode,
  type PublicSessionShareResponse,
  type RelayResponse,
} from "@yep-anywhere/shared";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { BrandWordmark } from "../components/BrandWordmark";
import { MessageList } from "../components/MessageList";
import { ViewerCountIndicator } from "../components/ViewerCountIndicator";
import { SchemaValidationProvider } from "../contexts/SchemaValidationContext";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import { StreamingMarkdownProvider } from "../contexts/StreamingMarkdownContext";
import { ToastProvider } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import type { Message } from "../types";

const DEFAULT_RELAY_URL = "wss://relay.yepanywhere.com/ws";
const LIVE_POLL_MS = 2000;
const RETRY_POLL_MS = 2000;
const PUBLIC_SHARE_BOTTOM_STICKY_PX = 96;
const PUBLIC_SHARE_VIEWER_ID_KEY = "yep-anywhere-public-share-viewer-id";
const PUBLIC_SHARE_VIEWER_ID_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

interface PublicShareHints {
  capturedAt: string | null;
  initialPrompt: string | null;
  mode: PublicSessionShareMode | null;
  projectName: string | null;
  title: string | null;
}

function generateRequestId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function generateViewerId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 18)}`;
}

function getPublicShareViewerId(): string {
  try {
    const existing = sessionStorage.getItem(PUBLIC_SHARE_VIEWER_ID_KEY);
    if (existing && PUBLIC_SHARE_VIEWER_ID_REGEX.test(existing)) {
      return existing;
    }
    const next = generateViewerId();
    sessionStorage.setItem(PUBLIC_SHARE_VIEWER_ID_KEY, next);
    return next;
  } catch {
    return generateViewerId();
  }
}

async function decodeWebSocketData(data: MessageEvent["data"]): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Blob) {
    return await data.text();
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  return String(data);
}

async function fetchPublicShareViaRelay(options: {
  afterMessageId?: string;
  relayUrl: string;
  relayUsername: string;
  secret: string;
  viewerId: string;
}): Promise<PublicSessionShareResponse> {
  const { afterMessageId, relayUrl, relayUsername, secret, viewerId } = options;
  const ws = new WebSocket(relayUrl);
  const requestId = generateRequestId();

  return await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      ws.close();
      reject(new Error("Share request timed out"));
    }, 30000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "client_connect", username: relayUsername }));
    };

    ws.onerror = () => {
      cleanup();
      reject(new Error("Relay connection failed"));
    };

    ws.onclose = () => {
      cleanup();
      reject(new Error("Relay connection closed"));
    };

    ws.onmessage = (event) => {
      void (async () => {
        let message: unknown;
        try {
          message = JSON.parse(await decodeWebSocketData(event.data));
        } catch {
          return;
        }

        if (
          message &&
          typeof message === "object" &&
          (message as { type?: unknown }).type === "client_connected"
        ) {
          const shareParams = new URLSearchParams({ viewerId });
          if (afterMessageId) {
            shareParams.set("afterMessageId", afterMessageId);
          }
          ws.send(
            JSON.stringify({
              type: "request",
              id: requestId,
              method: "GET",
              path: `/public-api/shares/${encodeURIComponent(secret)}?${shareParams.toString()}`,
              headers: {},
            }),
          );
          return;
        }

        if (
          message &&
          typeof message === "object" &&
          (message as RelayResponse).type === "response" &&
          (message as RelayResponse).id === requestId
        ) {
          const response = message as RelayResponse;
          cleanup();
          ws.close();
          if (response.status >= 400) {
            reject(new Error("Share not found"));
            return;
          }
          resolve(response.body as PublicSessionShareResponse);
        }
      })();
    };
  });
}

function parseShareHints(hash: string): PublicShareHints {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const mode = params.get("m");
  return {
    capturedAt: params.get("c"),
    initialPrompt: params.get("q"),
    mode: mode === "frozen" || mode === "live" ? mode : null,
    projectName: params.get("p"),
    title: params.get("t"),
  };
}

function formatSnapshotDate(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const now = new Date();
  const includeYear = date.getFullYear() !== now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  });
}

function shouldRetryPublicShareError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message === "Relay connection closed" ||
    error.message === "Relay connection failed" ||
    error.message === "Share request timed out"
  );
}

function isNearScrollBottom(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    PUBLIC_SHARE_BOTTOM_STICKY_PX
  );
}

function getPublicShareMessageId(
  message: PublicSessionShareResponse["session"]["messages"][number],
): string | null {
  const value = (message as { id?: unknown; uuid?: unknown }).id;
  if (typeof value === "string" && value) {
    return value;
  }
  const uuid = (message as { uuid?: unknown }).uuid;
  return typeof uuid === "string" && uuid ? uuid : null;
}

function getLastPublicShareMessageId(
  messages: PublicSessionShareResponse["session"]["messages"],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const id = getPublicShareMessageId(message);
    if (id) {
      return id;
    }
  }
  return null;
}

function mergePublicShareResponse(
  current: PublicSessionShareResponse | null,
  next: PublicSessionShareResponse,
  incremental: boolean,
): PublicSessionShareResponse {
  if (
    !current ||
    !incremental ||
    current.share.mode !== "live" ||
    next.share.mode !== "live"
  ) {
    return next;
  }

  const seenMessageIds = new Set<string>();
  for (const message of current.session.messages) {
    const id = getPublicShareMessageId(message);
    if (id) {
      seenMessageIds.add(id);
    }
  }

  const mergedMessages = [...current.session.messages];
  for (const message of next.session.messages) {
    const id = getPublicShareMessageId(message);
    if (id && seenMessageIds.has(id)) {
      continue;
    }
    if (id) {
      seenMessageIds.add(id);
    }
    mergedMessages.push(message);
  }

  return {
    share: next.share,
    session: {
      ...next.session,
      messageCount: Math.max(
        current.session.messageCount,
        next.session.messageCount,
        mergedMessages.length,
      ),
      messages: mergedMessages,
    },
  };
}

export function PublicSharePage() {
  const { t } = useI18n();
  const { secret } = useParams<{ secret: string }>();
  const [searchParams] = useSearchParams();
  const [share, setShare] = useState<PublicSessionShareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [viewerId] = useState(getPublicShareViewerId);
  const scrollRef = useRef<HTMLElement | null>(null);
  const hasRenderedShareRef = useRef(false);
  const lastMessageIdRef = useRef<string | null>(null);
  const shareRef = useRef<PublicSessionShareResponse | null>(null);
  const wasNearBottomRef = useRef(true);

  const relayUsername = searchParams.get("h") ?? "";
  const relayUrl = searchParams.get("r") ?? DEFAULT_RELAY_URL;
  const hints = useMemo(() => parseShareHints(window.location.hash), []);

  const title = useMemo(
    () =>
      share?.share.title ??
      share?.session.customTitle ??
      share?.session.title ??
      hints.title,
    [share, hints.title],
  );
  const projectName = share?.share.source.projectName ?? hints.projectName;
  const mode = share?.share.mode ?? hints.mode;
  const capturedAt = share?.share.capturedAt ?? hints.capturedAt;
  const activeViewerCount = share?.share.activeViewerCount ?? null;
  const badgeLabel = useMemo(() => {
    if (mode === "live") {
      return t("publicShareLiveBadge");
    }
    if (mode === "frozen") {
      const snapshotDate = formatSnapshotDate(capturedAt);
      return snapshotDate
        ? `${t("publicShareFrozenBadge")} ${snapshotDate}`
        : t("publicShareFrozenBadge");
    }
    return null;
  }, [capturedAt, mode, t]);
  const loadStatusLabel = retrying
    ? t("publicShareRetrying")
    : t("publicShareLoading");
  const isFetching = loading || retrying;

  const refresh = useCallback(async (afterMessageId?: string) => {
    if (!secret || !relayUsername) {
      throw new Error(t("publicShareMissingRelay"));
    }
    return await fetchPublicShareViaRelay({
      afterMessageId,
      relayUrl,
      relayUsername,
      secret,
      viewerId,
    });
  }, [relayUrl, relayUsername, secret, t, viewerId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      try {
        const afterMessageId =
          shareRef.current?.share.mode === "live"
            ? (lastMessageIdRef.current ?? undefined)
            : undefined;
        const response = await refresh(afterMessageId);
        if (cancelled) return;
        const nextShare = mergePublicShareResponse(
          shareRef.current,
          response,
          !!afterMessageId,
        );
        shareRef.current = nextShare;
        lastMessageIdRef.current = getLastPublicShareMessageId(
          nextShare.session.messages,
        );
        setShare(nextShare);
        setError(null);
        setLoading(false);
        setRetrying(false);
        if (response.share.mode === "live") {
          timer = setTimeout(run, LIVE_POLL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        if (shouldRetryPublicShareError(err)) {
          setRetrying(true);
          setError(null);
          timer = setTimeout(run, RETRY_POLL_MS);
          return;
        }
        setRetrying(false);
        setError(err instanceof Error ? err.message : t("publicShareUnavailable"));
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [refresh, t]);

  useEffect(() => {
    const safeTitle = title ? sanitizeSessionTitle(title) : "";
    document.title = safeTitle ? `${safeTitle} - Public Share` : "Public Share";
  }, [title]);

  const handleScroll = useCallback(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    wasNearBottomRef.current = isNearScrollBottom(scrollElement);
  }, []);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !share) return;

    if (!hasRenderedShareRef.current) {
      hasRenderedShareRef.current = true;
      wasNearBottomRef.current = isNearScrollBottom(scrollElement);
      return;
    }

    if (wasNearBottomRef.current) {
      scrollElement.scrollTop = scrollElement.scrollHeight;
    }
  }, [share]);

  const messageContent = share ? (
    <SessionMetadataProvider
      projectId={share.share.source.projectId}
      projectPath={null}
      sessionId={share.share.source.sessionId}
    >
      <MessageList
        messages={share.session.messages as Message[]}
        provider={share.session.provider}
      />
    </SessionMetadataProvider>
  ) : null;

  return (
    <main className="public-share-page">
      <header className="public-share-header">
        <div className="public-share-header-inner">
          <div className="public-share-header-left">
            <BrandWordmark
              variant="full"
              className="public-share-brand-wordmark"
            />
            {projectName && (
              <span className="public-share-project" title={projectName}>
                {projectName}
              </span>
            )}
            <div className="public-share-title-row">
              <h1 className="public-share-title">
                {title ?? t("publicShareUntitled")}
              </h1>
            </div>
          </div>
          <div className="public-share-header-actions">
            {mode === "live" && activeViewerCount !== null && (
              <ViewerCountIndicator
                className="public-share-viewer-count"
                count={activeViewerCount}
                label={t("publicShareActiveViewers", {
                  count: activeViewerCount,
                })}
              />
            )}
            {badgeLabel && (
              <span className="public-share-badge">{badgeLabel}</span>
            )}
          </div>
        </div>
      </header>
      <section
        className="public-share-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        <ToastProvider>
          <SchemaValidationProvider>
            <StreamingMarkdownProvider>
              {error && !retrying && !share ? (
                <div className="public-share-error public-share-error--inline">
                  {error}
                </div>
              ) : messageContent ? (
                messageContent
              ) : hints.initialPrompt ? (
                <div className="public-share-preview">
                  <div className="public-share-preview-text">
                    {hints.initialPrompt}
                  </div>
                  <div className="public-share-fetch-status" role="status">
                    <span className="public-share-spinner" aria-hidden="true" />
                    {loadStatusLabel}
                  </div>
                </div>
              ) : (
                <div className="public-share-empty">
                  {isFetching && (
                    <span
                      className="public-share-spinner"
                      aria-hidden="true"
                    />
                  )}
                  {loadStatusLabel}
                </div>
              )}
            </StreamingMarkdownProvider>
          </SchemaValidationProvider>
        </ToastProvider>
      </section>
    </main>
  );
}
