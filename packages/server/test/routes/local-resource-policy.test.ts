import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPathInsideDirectory,
  isSupportedAbsoluteLocalPath,
  LOCAL_MEDIA_EXTENSIONS,
} from "../../src/routes/local-resource-policy.js";

describe("local resource path policy", () => {
  it("classifies local absolute path syntax by server platform", () => {
    expect(isSupportedAbsoluteLocalPath("/tmp/probe.json", "linux")).toBe(true);
    expect(
      isSupportedAbsoluteLocalPath("//host/share/probe.json", "linux"),
    ).toBe(false);
    expect(isSupportedAbsoluteLocalPath("C:/tmp/probe.json", "linux")).toBe(
      false,
    );
    expect(isSupportedAbsoluteLocalPath("C:/tmp/probe.json", "win32")).toBe(
      true,
    );
    expect(isSupportedAbsoluteLocalPath("C:\\tmp\\probe.json", "win32")).toBe(
      true,
    );
    expect(isSupportedAbsoluteLocalPath("/C:/tmp/probe.json", "win32")).toBe(
      true,
    );
    expect(isSupportedAbsoluteLocalPath("tmp/probe.json", "win32")).toBe(false);
  });

  it("keeps resolved files inside allowed directories", () => {
    const root = path.resolve("/tmp/yep-local-resource-root");
    const child = path.join(root, "nested", "probe.json");
    const sibling = path.join(`${root}-sibling`, "probe.json");

    expect(isPathInsideDirectory(child, root)).toBe(true);
    expect(isPathInsideDirectory(sibling, root)).toBe(false);
    expect(isPathInsideDirectory(root, root)).toBe(false);
  });

  it("shares media extension policy with both local resource routes", () => {
    expect(LOCAL_MEDIA_EXTENSIONS.has(".png")).toBe(true);
    expect(LOCAL_MEDIA_EXTENSIONS.has(".ogv")).toBe(true);
    expect(LOCAL_MEDIA_EXTENSIONS.has(".json")).toBe(false);
  });
});
