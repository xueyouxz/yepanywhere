import { normalizeYaClientBaseUrlFromShareViewerUrl } from "@yep-anywhere/shared";

interface EnvAlias {
  canonical: string;
  legacy: readonly string[];
  normalizeLegacy?: (value: string, legacyName: string) => string;
}

/**
 * Startup environment migrations. Canonical names always win. Legacy names
 * are removed even when ignored so the live environment has one spelling.
 */
const STARTUP_ENV_COMPAT: readonly EnvAlias[] = [
  {
    canonical: "YEP_DATA_DIR",
    legacy: ["YEP_ANYWHERE_DATA_DIR"],
  },
  {
    canonical: "YEP_PROFILE",
    legacy: ["YEP_ANYWHERE_PROFILE"],
  },
  {
    canonical: "YEP_VOICE_BACKENDS",
    legacy: ["YA_VOICE_BACKENDS"],
  },
  {
    canonical: "YEP_DEFERRED_JOIN_WINDOW_S",
    legacy: ["YA_DEFERRED_JOIN_WINDOW_S"],
  },
  {
    canonical: "YEP_COMPOSE_ANCHORS",
    legacy: ["YA_COMPOSE_ANCHORS"],
  },
  {
    canonical: "YEP_STT_XAI_API_KEY",
    legacy: ["YA_stt__XAI_API_KEY"],
  },
  {
    canonical: "YEP_STT_DEEPGRAM_API_KEY",
    legacy: ["YA_stt__DEEPGRAM_API_KEY"],
  },
  {
    canonical: "YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS",
    legacy: ["YA_stt__SHARE_XAI_KEY_WITH_CLIENTS"],
  },
  {
    canonical: "YEP_CODEX_DISABLE_LIVE_DELTAS",
    legacy: ["YA_CODEX_DISABLE_LIVE_DELTAS"],
  },
  {
    canonical: "YEP_CLIENT_BASE_URL",
    legacy: [
      "YEP_YA_CLIENT_BASE_URL",
      "YEP_PUBLIC_SHARE_VIEWER_BASE_URL",
      "YEP_PUBLIC_SHARE_ORIGIN",
    ],
    normalizeLegacy(value, legacyName) {
      if (legacyName !== "YEP_PUBLIC_SHARE_VIEWER_BASE_URL") {
        return value;
      }
      try {
        return normalizeYaClientBaseUrlFromShareViewerUrl(value);
      } catch {
        // Preserve invalid input for the existing settings/status validation
        // path instead of turning compatibility normalization into a new
        // startup failure.
        return value;
      }
    },
  },
  {
    canonical: "YEP_ORIGINAL_BASH_ENV",
    legacy: ["YEP_ANYWHERE_ORIGINAL_BASH_ENV"],
  },
  {
    canonical: "YEP_ALLOW_SUSPICIOUS_HOME",
    legacy: ["YEP_ANYWHERE_ALLOW_SUSPICIOUS_HOME"],
  },
];

export function normalizeStartupEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const alias of STARTUP_ENV_COMPAT) {
    if (env[alias.canonical] === undefined) {
      const legacyName = alias.legacy.find((name) => env[name] !== undefined);
      if (legacyName) {
        const value = env[legacyName];
        if (value !== undefined) {
          env[alias.canonical] = alias.normalizeLegacy
            ? alias.normalizeLegacy(value, legacyName)
            : value;
        }
      }
    }

    for (const legacyName of alias.legacy) {
      delete env[legacyName];
    }
  }
}

normalizeStartupEnv();
