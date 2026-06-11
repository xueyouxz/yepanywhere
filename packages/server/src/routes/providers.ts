import type { ProviderInfo, ProviderName } from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { getAllProviders } from "../sdk/providers/index.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";

const PROVIDER_INFO_CACHE_TTL_MS = 5 * 60_000;

interface ProviderRouteDeps {
  modelInfoService?: ModelInfoService;
  /** If non-empty, only these provider names are exposed. */
  enabledProviders?: string[];
  /** Provider instances, injectable for route tests. */
  providers?: AgentProvider[];
  /** Provider info cache TTL in ms. */
  cacheTtlMs?: number;
}

interface ProviderInfoCacheEntry {
  expiresAt: number;
  value?: ProviderInfo;
  inFlight?: Promise<ProviderInfo>;
}

function getProviderImageSizing(
  providerName: ProviderName,
): ProviderInfo["imageSizing"] {
  switch (providerName) {
    case "claude":
    case "claude-ollama":
      return {
        defaultLongEdgePx: 1568,
        maxUsefulLongEdgePx: 1568,
        note:
          "Anthropic recommends resizing Claude images to no more than 1568 px on the long edge.",
      };
    case "codex":
    case "codex-oss":
      return {
        defaultLongEdgePx: 2048,
        maxUsefulLongEdgePx: 2048,
        note:
          "GPT-5.2/5.3-Codex high detail allows up to 2048 px max dimension.",
      };
    default:
      return undefined;
  }
}

/**
 * Creates provider-related API routes.
 *
 * GET /api/providers - Get all providers with their auth status
 * GET /api/providers/:name - Get specific provider status
 */
export function createProvidersRoutes(deps: ProviderRouteDeps = {}): Hono {
  const routes = new Hono();
  const cache = new Map<ProviderName, ProviderInfoCacheEntry>();
  const cacheTtlMs = deps.cacheTtlMs ?? PROVIDER_INFO_CACHE_TTL_MS;

  const getProviderInfo = async (
    provider: AgentProvider,
    forceRefresh: boolean,
  ): Promise<ProviderInfo> => {
    const providerName = provider.name as ProviderName;
    const now = Date.now();
    const cached = cache.get(providerName);
    if (!forceRefresh && cached?.value && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached?.inFlight) {
      return cached.inFlight;
    }

    const inFlight = (async () => {
      const [authStatus, models] = await Promise.all([
        provider.getAuthStatus(),
        provider.getAvailableModels(),
      ]);
      deps.modelInfoService?.ingestModels(providerName, models);
      return {
        name: provider.name,
        displayName: provider.displayName,
        installed: authStatus.installed,
        authenticated: authStatus.authenticated,
        enabled: authStatus.enabled,
        expiresAt: authStatus.expiresAt?.toISOString(),
        user: authStatus.user,
        models,
        imageSizing: getProviderImageSizing(provider.name),
        supportsPermissionMode: provider.supportsPermissionMode,
        supportsThinkingToggle: provider.supportsThinkingToggle,
        supportsSlashCommands: provider.supportsSlashCommands,
        supportsSteering: provider.supportsSteering,
        supportsSteerNow: provider.supportsSteerNow,
        supportsRecaps: provider.supportsRecaps,
        supportsNativeRecaps: provider.supportsNativeRecaps,
        supportsNativePromptSuggestions: provider.supportsNativePromptSuggestions,
      } satisfies ProviderInfo;
    })();

    cache.set(providerName, {
      expiresAt: cached?.expiresAt ?? 0,
      value: forceRefresh ? undefined : cached?.value,
      inFlight,
    });

    try {
      const value = await inFlight;
      cache.set(providerName, {
        value,
        expiresAt: Date.now() + cacheTtlMs,
      });
      return value;
    } catch (error) {
      cache.delete(providerName);
      throw error;
    }
  };

  const isRefreshRequest = (c: Context) =>
    c.req.query("refresh") === "true" ||
    c.req.query("refresh") === "1" ||
    c.req.header("cache-control")?.toLowerCase().includes("no-cache") === true;

  // GET /api/providers - Get all available providers with auth status and models
  routes.get("/", async (c) => {
    const forceRefresh = isRefreshRequest(c);
    let providers = deps.providers ?? getAllProviders();
    if (deps.enabledProviders && deps.enabledProviders.length > 0) {
      const enabled = new Set(deps.enabledProviders);
      providers = providers.filter((p) => enabled.has(p.name));
    }
    const providerInfos: ProviderInfo[] = await Promise.all(
      providers.map((provider) => getProviderInfo(provider, forceRefresh)),
    );

    return c.json({ providers: providerInfos });
  });

  // GET /api/providers/:name - Get specific provider status with models
  routes.get("/:name", async (c) => {
    const forceRefresh = isRefreshRequest(c);
    const name = c.req.param("name");
    const providers = deps.providers ?? getAllProviders();
    const provider = providers.find((p) => p.name === name);

    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }

    const providerInfo = await getProviderInfo(provider, forceRefresh);
    return c.json({ provider: providerInfo });
  });

  return routes;
}
