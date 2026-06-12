import { describe, expect, it } from "vitest";
import { thinkingOptionToConfig } from "../src/types.js";

describe("thinkingOptionToConfig", () => {
  it("requests summarized display by default when thinking is enabled", () => {
    expect(thinkingOptionToConfig("auto")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
    });
    expect(thinkingOptionToConfig("on:high", "default")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      effort: "high",
    });
  });

  it("requests summarized display when show-thinking is on", () => {
    expect(thinkingOptionToConfig("auto", "on")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
    });
    expect(thinkingOptionToConfig("on:max", "on")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      effort: "max",
    });
  });

  it("keeps requesting summaries when the display preference is off", () => {
    expect(thinkingOptionToConfig("auto", "off")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
    });
  });

  it("never sets display when thinking is disabled", () => {
    expect(thinkingOptionToConfig("off", "on")).toEqual({
      thinking: { type: "disabled" },
    });
  });
});
