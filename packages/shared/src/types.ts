/**
 * Provider name - which AI agent provider to use.
 * - "claude": Claude via Anthropic SDK
 * - "codex": OpenAI Codex via SDK (cloud models)
 * - "codex-oss": Codex via CLI with --oss (local models via Ollama)
 * - "gemini": Google Gemini via CLI
 * - "gemini-acp": Gemini via CLI with --experimental-acp (preferred)
 * - "grok": Grok Build via ACP (`grok agent stdio`) - Phase 1 isolated prototype
 * - "opencode": OpenCode via HTTP server (multi-provider agent)
 *
 * "grok" added (additive only) for Phase 1 Grok Build provider per topics/grok.md.
 * Gated behind ENABLED_PROVIDERS=grok; no impact on other providers or core paths.
 */
export type ProviderName =
  | "claude"
  | "claude-ollama"
  | "codex"
  | "codex-oss"
  | "gemini"
  | "gemini-acp"
  | "grok"
  | "opencode";

/**
 * All provider names in display order.
 * Used for filter dropdowns, iteration, etc.
 * Keep in sync with ProviderName type above.
 *
 * "grok" added (additive) - see ProviderName comment for isolation/ENABLED_PROVIDERS notes.
 */
export const ALL_PROVIDERS: readonly ProviderName[] = [
  "claude",
  "claude-ollama",
  "codex",
  "codex-oss",
  "gemini",
  "gemini-acp",
  "grok",
  "opencode",
] as const;

/**
 * The default provider when none is specified.
 * Used for backward compatibility with existing sessions that don't have provider set.
 */
export const DEFAULT_PROVIDER: ProviderName = "claude";

/**
 * Model information for a provider.
 */
export interface ModelInfo {
  /** Model identifier (e.g., "sonnet", "qwen2.5-coder:0.5b") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of the model's capabilities (optional) */
  description?: string;
  /** Model size in bytes (for local models) */
  size?: number;
  /** Context window size in tokens (for local models) */
  contextWindow?: number;
  /** Parameter count string, e.g. "30.5B" (for local models) */
  parameterSize?: string;
  /** Base model this preset was derived from, e.g. "qwen3-coder:30b" */
  parentModel?: string;
  /** Quantization level, e.g. "Q4_K_M" */
  quantizationLevel?: string;
  /** Provider-reported default marker, when available. */
  isDefault?: boolean;
  /** Provider-reported default reasoning effort, when available. */
  defaultReasoningEffort?: string;
  /** Provider-reported supported reasoning efforts, when available. */
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string;
    description?: string;
  }>;
  /** Whether this model supports named effort levels, when available. */
  supportsEffort?: boolean;
  /** Provider-reported supported effort levels, when available. */
  supportedEffortLevels?: EffortLevel[];
  /** Provider-reported default effort level, when available. */
  defaultEffortLevel?: EffortLevel;
  /** Whether this model supports adaptive thinking, when available. */
  supportsAdaptiveThinking?: boolean;
  /** Whether this model supports provider fast mode, when available. */
  supportsFastMode?: boolean;
  /** Whether this model supports provider auto mode, when available. */
  supportsAutoMode?: boolean;
  /** Provider-reported input modalities, e.g. text/image. */
  inputModalities?: string[];
  /** Provider-reported personality support. */
  supportsPersonality?: boolean;
  /** Provider-reported opt-in service tiers, e.g. faster paid processing. */
  serviceTiers?: ModelServiceTier[];
}

export interface ModelServiceTier {
  /** Provider-visible service tier id to send for this model. */
  id: string;
  /** Human-readable tier name. */
  name: string;
  /** Provider-reported description, often including speed/cost trade-off. */
  description?: string;
}

/**
 * Provider-level image sizing guidance for client-side rescaling before upload.
 * These are model-input recommendations, not archival display sizes; keep an
 * original/full-resolution path if the session should preserve readable history.
 */
export interface ProviderImageSizing {
  /** Default long-edge target to use for ordinary attachments. */
  defaultLongEdgePx: number;
  /** Upper bound that still tends to be useful before provider-side downscale. */
  maxUsefulLongEdgePx: number;
  /** Optional note about model-family caveats or detail behavior. */
  note?: string;
}

export const RECAP_MODES = ["off", "native", "side-session"] as const;
export type RecapMode = (typeof RECAP_MODES)[number];

export const PROMPT_SUGGESTION_MODES = ["off", "native"] as const;
export type PromptSuggestionMode = (typeof PROMPT_SUGGESTION_MODES)[number];

