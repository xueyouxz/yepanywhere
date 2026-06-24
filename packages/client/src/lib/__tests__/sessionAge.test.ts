import { describe, expect, it } from "vitest";
import { formatBriefAge, isKnownSessionTimestamp } from "../sessionAge";

describe("sessionAge", () => {
  describe("isKnownSessionTimestamp", () => {
    it("rejects missing, empty, and unparseable values", () => {
      expect(isKnownSessionTimestamp(undefined)).toBe(false);
      expect(isKnownSessionTimestamp(null)).toBe(false);
      expect(isKnownSessionTimestamp("")).toBe(false);
      expect(isKnownSessionTimestamp("not-a-date")).toBe(false);
    });

    it("rejects the unix-epoch sentinel (source of 'Created 20625d ago')", () => {
      expect(isKnownSessionTimestamp(new Date(0).toISOString())).toBe(false);
      expect(isKnownSessionTimestamp("1970-01-01T00:00:00.000Z")).toBe(false);
    });

    it("accepts a real, recent creation time", () => {
      expect(isKnownSessionTimestamp(new Date().toISOString())).toBe(true);
    });
  });

  describe("formatBriefAge", () => {
    it("returns null for unknown/default timestamps rather than an absurd age", () => {
      expect(formatBriefAge(undefined)).toBeNull();
      expect(formatBriefAge(new Date(0).toISOString())).toBeNull();
    });

    it("formats minutes, hours, and days for known timestamps", () => {
      const now = Date.now();
      expect(formatBriefAge(new Date(now - 5 * 60_000).toISOString())).toBe(
        "5m",
      );
      expect(formatBriefAge(new Date(now - 3 * 3_600_000).toISOString())).toBe(
        "3h",
      );
      expect(formatBriefAge(new Date(now - 2 * 86_400_000).toISOString())).toBe(
        "2d",
      );
    });
  });
});
