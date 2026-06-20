import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("loadConfig codex paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses CODEX_HOME/sessions when CODEX_SESSIONS_DIR is unset", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/custom-codex-home");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe(
      path.join("/tmp/custom-codex-home", "sessions"),
    );
  });

  it("prefers CODEX_SESSIONS_DIR over CODEX_HOME", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/custom-codex-home");
    vi.stubEnv("CODEX_SESSIONS_DIR", "/tmp/explicit-codex-sessions");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe("/tmp/explicit-codex-sessions");
  });

  it("falls back to ~/.codex/sessions when neither env var is set", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe(
      path.join(os.homedir(), ".codex", "sessions"),
    );
  });

  it("parses desktop runtime Codex CLI path", async () => {
    vi.stubEnv("YEP_DESKTOP", "1");
    vi.stubEnv("YEP_DESKTOP_CODEX_CLI_PATH", "/tmp/yep-desktop/bin/codex");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.desktopRuntime).toBe(true);
    expect(config.codexCliPath).toBe("/tmp/yep-desktop/bin/codex");
  });

  it("ignores blank desktop Codex CLI path", async () => {
    vi.stubEnv("YEP_DESKTOP", "true");
    vi.stubEnv("YEP_DESKTOP_CODEX_CLI_PATH", "  ");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.desktopRuntime).toBe(true);
    expect(config.codexCliPath).toBeUndefined();
  });

  it("uses the real Windows temp directory for default local-image paths", async () => {
    const { getDefaultAllowedImagePaths } = await import("../src/config.js");

    // Windows has no `/tmp` and no implicit `C:\tmp`; only os.tmpdir().
    expect(getDefaultAllowedImagePaths("win32", "C:\\Users\\me\\Temp")).toEqual(
      ["C:\\Users\\me\\Temp"],
    );
    expect(getDefaultAllowedImagePaths("linux", "/var/tmp-ignored")).toEqual([
      "/tmp",
    ]);
  });

  it("always allows the managed uploads directory for local-image", async () => {
    vi.stubEnv("YEP_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual([
      path.join("/tmp/yep-data", "uploads"),
    ]);
  });

  it("merges managed uploads with configured local-image paths", async () => {
    vi.stubEnv("YEP_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "/tmp, /var/tmp, /tmp");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual([
      path.join("/tmp/yep-data", "uploads"),
      "/tmp",
      "/var/tmp",
    ]);
  });

  it("defaults server-routed voice backends off", async () => {
    vi.stubEnv("YEP_VOICE_BACKENDS", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.voiceBackends).toEqual([]);
  });

  it("parses explicitly enabled server-routed voice backends", async () => {
    vi.stubEnv(
      "YEP_VOICE_BACKENDS",
      "ya-dummy, local-whisper,ya-parakeet,ya-nemo,ya-dummy",
    );

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.voiceBackends).toEqual([
      "ya-dummy",
      "local-whisper",
      "ya-parakeet",
      "ya-nemo",
      "ya-dummy",
    ]);
  });

  it("parses local Parakeet tuning options", async () => {
    vi.stubEnv("PARAKEET_MODEL", "nvidia/parakeet-tdt-0.6b-v3");
    vi.stubEnv("PARAKEET_DEVICE", "cuda:0");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.parakeetModel).toBe("nvidia/parakeet-tdt-0.6b-v3");
    expect(config.parakeetDevice).toBe("cuda:0");
  });

  it("parses local NeMo Parakeet tuning options", async () => {
    vi.stubEnv("NEMO_MODEL", "nvidia/parakeet-rnnt-1.1b");
    vi.stubEnv("NEMO_DEVICE", "cuda:1");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.nemoModel).toBe("nvidia/parakeet-rnnt-1.1b");
    expect(config.nemoDevice).toBe("cuda:1");
  });

  it("defaults idle cleanup to 60 minutes", async () => {
    vi.stubEnv("IDLE_TIMEOUT", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.idleTimeoutMs).toBe(60 * 60 * 1000);
  });

  it("preserves an explicit IDLE_TIMEOUT override", async () => {
    vi.stubEnv("IDLE_TIMEOUT", "45");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.idleTimeoutMs).toBe(45 * 1000);
  });

  it("reads the xAI STT key from YA-private module env", async () => {
    vi.stubEnv("YEP_STT_XAI_API_KEY", "xai-key");
    vi.stubEnv("XAI_API_KEY", "ambient-xai-key");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.xaiSttApiKey).toBe("xai-key");
    expect(config.ambientXaiApiKey).toBe("ambient-xai-key");
    expect(process.env.YEP_STT_XAI_API_KEY).toBeUndefined();
    expect(process.env.XAI_API_KEY).toBeUndefined();
  });

  it("uses and scrubs ambient XAI_API_KEY as an STT fallback", async () => {
    vi.stubEnv("XAI_API_KEY", "ambient-xai-key");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.xaiSttApiKey).toBe("ambient-xai-key");
    expect(config.ambientXaiApiKey).toBe("ambient-xai-key");
    expect(process.env.XAI_API_KEY).toBeUndefined();
  });

  it("requires explicit opt-in before sharing xAI STT keys with clients", async () => {
    vi.stubEnv("YEP_STT_XAI_API_KEY", "xai-key");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.xaiSttApiKey).toBe("xai-key");
    expect(config.shareXaiSttApiKeyWithClients).toBe(false);
  });

  it("parses the xAI STT client key sharing opt-in", async () => {
    vi.stubEnv("YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS", "1");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.shareXaiSttApiKeyWithClients).toBe(true);
  });
});