export const HELPER_SIDE_MODEL_SAME_AS_MAIN = "same-as-main" as const;
export const HELPER_SIDE_MODEL_CHEAPEST = "cheapest" as const;
export const HELPER_SIDE_MODEL_TARGET_PREFIX = "helper-target:" as const;

export interface HelperTargetConfig {
  /** Stable local id used in helperSideModel values. */
  id: string;
  /** User-facing label shown in helper model selectors. */
  name: string;
  /** API family for this helper target. */
  kind: "openai-compatible";
  /** Base URL for the OpenAI-compatible API, e.g. http://localhost:8001/v1. */
  baseUrl: string;
  /** Optional served model id; blank means use the endpoint default if supported. */
  model?: string;
}

/**
 * Slash command (skill) available in a session.
 */
export interface GrokSlashCommandDetails {
  /** Whether Grok reported this as a built-in command or a skill-backed command. */
  source: "builtin" | "skill";
  /** Grok skill scope, when reported. */
  scope?: string;
  /** Grok skill definition path, when reported. */
  path?: string;
}

export interface SlashCommandProviderDetails {
  grok?: GrokSlashCommandDetails;
  [provider: string]: unknown;
}

export interface SlashCommandEmulation {
  /** Provider-visible command template YA sends for this advertised command. */
  providerText: string;
}

export interface SlashCommand {
  /** Command name without leading slash (e.g., "commit", "review-pr") */
  name: string;
  /** Description of what the command does */
  description: string;
  /** Hint for command arguments (e.g., "<file>") */
  argumentHint?: string;
  /** YA-owned fallback behavior for a command the provider does not expose. */
  emulation?: SlashCommandEmulation;
  /** Optional provider-specific provenance or capability detail. */
  providerDetails?: SlashCommandProviderDetails;
}

/**
 * Provider info for UI display.
 */
export interface ProviderInfo {
  name: ProviderName;
  displayName: string;
  installed: boolean;
  authenticated: boolean;
  enabled: boolean;
  expiresAt?: string;
  user?: { email?: string; name?: string };
  /** Available models for this provider */
  models?: ModelInfo[];
  /** Long-edge image sizing guidance for client-side attachment rescaling. */
  imageSizing?: ProviderImageSizing;
  /** Whether this provider supports permission modes (default: true for backward compat) */
  supportsPermissionMode?: boolean;
  /** Whether this provider supports extended thinking toggle (default: true for backward compat) */
  supportsThinkingToggle?: boolean;
  /** Whether this provider supports slash commands (default: false) */
  supportsSlashCommands?: boolean;
  /** Whether this provider supports active turn steering (default: false) */
  supportsSteering?: boolean;
  /**
   * Whether steering can additionally interrupt in-flight generation
   * (Claude `priority: "now"`). Default: false.
   */
  supportsSteerNow?: boolean;
  /** Whether this provider can generate YA-triggered recap messages. */
  supportsRecaps?: boolean;
  /** Whether this provider emits recaps natively without a YA side query. */
  supportsNativeRecaps?: boolean;
  /** Whether this provider emits prompt suggestions in its ordinary protocol. */
  supportsNativePromptSuggestions?: boolean;
}

/**
 * Permission mode for tool approvals.
 * - "default": Auto-approve read-only tools (Read, Glob, Grep, etc.), ask for mutating tools
 * - "acceptEdits": Auto-approve file editing tools (Edit, Write, NotebookEdit), ask for others
 * - "plan": Auto-approve read-only tools, ask for others (planning/analysis mode)
 * - "auto": Use provider classifier to approve or deny permission prompts
 * - "bypassPermissions": Auto-approve all tools (full autonomous mode)
 */
export type PermissionMode =
  | "default"
  | "bypassPermissions"
  | "acceptEdits"
  | "plan"
  | "auto";

/**
 * All permission modes in canonical order.
 * Used for validation, dropdowns, and iteration.
 * Keep in sync with PermissionMode above.
 */
export const ALL_PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "auto",
] as const;

/**
 * Saved defaults for the new session form.
 */
export interface NewSessionDefaults {
  provider?: ProviderName;
  model?: string;
  /** Provider-visible service tier. undefined means provider/default behavior. */
  serviceTier?: string;
  permissionMode?: PermissionMode;
  recapMode?: RecapMode;
  promptSuggestionMode?: PromptSuggestionMode;
  /** Provider-mapped helper side model or helper-target:<id>. */
  helperSideModel?: string;
}

export interface SpeechSmartTurnClientDefault {
  enabled: boolean;
  threshold: number;
  timeoutMs: number;
}

export interface GrokSpeechAudioClientDefault {
  uplinkMode: "pcm16" | "browser-compressed";
}

