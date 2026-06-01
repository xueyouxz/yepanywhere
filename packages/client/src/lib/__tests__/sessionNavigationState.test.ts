import { describe, expect, it } from "vitest";
import {
  createSessionNavigationState,
  normalizeInitialSessionStatus,
  parseSessionNavigationState,
} from "../sessionNavigationState";

describe("session navigation state", () => {
  it("accepts current self-owned initial status", () => {
    expect(
      normalizeInitialSessionStatus({
        owner: "self",
        processId: "process-1",
      }),
    ).toEqual({ owner: "self", processId: "process-1" });
  });

  it("normalizes legacy owned initial status from browser history", () => {
    expect(
      normalizeInitialSessionStatus({
        state: "owned",
        processId: "process-1",
      }),
    ).toEqual({ owner: "self", processId: "process-1" });
  });

  it("drops malformed initial status", () => {
    expect(
      normalizeInitialSessionStatus({
        state: "owned",
      }),
    ).toBeUndefined();
  });

  it("parses only valid typed navigation fields", () => {
    expect(
      parseSessionNavigationState({
        initialStatus: { state: "owned", processId: "process-1" },
        initialTitle: "Start here",
        initialModel: "gpt-5.3-codex",
        initialProvider: "codex",
        ignored: true,
      }),
    ).toEqual({
      initialStatus: { owner: "self", processId: "process-1" },
      initialTitle: "Start here",
      initialModel: "gpt-5.3-codex",
      initialProvider: "codex",
    });
  });

  it("creates canonical navigation state", () => {
    expect(
      createSessionNavigationState({
        initialStatus: { owner: "self", processId: "process-1" },
        initialProvider: "codex",
      }),
    ).toEqual({
      initialStatus: { owner: "self", processId: "process-1" },
      initialProvider: "codex",
    });
  });
});
