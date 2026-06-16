import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelInfoService } from "../src/services/ModelInfoService.js";

describe("ModelInfoService durable observations", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "yep-model-info-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns recorded observation over the static heuristic", () => {
    const svc = new ModelInfoService();
    // Static heuristic maps bare opus-4-8 (no [1m]) to 200K.
    expect(svc.getContextWindow("claude-opus-4-8", "claude")).toBe(200_000);
    // A real observation from a result message wins.
    svc.recordContextWindow("claude-opus-4-8", 1_000_000, "claude");
    expect(svc.getContextWindow("claude-opus-4-8", "claude")).toBe(1_000_000);
  });

  it("persists observations and reloads them on a fresh instance (restart)", async () => {
    const svc = new ModelInfoService({ dataDir });
    svc.recordContextWindow("claude-opus-4-8", 1_000_000, "claude");
    await svc.flush();

    // Simulate a server restart: a brand-new service reading the same dataDir.
    const restarted = new ModelInfoService({ dataDir });
    expect(restarted.getContextWindow("claude-opus-4-8", "claude")).toBe(
      200_000,
    ); // before load: static fallback
    await restarted.initialize();
    expect(restarted.getContextWindow("claude-opus-4-8", "claude")).toBe(
      1_000_000,
    ); // after load: durable observation
  });

  it("writes one record per model with a contextWindow and observedAt", async () => {
    const svc = new ModelInfoService({ dataDir });
    svc.recordContextWindow("claude-opus-4-8", 1_000_000, "claude");
    svc.recordContextWindow("claude-sonnet-4-6", 200_000, "claude");
    await svc.flush();

    const file = path.join(dataDir, "model-context-windows.json");
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.models)).toEqual([
      "claude:claude-opus-4-8",
      "claude:claude-sonnet-4-6",
    ]);
    const opus = parsed.models["claude:claude-opus-4-8"];
    expect(opus.contextWindow).toBe(1_000_000);
    expect(typeof opus.observedAt).toBe("string");
    // Only the two fields we care about — no cost/usage bloat.
    expect(Object.keys(opus).sort()).toEqual(["contextWindow", "observedAt"]);
  });

  it("re-flushes and refreshes observedAt on a repeat identical observation", async () => {
    const svc = new ModelInfoService({ dataDir });
    const file = path.join(dataDir, "model-context-windows.json");

    svc.recordContextWindow("claude-opus-4-8", 1_000_000, "claude");
    await svc.flush();
    const first = JSON.parse(await readFile(file, "utf-8")).models[
      "claude:claude-opus-4-8"
    ].observedAt;

    // Same value again: must still rewrite so observedAt = "last confirmed".
    await new Promise((r) => setTimeout(r, 5));
    svc.recordContextWindow("claude-opus-4-8", 1_000_000, "claude");
    await svc.flush();
    const second = JSON.parse(await readFile(file, "utf-8")).models[
      "claude:claude-opus-4-8"
    ].observedAt;

    expect(new Date(second).getTime()).toBeGreaterThan(
      new Date(first).getTime(),
    );
  });

  it("does not persist ephemeral ingested (provider-list/heuristic) values", async () => {
    const svc = new ModelInfoService({ dataDir });
    svc.ingestModels("claude", [
      { id: "opus[1m]", name: "Opus 1M", contextWindow: 1_000_000 },
    ]);
    // Ingested value is usable in memory...
    expect(svc.getContextWindow("opus[1m]", "claude")).toBe(1_000_000);
    await svc.flush();

    // ...but nothing was written, because no real observation was recorded.
    const restarted = new ModelInfoService({ dataDir });
    await restarted.initialize();
    // Falls back to the static heuristic ([1m] → 1M here), not a persisted value.
    expect(restarted.getContextWindow("opus[1m]", "claude")).toBe(1_000_000);
    await expect(
      readFile(path.join(dataDir, "model-context-windows.json"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prefers a durable observation over an ingested value for the same key", () => {
    const svc = new ModelInfoService();
    svc.ingestModels("claude", [
      { id: "claude-opus-4-8", name: "Opus", contextWindow: 200_000 },
    ]);
    expect(svc.getContextWindow("claude-opus-4-8", "claude")).toBe(200_000);
    svc.recordContextWindow("claude-opus-4-8", 1_000_000, "claude");
    expect(svc.getContextWindow("claude-opus-4-8", "claude")).toBe(1_000_000);
  });

  it("is memory-only (no throw, no file) without a dataDir", async () => {
    const svc = new ModelInfoService();
    svc.recordContextWindow("claude-opus-4-8", 1_000_000, "claude");
    await svc.flush();
    await svc.initialize();
    expect(svc.getContextWindow("claude-opus-4-8", "claude")).toBe(1_000_000);
  });
});
