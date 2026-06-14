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

  it("includes Windows temp directories in default local-image paths", async () => {
    const { getDefaultAllowedImagePaths } = await import("../src/config.js");

    expect(getDefaultAllowedImagePaths("win32", "C:\\Users\\me\\Temp")).toEqual(
      ["/tmp", "C:\\tmp", "C:\\Users\\me\\Temp"],
    );
  });

  it("always allows the managed uploads directory for local-image", async () => {
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual([
      path.join("/tmp/yep-data", "uploads"),
    ]);
  });

  it("merges managed uploads with configured local-image paths", async () => {
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", "/tmp/yep-data");
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
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.voiceBackends).toEqual([]);
  });

  it("parses explicitly enabled server-routed voice backends", async () => {
    vi.stubEnv("YA_VOICE_BACKENDS", "ya-dummy, local-whisper,ya-dummy");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.voiceBackends).toEqual([
      "ya-dummy",
      "local-whisper",
      "ya-dummy",
    ]);
  });

  it("defaults idle cleanup to 20 minutes", async () => {
    vi.stubEnv("IDLE_TIMEOUT", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.idleTimeoutMs).toBe(20 * 60 * 1000);
  });

  it("preserves an explicit IDLE_TIMEOUT override", async () => {
    vi.stubEnv("IDLE_TIMEOUT", "45");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.idleTimeoutMs).toBe(45 * 1000);
  });

  it("reads the xAI STT key from YA-private module env", async () => {
    vi.stubEnv("YA_stt__XAI_API_KEY", "xai-key");
    vi.stubEnv("XAI_API_KEY", "ambient-xai-key");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.xaiSttApiKey).toBe("xai-key");
    expect(config.ambientXaiApiKey).toBe("ambient-xai-key");
    expect(process.env.YA_stt__XAI_API_KEY).toBeUndefined();
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
    vi.stubEnv("YA_stt__XAI_API_KEY", "xai-key");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.xaiSttApiKey).toBe("xai-key");
    expect(config.shareXaiSttApiKeyWithClients).toBe(false);
  });

  it("parses the xAI STT client key sharing opt-in", async () => {
    vi.stubEnv("YA_stt__SHARE_XAI_KEY_WITH_CLIENTS", "1");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.shareXaiSttApiKeyWithClients).toBe(true);
  });
});
