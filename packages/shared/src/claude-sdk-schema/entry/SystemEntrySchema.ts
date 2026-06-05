import { z } from "zod";
import { BaseEntrySchema } from "./BaseEntrySchema.js";

// Regular system entry (tool-related)
const RegularSystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  content: z.string(),
  toolUseID: z.string(),
  level: z.enum(["info"]),
});

// Compact boundary system entry (conversation compaction)
const CompactBoundarySystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  subtype: z.literal("compact_boundary"),
  content: z.string(),
  level: z.enum(["info"]),
  slug: z.string().optional(),
  logicalParentUuid: z.string().uuid().optional(),
  compactMetadata: z
    .object({
      trigger: z.string(),
      preTokens: z.number(),
    })
    .optional(),
});

// Init system entry (session initialization with available commands/agents)
const InitSystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  cwd: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(z.string()).optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  slash_commands: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  claude_code_version: z.string().optional(),
  apiKeySource: z.string().optional(),
  output_style: z.string().optional(),
});

// Status system entry (compacting indicator)
const StatusSystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  subtype: z.literal("status"),
  status: z.enum(["compacting"]).nullable(),
});

// Session state change system entry (turn/liveness state)
const SessionStateChangedSystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  subtype: z.literal("session_state_changed"),
  session_id: z.string(),
  state: z.enum(["idle", "running", "requires_action"]),
});

// Microcompact boundary system entry
const MicrocompactBoundarySystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  subtype: z.literal("microcompact_boundary"),
  content: z.string(),
  level: z.string(),
  slug: z.string().optional(),
  microcompactMetadata: z
    .object({
      trigger: z.string(),
      preTokens: z.number(),
    })
    .passthrough()
    .optional(),
});

// API error system entry
const ApiErrorSystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  subtype: z.literal("api_error"),
  level: z.string(),
  error: z.unknown().optional(),
  cause: z.unknown().optional(),
  retryInMs: z.number().optional(),
  retryAttempt: z.number().optional(),
  maxRetries: z.number().optional(),
});

// Stop hook summary system entry
const StopHookSummarySystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  subtype: z.literal("stop_hook_summary"),
  level: z.string(),
  hookCount: z.number(),
  hookInfos: z.array(z.unknown()),
  hookErrors: z.array(z.unknown()),
  preventedContinuation: z.boolean(),
  stopReason: z.string(),
  hasOutput: z.boolean(),
});

// Bridge status system entry (remote control connection info)
const BridgeStatusSystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal("system"),
  subtype: z.literal("bridge_status"),
  content: z.string(),
  url: z.string().optional(),
  isMeta: z.boolean().optional(),
});

export const SystemEntrySchema = z.union([
  RegularSystemEntrySchema,
  CompactBoundarySystemEntrySchema,
  MicrocompactBoundarySystemEntrySchema,
  InitSystemEntrySchema,
  StatusSystemEntrySchema,
  SessionStateChangedSystemEntrySchema,
  ApiErrorSystemEntrySchema,
  StopHookSummarySystemEntrySchema,
  BridgeStatusSystemEntrySchema,
]);

export type SystemEntry = z.infer<typeof SystemEntrySchema>;

// Export InitSystemEntry type for consumers that need slash_commands
export type InitSystemEntry = z.infer<typeof InitSystemEntrySchema>;
