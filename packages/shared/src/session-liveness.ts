export type SessionLivenessDerivedStatus =
  | "verified-progressing"
  | "recently-active-unverified"
  | "long-silent-unverified"
  | "verified-waiting-provider"
  | "verified-idle"
  | "needs-attention";

export type SessionActiveWorkKind =
  | "none"
  | "agent-turn"
  | "waiting-input"
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

export interface SessionProviderRetentionSnapshot {
  retained: boolean;
  reasons: string[];
  backgroundTaskCount?: number;
  sessionCronCount?: number;
  liveTaskCount?: number;
  lastUpdatedAt?: string | null;
}

export type SessionWakeReason =
  | "session-state-running"
  | "session-state-requires-action"
  | "provider-message-after-idle"
  | "user-message"
  | "tool-approval-resolved";

export interface SessionWakeReasonSnapshot {
  at: string;
  fromState: "idle" | "in-turn" | "waiting-input" | "terminated";
  reason: SessionWakeReason;
  messageType?: string;
  messageSubtype?: string;
}

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
  providerRetention?: SessionProviderRetentionSnapshot;
  lastWakeReason?: SessionWakeReasonSnapshot;
  queueDepth: number;
  deferredQueueDepth: number;
}
