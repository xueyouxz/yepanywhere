import { describe, expect, it } from "vitest";
import { normalizeStartupEnv } from "../src/startupEnv.js";

describe("normalizeStartupEnv", () => {
  it("moves legacy names to canonical YEP_ names and removes aliases", () => {
    const env: NodeJS.ProcessEnv = {
      YEP_ANYWHERE_DATA_DIR: "/legacy/data",
      YA_COMPOSE_ANCHORS: "1",
      YA_stt__XAI_API_KEY: "xai-key",
      YEP_YA_CLIENT_BASE_URL: "ya.example.test/remote",
    };

    normalizeStartupEnv(env);

    expect(env).toMatchObject({
      YEP_DATA_DIR: "/legacy/data",
      YEP_COMPOSE_ANCHORS: "1",
      YEP_STT_XAI_API_KEY: "xai-key",
      YEP_CLIENT_BASE_URL: "ya.example.test/remote",
    });
    expect(env.YEP_ANYWHERE_DATA_DIR).toBeUndefined();
    expect(env.YA_COMPOSE_ANCHORS).toBeUndefined();
    expect(env.YA_stt__XAI_API_KEY).toBeUndefined();
    expect(env.YEP_YA_CLIENT_BASE_URL).toBeUndefined();
  });

  it.each([
    ["YEP_ANYWHERE_PROFILE", "YEP_PROFILE"],
    ["YA_VOICE_BACKENDS", "YEP_VOICE_BACKENDS"],
    ["YA_DEFERRED_JOIN_WINDOW_S", "YEP_DEFERRED_JOIN_WINDOW_S"],
    ["YA_stt__DEEPGRAM_API_KEY", "YEP_STT_DEEPGRAM_API_KEY"],
    [
      "YA_stt__SHARE_XAI_KEY_WITH_CLIENTS",
      "YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS",
    ],
    ["YA_CODEX_DISABLE_LIVE_DELTAS", "YEP_CODEX_DISABLE_LIVE_DELTAS"],
    ["YEP_ANYWHERE_ORIGINAL_BASH_ENV", "YEP_ORIGINAL_BASH_ENV"],
    ["YEP_ANYWHERE_ALLOW_SUSPICIOUS_HOME", "YEP_ALLOW_SUSPICIOUS_HOME"],
  ])("maps %s directly to %s", (legacy, canonical) => {
    const env: NodeJS.ProcessEnv = { [legacy]: "value" };

    normalizeStartupEnv(env);

    expect(env[canonical]).toBe("value");
    expect(env[legacy]).toBeUndefined();
  });

  it("keeps canonical values when canonical and legacy names are both set", () => {
    const env: NodeJS.ProcessEnv = {
      YEP_DATA_DIR: "/canonical/data",
      YEP_ANYWHERE_DATA_DIR: "/legacy/data",
      YEP_STT_XAI_API_KEY: "canonical-key",
      YA_stt__XAI_API_KEY: "legacy-key",
    };

    normalizeStartupEnv(env);

    expect(env.YEP_DATA_DIR).toBe("/canonical/data");
    expect(env.YEP_STT_XAI_API_KEY).toBe("canonical-key");
    expect(env.YEP_ANYWHERE_DATA_DIR).toBeUndefined();
    expect(env.YA_stt__XAI_API_KEY).toBeUndefined();
  });

  it("converts the legacy share-viewer URL to the client base URL", () => {
    const env: NodeJS.ProcessEnv = {
      YEP_PUBLIC_SHARE_VIEWER_BASE_URL: "https://ya.example.test/remote/share",
    };

    normalizeStartupEnv(env);

    expect(env.YEP_CLIENT_BASE_URL).toBe("https://ya.example.test/remote");
    expect(env.YEP_PUBLIC_SHARE_VIEWER_BASE_URL).toBeUndefined();
  });
});
