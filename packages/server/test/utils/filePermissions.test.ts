import { describe, expect, it } from "vitest";
import { buildOwnerOnlyIcaclsArgs } from "../../src/utils/filePermissions.js";

describe("buildOwnerOnlyIcaclsArgs", () => {
  it("builds a non-inherited owner-only ACL command", () => {
    expect(buildOwnerOnlyIcaclsArgs("C:\\Users\\dev\\.yep\\auth.json", "dev"))
      .toEqual([
        "C:\\Users\\dev\\.yep\\auth.json",
        "/inheritance:r",
        "/grant:r",
        "dev:F",
        "/remove:g",
        "*S-1-1-0",
        "*S-1-5-11",
        "*S-1-5-32-545",
        "*S-1-5-32-546",
      ]);
  });
});