export interface SpeechClientDefaults {
  voiceInputEnabled?: boolean;
  speechMethod?: string;
  speechSmartTurnSettings?: SpeechSmartTurnClientDefault;
  grokSpeechAudioSettings?: GrokSpeechAudioClientDefault;
}

export interface SessionToolbarVisibilityClientDefaults {
  modeSelector?: boolean;
  attachments?: boolean;
  slashMenu?: boolean;
  thinkingToggle?: boolean;
  renderMode?: boolean;
  microphone?: boolean;
  shortcutsHelp?: boolean;
  contextUsage?: boolean;
  btw?: boolean;
  nudge?: boolean;
  queueControls?: boolean;
  sessionStatus?: boolean;
}

export interface ClientDefaults {
  /** Defaults used by browser clients when local storage has no explicit value. */
  speech?: SpeechClientDefaults;
  /** Session toolbar visibility defaults for controls with no local override. */
  sessionToolbarVisibility?: SessionToolbarVisibilityClientDefaults;
}

/**
 * Model option for Claude sessions.
 * - "default": Use the CLI's default model
 * - "best": Use Claude Code's best available model alias
 * - "fable": Claude Fable alias
 * - "sonnet": Claude Sonnet
 * - "sonnet[1m]": Claude Sonnet with 1M context when available
 * - "opus": Claude Opus alias
 * - "opus[1m]": Claude Opus with 1M context when available
 * - "haiku": Claude Haiku
 * - "opusplan": Plan with Opus, execute with Sonnet
 */
export type ModelOption =
  | "default"
  | "best"
  | "fable"
  | "sonnet"
  | "sonnet[1m]"
  | "opus"
  | "opus[1m]"
  | "haiku"
  | "opusplan";

/**
 * The logical default selection token.
 */
export const DEFAULT_MODEL: ModelOption = "default";

/**
 * Resolve a saved model option to the explicit value sent to Claude Code.
 * Returning undefined means "use Claude Code's saved default for new sessions".
 */
export function resolveModel(
  model: ModelOption | undefined,
): string | undefined {
  return model === "default" || !model ? undefined : model;
}

/**
 * Effort level for provider response quality/reasoning depth.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Thinking mode for the 3-way toggle.
 * - "off": Thinking disabled
 * - "auto": Model decides when to think (adaptive)
 * - "on": Always think (forced)
 */
export type ThinkingMode = "off" | "auto" | "on";

/**
 * Thinking + effort option sent from client to server.
 * Wire format (backward compatible):
 * - "off": Thinking disabled
 * - "auto": Adaptive thinking, no effort override
 * - "on:low" | "on:medium" | "on:high" | "on:xhigh" | "on:max": Forced-on thinking at effort level
 * - EffortLevel (plain): Adaptive thinking with effort (backward compat with old clients)
 */
export type ThinkingOption = "off" | "auto" | `on:${EffortLevel}` | EffortLevel;

/**
 * Whether the model is asked to return summarized thinking text.
 * - "summarized": emit a human-readable reasoning summary (Opus 4.7/4.8).
 * - "omitted" (default when unset): redacted thinking, no summary text.
 */
export type ThinkingDisplay = "summarized" | "omitted";

/**
 * User-facing "Show thinking" preference. Provider-agnostic: drives the
 * client render gate (default show/hide of thought blocks) for every
 * provider, and the request side (summarized thinking) where the provider
 * supports an explicit request.
 * - "default": provider-native behavior (least disruptive).
 * - "on": show thoughts; request summaries where supported.
 * - "off": hide thoughts; suppress the request where supported.
 */
export type ShowThinking = "default" | "on" | "off";

/**
 * Thinking configuration for the SDK.
 */
export type ThinkingConfig =
  | { type: "adaptive"; display?: ThinkingDisplay }
  | { type: "enabled"; budgetTokens?: number; display?: ThinkingDisplay }
  | { type: "disabled" };

/**
 * Convert thinking option to SDK thinking config + effort level.
 * On Opus 4.6+, "enabled" type is for older models and crashes the CLI.
 * Instead, "on" mode uses adaptive + explicit effort level.
 *
 * `showThinking` is the request-side mapping of the user preference: "on"
 * asks the model to return summarized thinking text (`display:
 * 'summarized'`), "off" explicitly omits it, and "default" leaves the
 * provider-native behavior (no `display` field). Only meaningful for
 * adaptive thinking; ignored when thinking is disabled.
 */
