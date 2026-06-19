import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../src/logging/logger.js";
import { LocalNemoBackend } from "../../src/services/voice/localNemoBackend.js";
import { LocalParakeetBackend } from "../../src/services/voice/localParakeetBackend.js";
import {
  applyLastUsedSpeechModels,
  initSpeechBackendRegistry,
} from "../../src/services/voice/registry.js";

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

  it("enables the NeMo Parakeet backend only when explicitly requested", async () => {
    vi.spyOn(LocalNemoBackend.prototype, "validate").mockResolvedValue({
      ok: true,
    });

    const registry = await initSpeechBackendRegistry({
      voiceInputEnabled: true,
      voiceBackends: ["ya-nemo"],
      nemoModel: "nvidia/parakeet-rnnt-1.1b",
      nemoDevice: "cuda:0",
    });

    expect(registry.enabledIds()).toEqual(["ya-nemo"]);
    expect(registry.allInfo()).toEqual([
      {
        id: "ya-nemo",
        label: "Local NeMo Parakeet (pixi stt)",
        enabled: true,
        capabilities: {},
        disabledReason: undefined,
      },
    ]);
  });
});

describe("applyLastUsedSpeechModels", () => {
  it("fills a backend model from the last-used map when unset", () => {
    const merged = applyLastUsedSpeechModels(
      { voiceInputEnabled: true },
      { "ya-nemo": "nvidia/parakeet-rnnt-1.1b" },
    );
    expect(merged.nemoModel).toBe("nvidia/parakeet-rnnt-1.1b");
  });

  it("keeps an explicit (env) model over the last-used one", () => {
    const merged = applyLastUsedSpeechModels(
      { nemoModel: "nvidia/parakeet-ctc-1.1b" },
      { "ya-nemo": "nvidia/parakeet-rnnt-1.1b" },
    );
    expect(merged.nemoModel).toBe("nvidia/parakeet-ctc-1.1b");
  });

  it("maps each local backend id to its own model field", () => {
    const merged = applyLastUsedSpeechModels(
      {},
      {
        "ya-whisper": "distil-large-v3",
        "ya-parakeet": "nvidia/parakeet-ctc-1.1b",
        "ya-nemo": "nvidia/parakeet-rnnt-1.1b",
      },
    );
    expect(merged.whisperModel).toBe("distil-large-v3");
    expect(merged.parakeetModel).toBe("nvidia/parakeet-ctc-1.1b");
    expect(merged.nemoModel).toBe("nvidia/parakeet-rnnt-1.1b");
  });

  it("returns options unchanged when there is no last-used map", () => {
    const options = { nemoModel: "x", parakeetModel: "y" };
    expect(applyLastUsedSpeechModels(options, undefined)).toEqual(options);
  });

  it("ignores backend ids without a local model field", () => {
    const merged = applyLastUsedSpeechModels({}, { "ya-grok": "whatever" });
    expect(merged.nemoModel).toBeUndefined();
    expect(merged.parakeetModel).toBeUndefined();
    expect(merged.whisperModel).toBeUndefined();
  });
});
