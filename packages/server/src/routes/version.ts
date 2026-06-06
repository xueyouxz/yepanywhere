import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ClientDefaults } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SpeechBackendCapabilities } from "../services/voice/SpeechBackend.js";
import { isNewerSemver } from "../utils/semver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

/**
 * Get version from git describe (for dev mode)
 * Returns something like "v0.1.7" or "v0.1.7-3-g050bfd2" (3 commits after tag)
 */
export function normalizeGitDescribeVersion(version: string): string | null {
  const trimmed = version.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v(?=\d)/, "");
}

async function getGitVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      "git describe --tags --always --match 'v[0-9]*.[0-9]*.[0-9]*'",
      { encoding: "utf-8" },
    );
    return normalizeGitDescribeVersion(stdout);
  } catch {
    return null;
  }
}

export type InstallSource =
  | "npm-global"
  | "source"
  | "release-package"
  | "unknown";

export interface CurrentVersionInfo {
  version: string;
  installSource: InstallSource;
}

/**
 * Read the current package version and best-effort install source.
 */
async function getCurrentVersionInfo(): Promise<CurrentVersionInfo> {
  try {
    // In production (npm package), package.json is in the parent of dist/
    // In development, it's in packages/server/
    const packageJsonPath = path.resolve(__dirname, "../../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const version = packageJson.version || "unknown";

    // 0.0.1 is the workspace version - we're in dev mode, use git instead
    if (version === "0.0.1") {
      return {
        version: (await getGitVersion()) || "dev",
        installSource: "source",
      };
    }

    return {
      version,
      installSource: await detectReleaseInstallSource(packageJsonPath),
    };
  } catch {
    return { version: "unknown", installSource: "unknown" };
  }
}

async function detectReleaseInstallSource(
  packageJsonPath: string,
): Promise<InstallSource> {
  const packageRoot = await realpathOrResolve(path.dirname(packageJsonPath));
  const npmGlobalRoot = await getNpmGlobalRoot();
  if (npmGlobalRoot && isPathInside(packageRoot, npmGlobalRoot)) {
    return "npm-global";
  }
  return "release-package";
}

async function getNpmGlobalRoot(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("npm root -g", {
      encoding: "utf-8",
    });
    const npmGlobalRoot = stdout.trim();
    if (!npmGlobalRoot) return null;
    return realpathOrResolve(npmGlobalRoot);
  } catch {
    return null;
  }
}

