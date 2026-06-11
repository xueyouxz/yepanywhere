import type { ProviderInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { resolveSessionProviderCapabilities } from "../providerCapabilities";

function provider(
  name: ProviderInfo["name"],
  supportsSteering?: boolean,
  supportsSteerNow?: boolean,
): ProviderInfo {
  return {
    name,
    displayName: name,
    installed: true,
    authenticated: true,
    enabled: true,
    supportsSteering,
    supportsSteerNow,
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
    expect(capabilities.supportsCurrentTurnSteering).toBe(true);
    expect(capabilities.supportsSteerNow).toBe(false);
  });

  it("uses fetched metadata once it is available", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [provider("codex", false)],
      providerName: "codex",
    });

    expect(capabilities.generallySupportsSteering).toBe(true);
    expect(capabilities.supportsCurrentTurnSteering).toBe(false);
    expect(capabilities.supportsSteerNow).toBe(false);
  });

  it("does not treat codex-oss as steerable without provider metadata", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [],
      providerName: "codex-oss",
    });

    expect(capabilities.generallySupportsSteering).toBe(false);
    expect(capabilities.supportsCurrentTurnSteering).toBe(false);
    expect(capabilities.supportsSteerNow).toBe(false);
  });

  it("honors non-Codex providers that advertise steering", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [provider("grok", true)],
      providerName: "grok",
    });

    expect(capabilities.generallySupportsSteering).toBe(true);
    expect(capabilities.supportsCurrentTurnSteering).toBe(true);
    expect(capabilities.supportsSteerNow).toBe(false);
  });

  it("reports soft-immediate steering only when metadata says so", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [provider("claude", true, true)],
      providerName: "claude",
    });

    expect(capabilities.generallySupportsSteering).toBe(true);
    expect(capabilities.supportsCurrentTurnSteering).toBe(true);
    expect(capabilities.supportsSteerNow).toBe(true);
  });
});
