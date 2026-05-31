import {
  type AppSession,
  type CreatePublicSessionShareRequest,
  type CreatePublicSessionShareResponse,
  type FreezePublicSessionLiveSharesResponse,
  type PublicSessionShareResponse,
  type PublicSessionShareSessionStatusResponse,
  type PublicSessionShareViewerActionResponse,
  type RevokePublicSessionSharesResponse,
  type UrlProjectId,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { decodeProjectId, getProjectName } from "../projects/paths.js";
import type { PublicShareService } from "../services/PublicShareService.js";

const DEFAULT_PUBLIC_SHARE_ORIGIN = "https://ya.graehl.org";
const DEFAULT_RELAY_URL = "wss://relay.yepanywhere.com/ws";

export interface RelayConfigForPublicShare {
  url: string;
  username: string;
}

export interface PublicShareRoutesDeps {
  publicShareService: PublicShareService;
  loadSession: (
    projectId: UrlProjectId,
    sessionId: string,
    options?: { afterMessageId?: string },
  ) => Promise<AppSession | null>;
  loadSessionUpdatedAt?: (
    projectId: UrlProjectId,
    sessionId: string,
  ) => Promise<string | null>;
  loadSessionSummary?: (
    projectId: UrlProjectId,
    sessionId: string,
  ) => Promise<Pick<
    AppSession,
    "customTitle" | "provider" | "title" | "updatedAt"
  > | null>;
  getRelayConfig?: () => RelayConfigForPublicShare | null;
  getPublicSharesEnabled?: () => boolean;
  publicShareOrigin?: string;
}

function buildPublicShareUrl(
  secret: string,
  relayConfig: RelayConfigForPublicShare,
  display: {
    mode: CreatePublicSessionShareResponse["mode"];
    capturedAt?: string | null;
    initialPrompt?: string | null;
    projectName: string;
    title: string | null;
  },
  publicShareOrigin?: string,
): string {
  const origin =
    publicShareOrigin ??
    process.env.YEP_PUBLIC_SHARE_ORIGIN ??
    DEFAULT_PUBLIC_SHARE_ORIGIN;
  const url = new URL(`/share/${secret}`, origin);
  url.searchParams.set("h", relayConfig.username);
  if (relayConfig.url !== DEFAULT_RELAY_URL) {
    url.searchParams.set("r", relayConfig.url);
  }
  const displayParams = new URLSearchParams();
  displayParams.set("m", display.mode);
  displayParams.set("p", display.projectName);
  if (display.capturedAt) {
    displayParams.set("c", display.capturedAt);
  }
  if (display.title) {
    displayParams.set("t", display.title);
  }
  if (display.initialPrompt) {
    displayParams.set("q", display.initialPrompt);
  }
  url.hash = displayParams.toString();
  return url.toString();
}

function contentToPlainText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const value = block as {
        content?: unknown;
        text?: unknown;
        type?: unknown;
      };
      if (value.type === "text" && typeof value.text === "string") {
        return value.text;
      }
      if (typeof value.content === "string") {
        return value.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizePromptPreview(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("<environment_context>")
  ) {
    return null;
  }
  const normalized = trimmed.replace(/\s+/g, " ");
  return normalized.length > 700
    ? `${normalized.slice(0, 697).trimEnd()}...`
    : normalized;
}

function getInitialPromptPreview(session: AppSession): string | null {
  for (const message of session.messages) {
    if ((message as { type?: unknown }).type !== "user") {
      continue;
    }
    const content =
      contentToPlainText((message as { content?: unknown }).content) ||
      contentToPlainText(
        (message as { message?: { content?: unknown } }).message?.content,
      );
    const preview = normalizePromptPreview(content);
    if (preview) {
      return preview;
    }
  }
  return null;
}

function notFound(c: Context) {
  return c.json({ error: "Share not found" }, 404);
}

function needsFrozenShareRepair(response: PublicSessionShareResponse): boolean {
  if (!Array.isArray(response.session.messages)) {
    return true;
  }
  return (
    response.session.messages.length === 0 && response.session.messageCount > 0
  );
}

function getSessionParams(
  c: Context,
): { projectId: UrlProjectId; sessionId: string } | { error: Response } {
  const projectId = c.req.param("projectId");
  const sessionId = c.req.param("sessionId");
  if (typeof projectId !== "string" || !isUrlProjectId(projectId)) {
    return { error: c.json({ error: "Invalid project ID format" }, 400) };
  }
  if (!sessionId || typeof sessionId !== "string") {
    return { error: c.json({ error: "sessionId is required" }, 400) };
  }
  return { projectId, sessionId };
}

export function createPublicShareRoutes(deps: PublicShareRoutesDeps): Hono {
  const app = new Hono();

  app.get("/status", (c) => {
    const relayConfig = deps.getRelayConfig?.() ?? null;
    return c.json({
      enabled: deps.getPublicSharesEnabled?.() ?? false,
      configured: !!relayConfig?.username,
      requiresRelay: true,
    });
  });

  app.get("/sessions/:projectId/:sessionId", async (c) => {
    const params = getSessionParams(c);
    if ("error" in params) return params.error;
    const sessionUpdatedAt = deps.loadSessionUpdatedAt
      ? await deps.loadSessionUpdatedAt(params.projectId, params.sessionId)
      : (await deps.loadSession(params.projectId, params.sessionId))?.updatedAt;
    const response: PublicSessionShareSessionStatusResponse =
      deps.publicShareService.getSessionShareStatus(
        params.projectId,
        params.sessionId,
        { sessionUpdatedAt },
      );
    return c.json(response);
  });

  app.delete("/sessions/:projectId/:sessionId", async (c) => {
    const params = getSessionParams(c);
    if ("error" in params) return params.error;
    const response: RevokePublicSessionSharesResponse =
      await deps.publicShareService.revokeSessionShares(
        params.projectId,
        params.sessionId,
      );
    return c.json(response);
  });

  app.post("/sessions/:projectId/:sessionId/freeze-live", async (c) => {
    const params = getSessionParams(c);
    if ("error" in params) return params.error;
    const session = await deps.loadSession(params.projectId, params.sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const response: FreezePublicSessionLiveSharesResponse =
      await deps.publicShareService.freezeSessionLiveShares(
        params.projectId,
        params.sessionId,
        session,
      );
    return c.json(response);
  });

  app.post(
    "/sessions/:projectId/:sessionId/viewers/:viewerId/freeze",
    async (c) => {
      const params = getSessionParams(c);
      if ("error" in params) return params.error;
      const viewerId = c.req.param("viewerId");
      const session = await deps.loadSession(
        params.projectId,
        params.sessionId,
      );
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
      const response: PublicSessionShareViewerActionResponse =
        await deps.publicShareService.freezeSessionViewerToken(
          params.projectId,
          params.sessionId,
          viewerId,
          session,
        );
      return c.json(response);
    },
  );

  app.delete("/sessions/:projectId/:sessionId/viewers/:viewerId", async (c) => {
    const params = getSessionParams(c);
    if ("error" in params) return params.error;
    const viewerId = c.req.param("viewerId");
    const response: PublicSessionShareViewerActionResponse =
      await deps.publicShareService.disconnectSessionViewerToken(
        params.projectId,
        params.sessionId,
        viewerId,
      );
    return c.json(response);
  });

  app.post("/", async (c) => {
    let body: CreatePublicSessionShareRequest;
    try {
      body = await c.req.json<CreatePublicSessionShareRequest>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!isUrlProjectId(body.projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    if (!body.sessionId || typeof body.sessionId !== "string") {
      return c.json({ error: "sessionId is required" }, 400);
    }
    if (body.mode !== "frozen" && body.mode !== "live") {
      return c.json({ error: "mode must be frozen or live" }, 400);
    }
    if (!(deps.getPublicSharesEnabled?.() ?? false)) {
      return c.json(
        {
          error:
            "Public Read-Only Share must be enabled in Advanced settings before creating links",
        },
        403,
      );
    }

    const relayConfig = deps.getRelayConfig?.() ?? null;
    if (!relayConfig?.url || !relayConfig.username) {
      return c.json(
        {
          error:
            "Remote relay must be configured before creating public share links",
        },
        400,
      );
    }

    let session: AppSession | null = null;
    let sessionSummary: Pick<
      AppSession,
      "customTitle" | "provider" | "title" | "updatedAt"
    > | null = null;
    if (body.mode === "frozen" || !deps.loadSessionSummary) {
      session = await deps.loadSession(body.projectId, body.sessionId);
      sessionSummary = session;
    } else {
      sessionSummary = await deps.loadSessionSummary(
        body.projectId,
        body.sessionId,
      );
    }
    if (!sessionSummary) {
      return c.json({ error: "Session not found" }, 404);
    }

    const title =
      body.title ?? sessionSummary.customTitle ?? sessionSummary.title;
    const projectName = getProjectName(decodeProjectId(body.projectId));
    const initialPrompt =
      normalizePromptPreview(body.initialPrompt ?? "") ??
      (session ? getInitialPromptPreview(session) : null);
    const { secret, secretBits, record } =
      await deps.publicShareService.createShare({
        mode: body.mode,
        title,
        source: {
          projectId: body.projectId,
          sessionId: body.sessionId,
          projectName,
          provider: sessionSummary.provider,
        },
        ...(body.mode === "frozen" && session ? { snapshot: session } : {}),
      });

    const response: CreatePublicSessionShareResponse = {
      url: buildPublicShareUrl(
        secret,
        relayConfig,
        {
          mode: record.mode,
          capturedAt: record.capturedAt,
          initialPrompt,
          projectName,
          title,
        },
        deps.publicShareOrigin,
      ),
      mode: record.mode,
      createdAt: record.createdAt,
      secretBits,
    };
    return c.json(response);
  });

  return app;
}

export function createPublicSharePublicRoutes(
  deps: PublicShareRoutesDeps,
): Hono {
  const app = new Hono();

  app.get("/:secret", async (c) => {
    if (!(deps.getPublicSharesEnabled?.() ?? false)) {
      return notFound(c);
    }
    const secret = c.req.param("secret");
    const viewerId = c.req.query("viewerId");
    const afterMessageId = c.req.query("afterMessageId");
    const record = deps.publicShareService.getRecordBySecret(secret);
    if (!record) {
      return notFound(c);
    }
    if (
      viewerId &&
      deps.publicShareService.isViewerDisconnected(record, viewerId)
    ) {
      return notFound(c);
    }

    let response: PublicSessionShareResponse | null;
    if (viewerId) {
      response = deps.publicShareService.getViewerSnapshotResponse(
        record,
        viewerId,
      );
    } else {
      response = null;
    }

    if (!response && record.mode === "frozen") {
      response = deps.publicShareService.getFrozenShareBySecret(secret);
      if (response && needsFrozenShareRepair(response)) {
        const session = await deps.loadSession(
          record.source.projectId,
          record.source.sessionId,
        );
        response = session
          ? deps.publicShareService.buildFrozenRepairResponse(record, session)
          : null;
      }
    } else if (!response) {
      const session = await deps.loadSession(
        record.source.projectId,
        record.source.sessionId,
        { afterMessageId },
      );
      response = session
        ? deps.publicShareService.buildLiveResponse(record, session)
        : null;
    }

    if (!response) {
      return notFound(c);
    }

    response.share.activeViewerCount = viewerId
      ? deps.publicShareService.recordViewerHeartbeat(record, viewerId)
      : deps.publicShareService.getActiveViewerCount(record);

    c.header("Cache-Control", "no-store");
    return c.json(response);
  });

  return app;
}
