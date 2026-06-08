import { describe, expect, it } from "vitest";
import { thinkingOptionToConfig } from "../src/types.js";

describe("thinkingOptionToConfig", () => {
  it("leaves display unset for provider-native default", () => {
    expect(thinkingOptionToConfig("auto")).toEqual({
      thinking: { type: "adaptive" },
    });
    expect(thinkingOptionToConfig("on:high", "default")).toEqual({
      thinking: { type: "adaptive" },
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

  it("explicitly omits display when show-thinking is off", () => {
    expect(thinkingOptionToConfig("auto", "off")).toEqual({
      thinking: { type: "adaptive", display: "omitted" },
    });
  });

  it("never sets display when thinking is disabled", () => {
    expect(thinkingOptionToConfig("off", "on")).toEqual({
      thinking: { type: "disabled" },
    });
  });
});
