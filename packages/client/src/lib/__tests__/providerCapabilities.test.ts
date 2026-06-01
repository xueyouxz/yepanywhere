import type { ProviderInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { resolveSessionProviderCapabilities } from "../providerCapabilities";

function provider(
  name: ProviderInfo["name"],
  supportsSteering?: boolean,
): ProviderInfo {
  return {
    name,
    displayName: name,
    installed: true,
    authenticated: true,
    enabled: true,
    supportsSteering,
  };
}

describe("resolveSessionProviderCapabilities", () => {
  it("uses static Codex steering while provider metadata is still loading", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [],
      providerName: "codex",
    });

    expect(capabilities.providerInfo).toBeNull();
    expect(capabilities.generallySupportsSteering).toBe(true);
    expect(capabilities.supportsSteeringNow).toBe(true);
  });

  it("uses fetched metadata once it is available", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [provider("codex", false)],
      providerName: "codex",
    });

    expect(capabilities.generallySupportsSteering).toBe(true);
    expect(capabilities.supportsSteeringNow).toBe(false);
  });

  it("does not treat codex-oss as steerable without provider metadata", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [],
      providerName: "codex-oss",
    });

    expect(capabilities.generallySupportsSteering).toBe(false);
    expect(capabilities.supportsSteeringNow).toBe(false);
  });

  it("honors non-Codex providers that advertise steering", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [provider("grok", true)],
      providerName: "grok",
    });

    expect(capabilities.generallySupportsSteering).toBe(true);
    expect(capabilities.supportsSteeringNow).toBe(true);
  });
});
