import {
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  RECAP_MODES,
  type RecapMode,
  type ShowThinking,
  type ThinkingOption,
  type UrlProjectId,
  getSessionDisplayTitle,
  thinkingOptionToConfig,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { getProvider } from "../sdk/providers/index.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { ProcessInfo, Project } from "../supervisor/types.js";

export interface ProcessesDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  processSessionSourceFactory?: (
    process: ProcessInfo,
    project: Project,
  ) => { reader: ISessionReader; sessionDir: string };
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
}

/**
 * Enrich process info with session title, model, and context usage.
 * Uses cache when available. Checks custom title from metadata service first.
 */
async function enrichProcessInfo(
  process: ProcessInfo,
  deps: ProcessesDeps,
): Promise<ProcessInfo> {
  try {
    const project = await deps.scanner.getProject(
      process.projectId as UrlProjectId,
    );
    if (!project) return process;

    const sessionSource = deps.processSessionSourceFactory?.(process, project);
    const reader = sessionSource?.reader ?? deps.readerFactory(project);
    const sessionDir = sessionSource?.sessionDir ?? project.sessionDir;

    // Always get the session summary for model and contextUsage
    const summary = await reader.getSessionSummary(
      process.sessionId,
      process.projectId as UrlProjectId,
    );

    // Prefer cached titles, but fall back to the live summary when the cache
    // misses. This matters for providers like Codex whose session files are
    // not stored in project.sessionDir.
    let title = summary?.title ?? null;
    if (deps.sessionIndexService) {
      const cachedTitle = await deps.sessionIndexService.getSessionTitle(
        sessionDir,
        process.projectId as UrlProjectId,
        process.sessionId,
        reader,
      );
      title = cachedTitle ?? title;
    }

    // Get custom title and provider from persisted metadata if available.
    // This lets the agents view recover when a stale in-memory process
    // provider disagrees with the durable session provider.
    const metadata = deps.sessionMetadataService?.getMetadata(
      process.sessionId,
    );

    // Use getSessionDisplayTitle to compute final title (customTitle > title > "Untitled")
    const displayTitle = getSessionDisplayTitle({
      customTitle: metadata?.customTitle,
      title,
    });

    const enriched = { ...process };

    // Only set sessionTitle if we have something meaningful (not "Untitled")
    if (displayTitle !== "Untitled") {
      enriched.sessionTitle = displayTitle;
    }

    // Add model if available
    if (summary?.model) {
      enriched.model = summary.model;
    }

    // Prefer the durable session provider over the process provider when available.
    // This fixes stale terminated-process rows that were started with the wrong
    // provider but whose session metadata and on-disk transcript are correct.
    enriched.provider =
      summary?.provider ?? metadata?.provider ?? process.provider;

    // Resolve the YA model id used to key per-model settings. Prefer the live
    // requested alias, then the alias persisted when YA started the session
    // (survives restart), then map the reported model back through the provider
    // (sessions YA didn't start). See topics/provider-abstraction.md.
    enriched.requestedModel =
      process.requestedModel ??
      metadata?.requestedModel ??
      getProvider(enriched.provider)?.yaModelIdForReported?.(enriched.model);

    // Add context usage if available
    if (summary?.contextUsage) {
      enriched.contextUsage = summary.contextUsage;
    }

    return enriched;
  } catch {
    // Ignore errors - just return process without enrichment
  }
  return process;
}

