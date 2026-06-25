import {
  type RecapMode,
  normalizeRecapAfterSeconds,
} from "@yep-anywhere/shared";
import type { useI18n } from "../i18n";

type Translate = ReturnType<typeof useI18n>["t"];

export function getRecapModeDescription(
  mode: RecapMode,
  t: Translate,
  recapAfterSeconds: number,
): string {
  const seconds = normalizeRecapAfterSeconds(recapAfterSeconds);
  switch (mode) {
    case "native":
      return t("recapModeNativeTimedDescription", { seconds });
    case "side-session":
      return t("recapModeSideSessionTimedDescription", { seconds });
    case "fork":
      return t("recapModeForkTimedDescription", { seconds });
    case "off":
      return t("recapModeOffDescription");
  }
}
