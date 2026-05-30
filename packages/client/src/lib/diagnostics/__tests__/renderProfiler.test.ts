import { afterEach, describe, expect, it, vi } from "vitest";
import { profileRenderWork } from "../renderProfiler";

describe("profileRenderWork", () => {
  afterEach(() => {
    delete window.__RENDER_PROFILE__;
    vi.restoreAllMocks();
  });

  it("preserves the wrapped return value below the logging threshold", () => {
    window.__RENDER_PROFILE__ = { thresholdMs: 8 };
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(1);

    const result = profileRenderWork(
      "test-render",
      { chars: 5 },
      () => "rendered",
    );

    expect(result).toBe("rendered");
  });
});
