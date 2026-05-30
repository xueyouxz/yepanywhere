export type SessionLivenessDerivedStatus =
  | "verified-progressing"
  | "recently-active-unverified"
  | "long-silent-unverified"
  | "verified-waiting-provider"
  | "verified-idle"
  | "verified-held"
  | "needs-attention";

export type SessionActiveWorkKind =
  | "none"
  | "agent-turn"
  | "waiting-input"
  | "held"
  | "terminated"
  | "unknown";

export type SessionLivenessProbeStatus =
  | "active"
  | "idle"
  | "waiting-input"
  | "not-loaded"
  | "system-error"
  | "unavailable"
  | "error";

export interface SessionLivenessSnapshot {
  checkedAt: string;
  derivedStatus: SessionLivenessDerivedStatus;
  activeWorkKind: SessionActiveWorkKind;
  state: string;
  evidence: string[];
  lastProviderMessageAt: string | null;
  lastRawProviderEventAt: string | null;
  lastRawProviderEventSource: string | null;
  lastStateChangeAt: string;
  lastVerifiedProgressAt: string | null;
  lastVerifiedIdleAt: string | null;
  lastLivenessProbeAt: string | null;
  lastLivenessProbeStatus: SessionLivenessProbeStatus | null;
  lastLivenessProbeSource: string | null;
  lastLivenessProbeDetail?: string;
  silenceMs: number | null;
  longSilenceThresholdMs: number;
  processAlive?: boolean;
  queueDepth: number;
  deferredQueueDepth: number;
}
