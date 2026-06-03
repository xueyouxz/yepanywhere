import { describe, expect, it } from "vitest";
import {
  SETTINGS_TWO_COLUMN_BREAKPOINT,
  shouldUseSettingsTwoColumn,
} from "../SettingsLayout";

describe("SettingsLayout", () => {
  it("uses the two-column settings layout before the app sidebar breakpoint", () => {
    expect(shouldUseSettingsTwoColumn(SETTINGS_TWO_COLUMN_BREAKPOINT - 1)).toBe(
      false,
    );
    expect(shouldUseSettingsTwoColumn(SETTINGS_TWO_COLUMN_BREAKPOINT)).toBe(
      true,
    );
    expect(shouldUseSettingsTwoColumn(800)).toBe(true);
    expect(shouldUseSettingsTwoColumn(1099)).toBe(true);
  });
});