export function createProcessesRoutes(deps: ProcessesDeps): Hono {
  const routes = new Hono();

  // GET /api/processes - List all active processes
  // Query params:
  //   - includeTerminated: if "true", also includes recently terminated processes
  routes.get("/", async (c) => {
    const includeTerminated = c.req.query("includeTerminated") === "true";
    const processes = deps.supervisor.getProcessInfoList();

    // Enrich all processes with session titles and model info
    const enrichedProcesses = await Promise.all(
      processes.map((p) => enrichProcessInfo(p, deps)),
    );

    if (includeTerminated) {
      const terminatedProcesses =
        deps.supervisor.getRecentlyTerminatedProcesses();
      // Also enrich terminated processes
      const enrichedTerminated = await Promise.all(
        terminatedProcesses.map((p) => enrichProcessInfo(p, deps)),
      );
      return c.json({
        processes: enrichedProcesses,
        terminatedProcesses: enrichedTerminated,
      });
    }

    return c.json({ processes: enrichedProcesses });
  });

  // POST /api/processes/:processId/abort - Kill a process
  routes.post("/:processId/abort", async (c) => {
    const processId = c.req.param("processId");

    const aborted = await deps.supervisor.abortProcess(processId);
    if (!aborted) {
      return c.json({ error: "Process not found" }, 404);
    }

    return c.json({ aborted: true });
  });

  // POST /api/processes/:processId/interrupt - Interrupt current turn gracefully
  // Unlike abort, this stops the current turn but keeps the process alive.
  routes.post("/:processId/interrupt", async (c) => {
    const processId = c.req.param("processId");

    const result = await deps.supervisor.interruptProcess(processId);
    if (!result.success && !result.supported) {
      // Process not found or doesn't support interrupt
      if (
        !deps.supervisor.getProcessInfoList().some((p) => p.id === processId)
      ) {
        return c.json({ error: "Process not found" }, 404);
      }
      // Process exists but doesn't support interrupt
      return c.json({ error: "Interrupt not supported for this process" }, 400);
    }

    return c.json({
      interrupted: result.success,
      supported: result.supported,
      aborted: result.hardAborted === true,
    });
  });

  // POST /api/processes/:processId/recap - Summarize recent activity.
  routes.post("/:processId/recap", async (c) => {
    const processId = c.req.param("processId");
    let sinceMs: number | null = null;
    try {
      const body = await c.req.json<{ hiddenSinceMs?: unknown }>();
      if (
        typeof body.hiddenSinceMs === "number" &&
        Number.isFinite(body.hiddenSinceMs)
      ) {
        sinceMs = body.hiddenSinceMs;
      }
    } catch {
      // Empty body is accepted for backward compatibility.
    }

    const result = await deps.supervisor.requestRecap(processId, { sinceMs });
    if (!result.supported && result.reason === "process not found") {
      return c.json({ error: "Process not found" }, 404);
    }

    return c.json(result);
  });

  routes.post("/:processId/recap-config", async (c) => {
    const processId = c.req.param("processId");
    const process = deps.supervisor.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }

    let body: { recapMode?: unknown; helperSideModel?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const updates: { recapMode?: RecapMode; helperSideModel?: string } = {};
    if ("recapMode" in body) {
      if (
        typeof body.recapMode !== "string" ||
        !RECAP_MODES.includes(body.recapMode as RecapMode)
      ) {
        return c.json(
          { error: "recapMode must be one of: off, native, side-session" },
          400,
        );
      }
      updates.recapMode = body.recapMode as RecapMode;
    }
    if ("helperSideModel" in body) {
      if (
        body.helperSideModel !== undefined &&
        body.helperSideModel !== null &&
        typeof body.helperSideModel !== "string"
      ) {
        return c.json({ error: "helperSideModel must be a string" }, 400);
      }
      const trimmed =
        typeof body.helperSideModel === "string"
          ? body.helperSideModel.trim()
          : "";
      updates.helperSideModel =
        trimmed === HELPER_SIDE_MODEL_SAME_AS_MAIN
          ? HELPER_SIDE_MODEL_SAME_AS_MAIN
          : trimmed === HELPER_SIDE_MODEL_CHEAPEST
            ? HELPER_SIDE_MODEL_CHEAPEST
            : trimmed || HELPER_SIDE_MODEL_CHEAPEST;
    }

    const updatedProcess = deps.supervisor.configureProcessRecaps(
      processId,
      updates,
    );
    if (!updatedProcess) {
      return c.json({ error: "Process not found" }, 404);
    }
    return c.json({
      success: true,
      processId,
      recapMode: updatedProcess.recapMode,
      helperSideModel: updatedProcess.helperSideModel,
    });
  });

  // GET /api/processes/:processId/models - Get available models from SDK
  // Returns the list of models available for this session (dynamically from SDK).
  routes.get("/:processId/models", async (c) => {
    const processId = c.req.param("processId");

    const process = deps.supervisor.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }

    const models = await process.supportedModels();
    if (models !== null) {
      return c.json({ models });
    }

    const provider = getProvider(process.provider);
    if (!provider) {
      return c.json(
        { error: "Dynamic model listing not supported for this process" },
        400,
      );
    }

    return c.json({ models: await provider.getAvailableModels() });
  });

  // GET /api/processes/:processId/commands - Get available slash commands from SDK
  // Returns the list of slash commands (skills) available for this session.
  routes.get("/:processId/commands", async (c) => {
    const processId = c.req.param("processId");

    const process = deps.supervisor.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }

    const commands = await process.supportedCommands();
    if (commands === null) {
      // Process doesn't support dynamic command listing
      return c.json(
        { error: "Dynamic command listing not supported for this process" },
        400,
      );
    }

    return c.json({ commands });
  });

  // POST /api/processes/:processId/config - Reconfigure an active process
  // Body: { model?: string, thinking?: ThinkingOption }
  routes.post("/:processId/config", async (c) => {
    const processId = c.req.param("processId");

    const process = deps.supervisor.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }

    const body = await c.req.json<{
      model?: string;
      thinking?: ThinkingOption;
      showThinking?: ShowThinking;
    }>();
    const updates: {
      model?: string;
      thinking?: ReturnType<typeof thinkingOptionToConfig>["thinking"];
      effort?: ReturnType<typeof thinkingOptionToConfig>["effort"];
    } = {};

    if ("model" in body) {
      updates.model = body.model;
    }
    if ("thinking" in body) {
      if (body.thinking === undefined) {
        updates.thinking = undefined;
        updates.effort = undefined;
      } else {
        const { thinking, effort } = thinkingOptionToConfig(
          body.thinking,
          body.showThinking,
        );
        updates.thinking = thinking;
        updates.effort = effort;
      }
    }

    const updatedProcess = await deps.supervisor.reconfigureProcess(
      processId,
      updates,
    );

    if (!updatedProcess) {
      return c.json({ error: "Process reconfiguration failed" }, 400);
    }

    return c.json({
      success: true,
      processId: updatedProcess.id,
      model: updatedProcess.resolvedModel ?? body.model,
      thinking: updatedProcess.thinking,
      effort: updatedProcess.effort,
    });
  });

  // Backward-compatible alias used by the existing model switch UI.
  routes.post("/:processId/model", async (c) => {
    const processId = c.req.param("processId");
    const body = await c.req.json<{ model?: string }>();
    const process = deps.supervisor.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }
    const updatedProcess = await deps.supervisor.reconfigureProcess(processId, {
      model: body.model,
    });
    if (!updatedProcess) {
      return c.json({ error: "Model switching failed" }, 400);
    }
    return c.json({
      success: true,
      processId: updatedProcess.id,
      model: updatedProcess.resolvedModel ?? body.model,
    });
  });

  return routes;
}
