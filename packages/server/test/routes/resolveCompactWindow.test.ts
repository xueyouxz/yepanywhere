import { getModelContextWindow } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { resolveCompactWindow } from "../../src/routes/sessions.js";

const ONE_M = getModelContextWindow("opus[1m]", "claude");
// Stand-in for the route's resolveContextWindow: base family windows, with the
// 1M window only for an explicit "[1m]" id.
const fallback = (m: string | undefined): number => {
  if (!m) return 0;
  if (m.includes("[1m]")) return ONE_M;
  if (m.includes("sonnet") || m.includes("haiku")) return 200_000;
  return 0;
};

describe("resolveCompactWindow (task 029 compaction window)", () => {
  it("returns the 1M window for opus (always-1M), incl. the resolved id", () => {
    expect(resolveCompactWindow("claude", ["opus"], fallback)).toBe(ONE_M);
    // The live-process case: resolved id, where the base resolver gives 200K —
    // opus must still resolve to 1M.
    expect(resolveCompactWindow("claude", ["claude-opus-4-8"], fallback)).toBe(
      ONE_M,
    );
  });

  it("does NOT force sonnet to 1M — bare sonnet uses the base window", () => {
    // Sonnet's 1M needs paid usage credits, so bare sonnet stays 200K.
    expect(resolveCompactWindow("claude", ["sonnet"], fallback)).toBe(200_000);
    expect(
      resolveCompactWindow("claude", ["claude-sonnet-4-6"], fallback),
    ).toBe(200_000);
  });

  it("honors an explicit sonnet[1m] choice via the resolver", () => {
    expect(resolveCompactWindow("claude", ["sonnet[1m]"], fallback)).toBe(
      ONE_M,
    );
  });

  it("uses the fallback for other families and non-claude providers", () => {
    expect(resolveCompactWindow("claude", ["claude-haiku-4-5"], fallback)).toBe(
      200_000,
    );
    expect(resolveCompactWindow("codex", ["gpt-5"], () => 400_000)).toBe(
      400_000,
    );
  });

  it("returns undefined when nothing resolves", () => {
    expect(
      resolveCompactWindow("claude", [undefined], fallback),
    ).toBeUndefined();
    expect(
      resolveCompactWindow("claude", ["default"], fallback),
    ).toBeUndefined();
  });
});
