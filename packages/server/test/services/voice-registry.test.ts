import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../src/logging/logger.js";
import { LocalParakeetBackend } from "../../src/services/voice/localParakeetBackend.js";
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
        capabilities: {},
        disabledReason: undefined,
      },
    ]);
  });

  it("logs enabled cloud backends consistently", async () => {
    const infoSpy = vi.spyOn(getLogger(), "info").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    const registry = await initSpeechBackendRegistry({
      voiceInputEnabled: true,
      deepgramApiKey: "dg-key",
      xaiSttApiKey: "xai-key",
    });

    expect(registry.enabledIds()).toEqual(["ya-deepgram", "ya-grok"]);
    expect(infoSpy).toHaveBeenCalledWith(
      '[Voice] Backend "ya-deepgram" enabled',
    );
    expect(infoSpy).toHaveBeenCalledWith('[Voice] Backend "ya-grok" enabled');
  });

  it("does not register backends when voice input is disabled", async () => {
    const registry = await initSpeechBackendRegistry({
      voiceInputEnabled: false,
      voiceBackends: ["ya-dummy"],
    });

    expect(registry.enabledIds()).toEqual([]);
  });

  it("logs and skips unknown backend ids", async () => {
    const warnSpy = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});

    const registry = await initSpeechBackendRegistry({
      voiceInputEnabled: true,
      voiceBackends: ["not-real"],
    });

    expect(registry.enabledIds()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[Voice] Unknown speech backend requested: not-real",
    );
  });

  it("enables the Parakeet backend only when explicitly requested", async () => {
    vi.spyOn(LocalParakeetBackend.prototype, "validate").mockResolvedValue({
      ok: true,
    });

    const registry = await initSpeechBackendRegistry({
      voiceInputEnabled: true,
      voiceBackends: ["ya-parakeet"],
      parakeetModel: "nvidia/parakeet-tdt-0.6b-v3",
      parakeetDevice: "cuda:0",
    });

    expect(registry.enabledIds()).toEqual(["ya-parakeet"]);
    expect(registry.allInfo()).toEqual([
      {
        id: "ya-parakeet",
        label: "Local Parakeet (pixi stt)",
        enabled: true,
        capabilities: {},
        disabledReason: undefined,
      },
    ]);
  });
});
