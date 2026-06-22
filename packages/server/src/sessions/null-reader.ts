/**
 * NullSessionReader — a safe, empty ISessionReader for a provider whose durable
 * transcript reader is not implemented yet.
 *
 * It reports no sessions and no content rather than mis-parsing another
 * provider's on-disk format — the safe placeholder for a provider whose durable
 * reader has not been written. No provider currently uses it (pi moved to
 * `PiSessionReader`); kept as the null-object default for the next such case.
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
