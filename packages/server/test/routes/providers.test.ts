import type { ModelInfo } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { createProvidersRoutes } from "../../src/routes/providers.js";
import type {
  AgentProvider,
  AuthStatus,
} from "../../src/sdk/providers/types.js";

function createProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
  return {
    name: "claude",
    displayName: "Claude",
    supportsPermissionMode: true,
    supportsThinkingToggle: true,
    supportsSlashCommands: false,
    supportsSteering: false,
    isInstalled: vi.fn(async () => true),
    isAuthenticated: vi.fn(async () => true),
    getAuthStatus: vi.fn(async () => ({
      installed: true,
      authenticated: true,
      enabled: true,
    })),
    getAvailableModels: vi.fn(async () => [{ id: "sonnet", name: "Sonnet" }]),
    startSession: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    ...overrides,
  } as AgentProvider;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("Providers Routes", () => {
  it("caches provider scans for repeated list requests", async () => {
    const provider = createProvider();
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const first = await routes.request("/");
    const second = await routes.request("/");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(provider.getAuthStatus).toHaveBeenCalledTimes(1);
    expect(provider.getAvailableModels).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight scan between concurrent requests", async () => {
    const authStatus = deferred<AuthStatus>();
    const models = deferred<ModelInfo[]>();
    const provider = createProvider({
      getAuthStatus: vi.fn(() => authStatus.promise),
      getAvailableModels: vi.fn(() => models.promise),
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const first = routes.request("/");
    const second = routes.request("/");
    await Promise.resolve();

    expect(provider.getAuthStatus).toHaveBeenCalledTimes(1);
    expect(provider.getAvailableModels).toHaveBeenCalledTimes(1);

    authStatus.resolve({
      installed: true,
      authenticated: true,
      enabled: true,
    });
    models.resolve([{ id: "sonnet", name: "Sonnet" }]);

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
  });

  it("bypasses the cache when refresh is requested", async () => {
    const provider = createProvider({
      getAvailableModels: vi
        .fn()
        .mockResolvedValueOnce([{ id: "sonnet", name: "Sonnet" }])
        .mockResolvedValueOnce([{ id: "opus", name: "Opus" }]),
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const cached = await routes.request("/");
    const refreshed = await routes.request("/?refresh=1");

    expect(cached.status).toBe(200);
    expect(refreshed.status).toBe(200);
    expect(provider.getAuthStatus).toHaveBeenCalledTimes(2);
    expect(provider.getAvailableModels).toHaveBeenCalledTimes(2);

    const json = (await refreshed.json()) as { providers: Array<unknown> };
    expect(json.providers).toEqual([
      expect.objectContaining({
        name: "claude",
        models: [{ id: "opus", name: "Opus" }],
      }),
    ]);
  });

  it("reuses list-request cache for a provider detail request", async () => {
    const provider = createProvider();
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const list = await routes.request("/");
    const detail = await routes.request("/claude");

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(provider.getAuthStatus).toHaveBeenCalledTimes(1);
    expect(provider.getAvailableModels).toHaveBeenCalledTimes(1);
  });

  it("serializes active-turn steering capability flags", async () => {
    const provider = createProvider({
      supportsSteering: true,
      supportsSteerNow: true,
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const response = await routes.request("/");
    const json = (await response.json()) as { providers: Array<unknown> };

    expect(json.providers).toEqual([
      expect.objectContaining({
        supportsSteering: true,
        supportsSteerNow: true,
      }),
    ]);
  });

  it("serializes prompt-cache keepalive capability", async () => {
    const provider = createProvider({
      promptCacheKeepalive: {
        supportsNoContextPollutionNudge: true,
        defaultMode: "auto",
        defaultInactivityMinutes: 40,
      },
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const response = await routes.request("/");
    const json = (await response.json()) as { providers: Array<unknown> };

    expect(json.providers).toEqual([
      expect.objectContaining({
        name: "claude",
        promptCacheKeepalive: {
          supportsNoContextPollutionNudge: true,
          defaultMode: "auto",
          defaultInactivityMinutes: 40,
        },
      }),
    ]);
  });

  it("includes provider login command hints", async () => {
    const provider = createProvider({
      getAuthStatus: vi.fn(async () => ({
        installed: true,
        authenticated: false,
        enabled: false,
        loginCommand:
          '& "C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe" auth login --claudeai',
      })),
    });
    const routes = createProvidersRoutes({
      providers: [provider],
      cacheTtlMs: 60_000,
    });

    const response = await routes.request("/");

    expect(response.status).toBe(200);
    const json = (await response.json()) as { providers: Array<unknown> };
    expect(json.providers).toEqual([
      expect.objectContaining({
        name: "claude",
        loginCommand:
          '& "C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe" auth login --claudeai',
      }),
    ]);
  });
});
