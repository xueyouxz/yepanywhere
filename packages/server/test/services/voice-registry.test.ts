import { afterEach, describe, expect, it, vi } from "vitest";
import { initSpeechBackendRegistry } from "../../src/services/voice/registry.js";

describe("initSpeechBackendRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to no server-routed backends", async () => {
    const registry = await initSpeechBackendRegistry({
      voiceInputEnabled: true,
    });

    expect(registry.enabledIds()).toEqual([]);
    expect(registry.allInfo()).toEqual([]);
  });

  it("enables the dummy backend only when explicitly requested", async () => {
    const registry = await initSpeechBackendRegistry({
      voiceInputEnabled: true,
      voiceBackends: ["ya-dummy"],
    });

    expect(registry.enabledIds()).toEqual(["ya-dummy"]);
    expect(registry.allInfo()).toEqual([
      {
        id: "ya-dummy",
        label: "YA dummy (test only)",
        enabled: true,
        disabledReason: undefined,
      },
    ]);
  });

  it("does not register backends when voice input is disabled", async () => {
    const registry = await initSpeechBackendRegistry({
      voiceInputEnabled: false,
      voiceBackends: ["ya-dummy"],
    });

    expect(registry.enabledIds()).toEqual([]);
  });

  it("logs and skips unknown backend ids", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const registry = await initSpeechBackendRegistry({
      voiceInputEnabled: true,
      voiceBackends: ["not-real"],
    });

    expect(registry.enabledIds()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[Voice] Unknown speech backend requested: not-real",
    );
  });
});
