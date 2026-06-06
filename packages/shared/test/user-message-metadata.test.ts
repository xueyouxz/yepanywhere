import { describe, expect, it } from "vitest";
import {
  applyPatientQueuePrefix,
  stripPatientQueuePrefix,
} from "../src/user-message-metadata.js";

describe("patient queue prefix helpers", () => {
  it("applies the patient queue prefix once", () => {
    expect(applyPatientQueuePrefix("run tests", true)).toBe(
      "when done, run tests",
    );
    expect(applyPatientQueuePrefix("when done, run tests", true)).toBe(
      "when done, run tests",
    );
    expect(applyPatientQueuePrefix("run tests", false)).toBe("run tests");
  });

  it("strips one patient prefix for queued steering", () => {
    expect(stripPatientQueuePrefix("when done, run tests")).toBe("run tests");
    expect(stripPatientQueuePrefix("  When Done run tests")).toBe(
      "  run tests",
    );
  });

  it("does not strip a patient prefix into an empty steering message", () => {
    expect(stripPatientQueuePrefix("when done")).toBe("when done");
    expect(stripPatientQueuePrefix("zzz: ")).toBe("zzz: ");
  });
});