async function realpathOrResolve(value: string): Promise<string> {
  try {
    return await fs.promises.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

const UPDATE_SERVER_URL = "https://updates.yepanywhere.com/version";

// Cache for update server check (24 hour TTL for routine app traffic)
let cachedLatestVersion: { version: string; timestamp: number } | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch the latest version from the update server.
 * Sends current version and install ID for analytics.
 */
async function getLatestVersion(
  currentVersion: string,
  installId?: string,
  options?: { forceRefresh?: boolean },
): Promise<string | null> {
  // Return cached value if fresh
  if (
    !options?.forceRefresh &&
    cachedLatestVersion &&
    Date.now() - cachedLatestVersion.timestamp < CACHE_TTL_MS
  ) {
    return cachedLatestVersion.version;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (installId) {
      headers["X-CFU-ID"] = installId;
    }

    const response = await fetch(`${UPDATE_SERVER_URL}/${currentVersion}`, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    // 204 = no update available (current version is latest)
    if (response.status === 204) {
      cachedLatestVersion = { version: currentVersion, timestamp: Date.now() };
      return currentVersion;
    }

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { version?: string };
    const version = data.version || null;

    if (version) {
      cachedLatestVersion = { version, timestamp: Date.now() };
    }

    return version;
  } catch {
    // Network error, timeout, etc. - fail silently
    return null;
  }
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Best-effort install source for update guidance. Absent on older servers. */
  installSource?: InstallSource;
  /** Session resume protocol version supported by this server. */
  resumeProtocolVersion: number;
  /** Feature capabilities supported by this server. Used by clients to show/hide UI. */
  capabilities: string[];
  /**
   * Speech backend ids this server has validated and is willing to route
   * audio to. Browser-native remains client-side and is not listed here.
   */
  voiceBackends?: string[];
  /** Capability map keyed by server-routed speech backend id. */
  voiceBackendCapabilities?: Record<string, SpeechBackendCapabilities>;
  /** Device bridge availability and update state. */
  deviceBridgeState?: DeviceBridgeState;
  /** Installed managed bridge binary version when known. */
  deviceBridgeVersion?: string | null;
  /** Latest bridge release version when known. */
  latestDeviceBridgeVersion?: string | null;
  /** Server-learned browser defaults used when local storage is unset. */
  clientDefaults?: ClientDefaults;
}

/** Resume protocol version with mutual nonce challenge + server proof binding. */
export const RESUME_PROTOCOL_VERSION = 3;

/** Base capabilities always advertised. */
const BASE_CAPABILITIES = ["git-status"];

export type DeviceBridgeState =
  | "available"
  | "downloadable"
  | "update-available"
  | "unavailable";

export interface DeviceBridgeStatus {
  state: DeviceBridgeState;
  installedVersion?: string | null;
  latestVersion?: string | null;
}

export interface VersionRouteOptions {
  /** Dynamic device bridge state: available (binary exists), downloadable (ADB found, no binary), unavailable (no ADB). */
  getDeviceBridgeState?: () => DeviceBridgeState;
  /** Detailed device bridge status for version-aware update prompts. */
  getDeviceBridgeStatus?: (options?: {
    forceRefresh?: boolean;
  }) => Promise<DeviceBridgeStatus>;
  /** Whether the user has opted into the device bridge feature. */
  isDeviceBridgeEnabled?: () => boolean;
  /** Unique installation ID for update analytics. */
  installId?: string;
  /** Whether voice input is enabled (default: true). */
  voiceInputEnabled?: boolean;
  /**
   * Returns ids of server-routed speech backends validated at startup.
   * Browser-native is implicit and intentionally not included.
   */
  getEnabledVoiceBackends?: () => string[];
  /** Returns capabilities keyed by validated backend id. */
  getVoiceBackendCapabilities?: () => Record<string, SpeechBackendCapabilities>;
  /** Browser-client defaults persisted by this server. */
  getClientDefaults?: () => ClientDefaults | undefined;
}

export interface ServerCompatibilityInfo {
  appVersion: string;
  installSource: InstallSource;
  resumeProtocolVersion: number;
  renderProtocolVersion?: number;
  capabilities: string[];
  clientDefaults?: ClientDefaults;
}

function getCapabilitiesForDeviceBridgeState(
  state: DeviceBridgeState,
  enabled: boolean,
): string[] {
  if (state === "unavailable") {
    return [];
  }

  const capabilities = ["deviceBridge-available"];
  if (!enabled) {
    return capabilities;
  }

  if (state === "available") {
    capabilities.push("deviceBridge");
    return capabilities;
  }

  capabilities.push("deviceBridge-download");
  if (state === "update-available") {
    capabilities.push("deviceBridge-update");
  }
  return capabilities;
}

export function getServerCapabilities(options?: VersionRouteOptions): string[] {
  const capabilities = [...BASE_CAPABILITIES];
  if (options?.voiceInputEnabled !== false) {
    capabilities.push("voiceInput");
  }
  const deviceBridgeState = options?.getDeviceBridgeState?.() ?? "unavailable";
  const enabled = options?.isDeviceBridgeEnabled?.() ?? false;
  capabilities.push(
    ...getCapabilitiesForDeviceBridgeState(deviceBridgeState, enabled),
  );
  return capabilities;
}

export function getEnabledVoiceBackends(
  options?: VersionRouteOptions,
): string[] {
  if (options?.voiceInputEnabled === false) {
    return [];
  }
  return options?.getEnabledVoiceBackends?.() ?? [];
}

export function getVoiceBackendCapabilities(
  options?: VersionRouteOptions,
): Record<string, SpeechBackendCapabilities> {
  if (options?.voiceInputEnabled === false) {
    return {};
  }
  return options?.getVoiceBackendCapabilities?.() ?? {};
}

export function getServerCompatibilityInfo(
  options?: VersionRouteOptions,
): Promise<ServerCompatibilityInfo> {
  const clientDefaults = options?.getClientDefaults?.();
  return getCurrentVersionInfo().then((versionInfo) => ({
    appVersion: versionInfo.version,
    installSource: versionInfo.installSource,
    resumeProtocolVersion: RESUME_PROTOCOL_VERSION,
    capabilities: getServerCapabilities(options),
    ...(clientDefaults ? { clientDefaults } : {}),
  }));
}

export function createVersionRoutes(options?: VersionRouteOptions): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const currentVersionInfo = await getCurrentVersionInfo();
    const current = currentVersionInfo.version;
    const fresh =
      c.req.query("fresh") === "1" || c.req.query("fresh") === "true";
    const deviceBridgeStatus = options?.getDeviceBridgeStatus
      ? await options.getDeviceBridgeStatus({ forceRefresh: fresh })
      : { state: options?.getDeviceBridgeState?.() ?? "unavailable" };
    const enabled = options?.isDeviceBridgeEnabled?.() ?? false;
    const capabilities = [
      ...BASE_CAPABILITIES,
      ...(options?.voiceInputEnabled !== false ? ["voiceInput"] : []),
      ...getCapabilitiesForDeviceBridgeState(deviceBridgeStatus.state, enabled),
    ];
    const voiceBackends = getEnabledVoiceBackends(options);
    const voiceBackendCapabilities = getVoiceBackendCapabilities(options);
    const clientDefaults = options?.getClientDefaults?.();

    // For dev versions like "v0.1.7-3-g050bfd2", extract base version "v0.1.7"
    // to compare against the update server.
    const baseVersion = current.split("-")[0] || current;
    const latest = await getLatestVersion(baseVersion, options?.installId, {
      forceRefresh: fresh,
    });
    const updateAvailable = latest ? isNewerSemver(baseVersion, latest) : false;

    const info: VersionInfo = {
      current,
      latest,
      updateAvailable,
      installSource: currentVersionInfo.installSource,
      resumeProtocolVersion: RESUME_PROTOCOL_VERSION,
      capabilities,
      voiceBackends,
      voiceBackendCapabilities,
      deviceBridgeState: deviceBridgeStatus.state,
      deviceBridgeVersion: deviceBridgeStatus.installedVersion ?? null,
      latestDeviceBridgeVersion: deviceBridgeStatus.latestVersion ?? null,
      ...(clientDefaults ? { clientDefaults } : {}),
    };

    return c.json(info);
  });

  return routes;
}
