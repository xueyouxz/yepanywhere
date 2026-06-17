import { z } from "zod";

export const BaseEntrySchema = z.object({
  // required
  isSidechain: z.boolean(),
  userType: z.enum(["external"]),
  cwd: z.string(),
  sessionId: z.string(),
  version: z.string(),
  uuid: z.string().uuid(),
  timestamp: z.string(),

  // nullable
  parentUuid: z.string().uuid().nullable(),

  // optional
  isMeta: z.boolean().optional(),
  toolUseResult: z.unknown().optional(),
  gitBranch: z.string().optional(),
  isCompactSummary: z.boolean().optional(),
  // Provenance stamped by Claude Code on injected entries. `origin.kind` is the
  // authoritative, non-heuristic signal for entries that arrive as `type: "user"`
  // but were not authored by the user (e.g. `task-notification`). Note that
  // `promptSource: "sdk"` is NOT such a signal — YA delivers genuine user turns
  // through the SDK too, so it appears on real prompts as well.
  origin: z
    .object({ kind: z.string() })
    .passthrough()
    .optional(),
  promptSource: z.string().optional(),
});