export function thinkingOptionToConfig(
  option: ThinkingOption,
  showThinking: ShowThinking = "default",
): {
  thinking: ThinkingConfig;
  effort?: EffortLevel;
} {
  if (option === "off") {
    return { thinking: { type: "disabled" } };
  }
  const display: ThinkingDisplay | undefined =
    showThinking === "on"
      ? "summarized"
      : showThinking === "off"
        ? "omitted"
        : undefined;
  const adaptiveThinking = (): ThinkingConfig =>
    display === undefined
      ? { type: "adaptive" }
      : { type: "adaptive", display };
  if (option === "auto") {
    return { thinking: adaptiveThinking() };
  }
  // "on:high" etc. = adaptive thinking with explicit effort level
  if (option.startsWith("on:")) {
    const effort = option.slice(3) as EffortLevel;
    return { thinking: adaptiveThinking(), effort };
  }
  // Plain EffortLevel = adaptive + effort (backward compat with old clients)
  return {
    thinking: adaptiveThinking(),
    effort: option as EffortLevel,
  };
}

/**
 * Session ownership - who controls the session.
 * - "none": No active process
 * - "self": Process is running and owned by this server
 * - "external": Session is being controlled by an external program
 */
export type SessionOwnership =
  | { owner: "none" }
  | {
      owner: "self";
      processId: string;
      permissionMode?: PermissionMode;
      modeVersion?: number;
    }
  | { owner: "external" };

/**
 * Metadata about a file in a project.
 */
export interface FileMetadata {
  /** File path relative to project root */
  path: string;
  /** File size in bytes */
  size: number;
  /** MIME type (e.g., "text/typescript", "image/png") */
  mimeType: string;
  /** Whether the file is a text file (can be displayed inline) */
  isText: boolean;
}

/**
 * Response from the file content API.
 */
export interface FileContentResponse {
  /** File metadata */
  metadata: FileMetadata;
  /** File content (only for text files under size limit) */
  content?: string;
  /** 1-indexed line number for the first returned content line. Defaults to 1. */
  contentStartLine?: number;
  /** 1-indexed line number for the last returned content line. */
  contentEndLine?: number;
  /** Total line count when known for a partial text response. */
  contentTotalLines?: number;
  /** Whether content is a bounded window rather than the complete file. */
  contentTruncated?: boolean;
  /** URL to fetch raw file content */
  rawUrl: string;
  /**
   * Optional media blobs embedded with this response, keyed by renderer path
   * and/or project-relative path. Markdown viewers use this to hydrate rendered
   * images without opening a separate fetch/relay connection for each image.
   */
  embeddedMedia?: Record<string, { data: string; mimeType: string }>;
  /** Syntax-highlighted HTML (when highlight=true and language is supported) */
  highlightedHtml?: string;
  /** Language used for highlighting */
  highlightedLanguage?: string;
  /** Whether the file was truncated for highlighting */
  highlightedTruncated?: boolean;
  /** Rendered markdown HTML (for .md files when highlight=true) */
  renderedMarkdownHtml?: string;
}

/**
 * A hunk from a unified diff patch.
 * Contains line numbers and the actual diff lines with prefixes.
 */
export interface PatchHunk {
  /** Starting line number in the old file */
  oldStart: number;
  /** Number of lines from old file in this hunk */
  oldLines: number;
  /** Starting line number in the new file */
  newStart: number;
  /** Number of lines in new file in this hunk */
  newLines: number;
  /** Diff lines prefixed with ' ' (context), '-' (removed), or '+' (added) */
  lines: string[];
}

/**
 * Server-computed augment for Edit tool_use blocks.
 * Provides pre-computed structuredPatch and highlighted diff HTML
 * so the client can render consistent unified diffs.
 */
export interface EditAugment {
  /** The tool_use ID this augment is for */
  toolUseId: string;
  /** Augment type discriminator */
  type: "edit";
  /** Computed unified diff with context lines */
  structuredPatch: PatchHunk[];
  /** Syntax-highlighted diff HTML (shiki, CSS variables theme) */
  diffHtml: string;
  /** The file path being edited */
  filePath: string;
}

/**
 * Permission rules for session tool filtering.
 * Patterns like "Bash(curl *)" match tool name + glob against tool input.
 * Evaluation order: deny first, then allow, then fall through to permission mode.
 */
export interface PermissionRules {
  // Patterns to auto-approve (e.g., ["Bash(tsx */browser-cli.ts *)"])
  allow?: string[];
  // Patterns to auto-deny (e.g., ["Bash(curl *)", "Bash(*| bash*)"])
  deny?: string[];
}

/**
 * Pre-rendered markdown augment for text blocks.
 * Contains HTML with syntax highlighting from server.
 */
export interface MarkdownAugment {
  /** Pre-rendered HTML with shiki syntax highlighting */
  html: string;
}
