import { getModelContextWindow } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { resolveCompactWindow } from "../../src/routes/sessions.js";

const ONE_M = getModelContextWindow("opus[1m]", "claude");
// Stand-in for the route's resolveContextWindow (base family windows).
const fallback = (m: string | undefined): number =>
  m === "claude-haiku-4-5" ? 200_000 : 0;

describe("resolveCompactWindow (task 029 always-1M window)", () => {
  it("returns the 1M window for claude opus/sonnet, incl. resolved ids", () => {
    expect(resolveCompactWindow("claude", ["opus"], fallback)).toBe(ONE_M);
    // The live-process case that broke the trigger: resolved id, base resolver
    // would give 200K — always-1M must win.
    expect(resolveCompactWindow("claude", ["claude-opus-4-8"], fallback)).toBe(
      ONE_M,
    );
    expect(
      resolveCompactWindow("claude", ["claude-sonnet-4-6"], fallback),
    ).toBe(ONE_M);
  });

  it("uses the fallback for non-1M families and non-claude providers", () => {
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
