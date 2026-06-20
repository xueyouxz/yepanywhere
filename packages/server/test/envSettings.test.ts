import { describe, expect, it } from "vitest";
import {
  buildEnvSettings,
  captureStartupEnvSettings,
  getStartupEnvSettings,
  isSecretName,
  redactSecretValue,
} from "../src/envSettings.js";

function entry(env: NodeJS.ProcessEnv, name: string) {
  const found = buildEnvSettings(env).entries.find((e) => e.name === name);
  if (!found) throw new Error(`registry missing ${name}`);
  return found;
}

describe("isSecretName", () => {
  it("treats KEY/SECRET/TOKEN/PASSWORD names as secret", () => {
    expect(isSecretName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSecretName("AUTH_COOKIE_SECRET")).toBe(true);
    expect(isSecretName("DESKTOP_AUTH_TOKEN")).toBe(true);
    expect(isSecretName("DB_PASSWORD")).toBe(true);
  });

  it("honors the explicit declared flag even without a matching name", () => {
    expect(isSecretName("YEP_STT_OPAQUE", true)).toBe(true);
    expect(isSecretName("PORT")).toBe(false);
  });

  it("lets an explicit false opt a KEY-named var out of redaction", () => {
    expect(isSecretName("YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS", false)).toBe(
      false,
    );
  });
});

describe("registry", () => {
  it("shows SHARE_XAI_KEY_WITH_CLIENTS as a non-secret boolean", () => {
    const e = entry(
      { YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS: "true" },
      "YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS",
    );
    expect(e.secret).toBe(false);
    expect(e.value).toBe("true");
  });
});

describe("redactSecretValue", () => {
  it("reveals only the last three chars of a long-enough value", () => {
    expect(redactSecretValue("sk-abcdef123xyz")).toBe("⋯xyz");
  });

  it("reveals nothing for a short value", () => {
    expect(redactSecretValue("short")).toBe("⋯");
    expect(redactSecretValue("1234567")).toBe("⋯");
  });
});

describe("buildEnvSettings", () => {
  it("redacts a set secret and never includes the raw value", () => {
    const env = { ANTHROPIC_API_KEY: "sk-supersecret-1234tail" };
    const e = entry(env, "ANTHROPIC_API_KEY");
    expect(e.secret).toBe(true);
    expect(e.set).toBe(true);
    expect(e.value).toBe("⋯ail");
    // The serialized report (what the route sends) must not leak the raw value.
    expect(JSON.stringify(buildEnvSettings(env))).not.toContain("supersecret");
  });

  it("shows non-secret values verbatim", () => {
    const e = entry({ PORT: "4000" }, "PORT");
    expect(e.secret).toBe(false);
    expect(e.value).toBe("4000");
  });

  it("reports unset vars with no value", () => {
    const e = entry({}, "PORT");
    expect(e.set).toBe(false);
    expect(e.value).toBeUndefined();
  });

  it("distinguishes an explicitly empty value from unset", () => {
    const e = entry({ ALLOWED_IMAGE_PATHS: "" }, "ALLOWED_IMAGE_PATHS");
    expect(e.set).toBe(true);
    expect(e.value).toBe("");
  });

  it("does not fabricate a redacted preview for an empty secret", () => {
    const e = entry({ XAI_API_KEY: "" }, "XAI_API_KEY");
    expect(e.set).toBe(true);
    expect(e.value).toBe("");
  });
});

describe("startup snapshot", () => {
  it("captures a snapshot the getter then returns", () => {
    captureStartupEnvSettings({ PORT: "5555" });
    const port = getStartupEnvSettings().entries.find((e) => e.name === "PORT");
    expect(port?.value).toBe("5555");
  });
});
