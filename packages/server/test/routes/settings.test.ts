import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsRoutes } from "../../src/routes/settings.js";
import type {
  ServerSettings,
  ServerSettingsService,
} from "../../src/services/ServerSettingsService.js";
import type { PublicShareService } from "../../src/services/PublicShareService.js";

describe("Settings Routes", () => {
  let settings: ServerSettings;
  let mockServerSettingsService: ServerSettingsService;

  beforeEach(() => {
    settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      clientLogCollectionRequested: false,
      publicSharesEnabled: false,
    };

    mockServerSettingsService = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn(async (updates: Partial<ServerSettings>) => {
        settings = { ...settings, ...updates };
        return settings;
      }),
    } as unknown as ServerSettingsService;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("PUT /remote-executors", () => {
    it("rejects invalid host aliases", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/remote-executors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executors: ["devbox", "-oProxyCommand=touch_/tmp/pwned"],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid remote executor host alias");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts and normalizes valid aliases", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/remote-executors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executors: ["  devbox  ", "gpu-server", "", "  "],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.executors).toEqual(["devbox", "gpu-server"]);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        remoteExecutors: ["devbox", "gpu-server"],
      });
    });
  });

  describe("PUT /", () => {
    it("accepts clearing globalInstructions with null", async () => {
      settings = {
        ...settings,
        globalInstructions: "Existing instructions",
      };

      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          globalInstructions: null,
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.globalInstructions).toBeUndefined();
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        globalInstructions: undefined,
      });
    });

    it("rejects invalid aliases in remoteExecutors setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteExecutors: ["devbox", "-oProxyCommand=touch_/tmp/pwned"],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid remote executor host alias");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts and normalizes valid aliases in chromeOsHosts setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chromeOsHosts: ["  chromeroot  ", "lab-book", "", " "],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.chromeOsHosts).toEqual(["chromeroot", "lab-book"]);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        chromeOsHosts: ["chromeroot", "lab-book"],
      });
    });

    it("rejects invalid aliases in chromeOsHosts setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chromeOsHosts: ["chromeroot", "-oProxyCommand=touch_/tmp/pwned"],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid ChromeOS host alias");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts lifecycle webhook settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lifecycleWebhooksEnabled: true,
          lifecycleWebhookUrl: "https://example.com/hook",
          lifecycleWebhookToken: "secret",
          lifecycleWebhookDryRun: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        lifecycleWebhooksEnabled: true,
        lifecycleWebhookUrl: "https://example.com/hook",
        lifecycleWebhookToken: "secret",
        lifecycleWebhookDryRun: false,
      });
    });

    it("accepts server-requested client log collection", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientLogCollectionRequested: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientLogCollectionRequested: true,
      });
    });

    it("accepts public share feature gating", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicSharesEnabled: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        publicSharesEnabled: true,
      });
    });

    it("revokes stored public shares when disabling the feature", async () => {
      const revokeAllShares = vi.fn(async () => 2);
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        publicShareService: {
          revokeAllShares,
        } as unknown as PublicShareService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicSharesEnabled: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        publicSharesEnabled: false,
      });
      expect(revokeAllShares).toHaveBeenCalled();
    });

    it("accepts and normalizes helper target settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          helperTargets: [
            {
              id: "local-vllm",
              name: "Local vLLM",
              kind: "openai-compatible",
              baseUrl: "localhost:8001",
              model: "",
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.helperTargets).toEqual([
        {
          id: "local-vllm",
          name: "Local vLLM",
          kind: "openai-compatible",
          baseUrl: "http://localhost:8001/v1",
        },
      ]);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        helperTargets: [
          {
            id: "local-vllm",
            name: "Local vLLM",
            kind: "openai-compatible",
            baseUrl: "http://localhost:8001/v1",
          },
        ],
      });
    });

    it("rejects invalid helper target settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          helperTargets: [
            {
              id: "bad/id",
              name: "Local vLLM",
              kind: "openai-compatible",
              baseUrl: "localhost:8001",
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid helperTargets setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });
  });

  describe("POST /helper-targets/models", () => {
    it("discovers OpenAI-compatible model ids through the server", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "Qwen/Qwen3.6-27B",
                  max_model_len: 161072,
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await routes.request("/helper-targets/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: "localhost:8001" }),
      });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:8001/v1/models",
        expect.objectContaining({ signal: expect.any(Object) }),
      );
      const json = await response.json();
      expect(json).toEqual({
        baseUrl: "http://localhost:8001/v1",
        models: [
          {
            id: "Qwen/Qwen3.6-27B",
            name: "Qwen/Qwen3.6-27B",
            contextWindow: 161072,
          },
        ],
      });
    });

    it("rejects invalid helper target discovery URLs", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/helper-targets/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: "file:///etc/passwd" }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("baseUrl must be an http(s) URL");
    });
  });

  describe("POST /remote-executors/:host/test", () => {
    it("rejects invalid host path parameters", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const invalidHost = encodeURIComponent("-oProxyCommand=touch_/tmp/pwned");

      const response = await routes.request(
        `/remote-executors/${invalidHost}/test`,
        {
          method: "POST",
        },
      );

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("host must be a valid SSH host alias");
    });
  });
});
