import { describe, expect, it } from "vitest";
import {
  SETTINGS_TWO_COLUMN_MIN_WIDTH,
  shouldUseSettingsTwoColumn,
} from "../SettingsLayout";

describe("SettingsLayout", () => {
  it("uses the actual settings-container width for the two-column layout", () => {
    expect(shouldUseSettingsTwoColumn(SETTINGS_TWO_COLUMN_MIN_WIDTH - 1)).toBe(
      false,
    );
    expect(shouldUseSettingsTwoColumn(SETTINGS_TWO_COLUMN_MIN_WIDTH)).toBe(
      true,
    );
  });
});
