/**
 * NullSessionReader — a safe, empty ISessionReader for a provider whose durable
 * transcript reader is not implemented yet.
 *
 * It reports no sessions and no content rather than mis-parsing another
 * provider's on-disk format. Used by the `pi` provider until `PiSessionReader`
 * lands (see topics/pi-provider.md § "Durable transcripts"): live YA-owned pi
 * sessions still stream via the Supervisor, but reload/attach/listing of
 * on-disk pi sessions is intentionally empty for now.
 */

import type { UrlProjectId } from "@yep-anywhere/shared";
import type { Message, SessionSummary } from "../supervisor/types.js";
import type { ISessionReader, LoadedSession } from "./types.js";

export class NullSessionReader implements ISessionReader {
  async listSessions(_projectId: UrlProjectId): Promise<SessionSummary[]> {
    return [];
  }

  async getSessionSummary(
    _sessionId: string,
    _projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    return null;
  }

  async getSession(
    _sessionId: string,
    _projectId: UrlProjectId,
  ): Promise<LoadedSession | null> {
    return null;
  }

  async getSessionSummaryIfChanged(
    _sessionId: string,
    _projectId: UrlProjectId,
    _cachedMtime: number,
    _cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    return null;
  }

  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
  }
}
