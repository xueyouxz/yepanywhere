import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { type TrustedProxy, parseTrustedProxies } from "./client-ip.js";
import type { LogConfig, LogLevel } from "./logger.js";

export interface RelayTelemetryRuntimeConfig {
  enabled: boolean;
  eventsDir: string;
  nodeId: string;
  sampleIntervalMs: number;
}

export interface RelayConfig {
  /** Port for the relay server (default: 4400) */
  port: number;
  /** File to write the actual port to after binding (for test harnesses) */
  portFile: string | null;
  /** Data directory for SQLite database (default: ~/.yep-relay/) */
  dataDir: string;
  /** Ping interval for waiting connections in ms (default: 60000) */
  pingIntervalMs: number;
  /** Pong timeout in ms - drop connection if no pong (default: 30000) */
  pongTimeoutMs: number;
  /** Days of inactivity before username can be reclaimed (default: 90) */
  reclaimDays: number;
  /** Pending unauthenticated WebSocket connections allowed per source IP. */
  unauthenticatedConnectionLimitPerIp: number;
  /** Time allowed for a new WebSocket to send a valid relay protocol message. */
  unauthenticatedConnectionTimeoutMs: number;
  /**
   * IPs/CIDRs whose `X-Forwarded-For` header is trusted when resolving the
   * client IP for the per-IP unauthenticated-connection cap. Empty by default
   * (use only the direct socket peer). Set this to the reverse proxy's IP
   * when running behind nginx/Caddy/Cloudflare; otherwise the per-IP cap
   * collapses into a single global counter.
   */
  trustedProxies: TrustedProxy[];
  /** Logging configuration */
  logging: LogConfig;
  /** Structured relay telemetry configuration */
  telemetry: RelayTelemetryRuntimeConfig;
}

function getEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function getEnvBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() !== "false" && value !== "0";
}

export function loadConfig(): RelayConfig {
  const dataDir = process.env.RELAY_DATA_DIR ?? join(homedir(), ".yep-relay");
  const logLevel = (process.env.RELAY_LOG_LEVEL ?? "info") as LogLevel;
  const fileLevel = (process.env.RELAY_LOG_FILE_LEVEL ?? logLevel) as LogLevel;

  return {
    port: getEnvNumber("RELAY_PORT", 4400),
    portFile: process.env.RELAY_PORT_FILE ?? null,
    dataDir,
    pingIntervalMs: getEnvNumber("RELAY_PING_INTERVAL_MS", 60_000),
    pongTimeoutMs: getEnvNumber("RELAY_PONG_TIMEOUT_MS", 30_000),
    reclaimDays: getEnvNumber("RELAY_RECLAIM_DAYS", 90),
    unauthenticatedConnectionLimitPerIp: getEnvNumber(
      "RELAY_UNAUTHENTICATED_CONNECTION_LIMIT_PER_IP",
      10,
    ),
    unauthenticatedConnectionTimeoutMs: getEnvNumber(
      "RELAY_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS",
      30_000,
    ),
    trustedProxies: parseTrustedProxies(process.env.RELAY_TRUSTED_PROXIES),
    logging: {
      logDir: process.env.RELAY_LOG_DIR ?? join(dataDir, "logs"),
      logFile: process.env.RELAY_LOG_FILE ?? "relay.log",
      consoleLevel: logLevel,
      fileLevel,
      logToConsole: getEnvBoolean("RELAY_LOG_TO_CONSOLE", true),
      logToFile: getEnvBoolean("RELAY_LOG_TO_FILE", true),
      prettyPrint: process.env.NODE_ENV !== "production",
    },
    telemetry: {
      enabled: getEnvBoolean("RELAY_TELEMETRY_ENABLED", true),
      eventsDir: process.env.RELAY_TELEMETRY_DIR ?? join(dataDir, "telemetry"),
      nodeId: process.env.RELAY_NODE_ID ?? hostname(),
      sampleIntervalMs: getEnvNumber(
        "RELAY_TELEMETRY_SAMPLE_INTERVAL_MS",
        60_000,
      ),
    },
  };
}
