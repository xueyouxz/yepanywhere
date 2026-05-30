import type { AppSession } from "./app-types.js";
import type { UrlProjectId } from "./projectId.js";
import type { ProviderName } from "./types.js";

export type PublicSessionShareMode = "frozen" | "live";

export interface CreatePublicSessionShareRequest {
  projectId: UrlProjectId;
  sessionId: string;
  mode: PublicSessionShareMode;
  title?: string;
  initialPrompt?: string;
}

export interface CreatePublicSessionShareResponse {
  url: string;
  mode: PublicSessionShareMode;
  createdAt: string;
  secretBits: number;
}

export interface PublicSessionShareSessionStatusResponse {
  activeCount: number;
  frozenCount: number;
  liveCount: number;
  activeViewerCount: number;
  viewers: PublicSessionShareViewerSummary[];
}

export interface RevokePublicSessionSharesResponse
  extends PublicSessionShareSessionStatusResponse {
  revokedCount: number;
}

export interface FreezePublicSessionLiveSharesResponse
  extends PublicSessionShareSessionStatusResponse {
  convertedCount: number;
}

export interface PublicSessionShareViewerActionResponse
  extends PublicSessionShareSessionStatusResponse {
  viewerId: string;
  convertedCount?: number;
}

export interface PublicSessionShareViewerHeartbeatResponse {
  activeViewerCount: number;
}

export interface PublicSessionShareViewerSummary {
  viewerId: string;
  shortId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  accessCount: number;
  active: boolean;
  disconnected: boolean;
  frozen: boolean;
}

export interface PublicSessionShareMetadata {
  mode: PublicSessionShareMode;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  activeViewerCount?: number;
  capturedAt?: string;
  source: {
    projectId: UrlProjectId;
    sessionId: string;
    projectName?: string;
    provider?: ProviderName;
  };
}

export interface PublicSessionShareResponse {
  share: PublicSessionShareMetadata;
  session: AppSession;
}
