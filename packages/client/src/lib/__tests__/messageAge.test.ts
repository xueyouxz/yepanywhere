import { describe, expect, it } from "vitest";
import {
  MESSAGE_STALE_THRESHOLD_MS,
  formatCompactRelativeAge,
  isStaleTimestamp,
  parseTimestampMs,
} from "../messageAge";

describe("messageAge", () => {
  const now = Date.UTC(2026, 3, 26, 12, 0, 0);

  it("formats compact relative ages", () => {
    expect(formatCompactRelativeAge(now - 10_000, now)).toBe("now");
    expect(formatCompactRelativeAge(now - 4 * 60_000, now)).toBe("4m");
    expect(formatCompactRelativeAge(now - 2 * 60 * 60_000, now)).toBe("2h");
    expect(
      formatCompactRelativeAge(now - (1 * 24 + 3) * 60 * 60_000, now),
    ).toBe("1d 3h");
  });

  it("checks the 5 minute stale threshold", () => {
    expect(isStaleTimestamp(now - MESSAGE_STALE_THRESHOLD_MS + 1, now)).toBe(
      false,
    );
    expect(isStaleTimestamp(now - MESSAGE_STALE_THRESHOLD_MS, now)).toBe(true);
  });

  it("ignores invalid timestamps", () => {
    expect(parseTimestampMs("not-a-date")).toBeNull();
    expect(parseTimestampMs(null)).toBeNull();
  });
});
