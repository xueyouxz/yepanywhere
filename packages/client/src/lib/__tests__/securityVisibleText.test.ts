import { describe, expect, it } from "vitest";
import {
  makeSecurityVisibleText,
  makeSecurityVisibleValue,
} from "../securityVisibleText";

describe("security visible text", () => {
  it("escapes bidi overrides and zero-width characters", () => {
    expect(makeSecurityVisibleText("abc\u202Edef\u200Bghi")).toBe(
      "abc[U+202E RLO]def[U+200B ZWSP]ghi",
    );
  });

  it("keeps ordinary whitespace readable", () => {
    expect(makeSecurityVisibleText("line 1\nline 2\tok")).toBe(
      "line 1\nline 2\tok",
    );
  });

  it("recursively escapes strings in objects", () => {
    expect(
      makeSecurityVisibleValue({
        "pa\u202Eth": "a\u200Bb",
        nested: ["x\u2066y"],
      }),
    ).toEqual({
      "pa[U+202E RLO]th": "a[U+200B ZWSP]b",
      nested: ["x[U+2066 LRI]y"],
    });
  });
});
