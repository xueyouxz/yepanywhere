import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathInsideDirectory } from "../../src/frontend/static.js";

describe("static file path containment", () => {
  it("rejects sibling paths that share the dist directory prefix", () => {
    const root = path.resolve("/tmp/yep-static-test/dist");
    const sibling = path.resolve("/tmp/yep-static-test/dist-secret/file.txt");

    expect(isPathInsideDirectory(path.join(root, "assets/app.js"), root)).toBe(
      true,
    );
    expect(isPathInsideDirectory(sibling, root)).toBe(false);
    expect(isPathInsideDirectory(path.resolve(root, "../secret.txt"), root)).toBe(
      false,
    );
  });
});
