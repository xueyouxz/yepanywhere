import { describe, expect, it } from "vitest";
import { reconcileParakeetBackendForModel } from "../parakeetModels";

const RNNT = "nvidia/parakeet-rnnt-1.1b"; // NeMo-only
const TDT = "nvidia/parakeet-tdt-0.6b-v3"; // both backends

describe("reconcileParakeetBackendForModel", () => {
  it("reroutes a NeMo-only model off ya-parakeet to ya-nemo when available", () => {
    expect(
      reconcileParakeetBackendForModel("ya-parakeet", RNNT, [
        "ya-parakeet",
        "ya-nemo",
      ]),
    ).toBe("ya-nemo");
  });

  it("leaves a compatible pair unchanged", () => {
    expect(reconcileParakeetBackendForModel("ya-nemo", RNNT, ["ya-nemo"])).toBe(
      "ya-nemo",
    );
    expect(
      reconcileParakeetBackendForModel("ya-parakeet", TDT, [
        "ya-parakeet",
        "ya-nemo",
      ]),
    ).toBe("ya-parakeet");
  });

  it("keeps the method as-is when no compatible backend is available", () => {
    // ya-nemo not enabled -> can't reroute rnnt; keep ya-parakeet so the
    // request fails with a clear model-load error rather than silent reroute.
    expect(
      reconcileParakeetBackendForModel("ya-parakeet", RNNT, ["ya-parakeet"]),
    ).toBe("ya-parakeet");
  });

  it("passes non-Parakeet methods through untouched", () => {
    expect(
      reconcileParakeetBackendForModel("browser-native", RNNT, ["ya-nemo"]),
    ).toBe("browser-native");
    expect(reconcileParakeetBackendForModel("ya-grok", TDT, ["ya-nemo"])).toBe(
      "ya-grok",
    );
  });
});
