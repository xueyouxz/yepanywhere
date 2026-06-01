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

    expect(config.codexSessionsDir).toBe("/tmp/custom-codex-home/sessions");
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

  it("always allows the managed uploads directory for local-image", async () => {
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual(["/tmp/yep-data/uploads"]);
  });

  it("merges managed uploads with configured local-image paths", async () => {
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "/tmp, /var/tmp, /tmp");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual([
      "/tmp/yep-data/uploads",
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
});
