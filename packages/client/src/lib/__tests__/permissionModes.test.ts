import { describe, expect, it } from "vitest";
import { getPermissionModeOptions } from "../permissionModes";

describe("permission mode options", () => {
  it("keeps legacy modes when a model does not advertise auto mode", () => {
    expect(getPermissionModeOptions()).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
  });

  it("adds auto mode only for models that advertise it", () => {
    expect(
      getPermissionModeOptions({
        model: { id: "fable", name: "Fable", supportsAutoMode: true },
      }),
    ).toEqual(["default", "acceptEdits", "plan", "bypassPermissions", "auto"]);
  });

  it("preserves an already-selected auto mode for display", () => {
    expect(getPermissionModeOptions({ currentMode: "auto" })).toContain("auto");
  });
});
