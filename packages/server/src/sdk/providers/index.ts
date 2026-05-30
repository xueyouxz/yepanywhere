/**
 * Provider exports.
 *
 * Re-exports all provider implementations and types.
 */

// Types
import type { AgentProvider, ProviderName } from "./types.js";
export type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

// Claude provider (uses @anthropic-ai/claude-agent-sdk)
import { claudeProvider } from "./claude.js";
export { ClaudeProvider, claudeProvider } from "./claude.js";

// Codex provider (uses codex CLI)
import { codexProvider } from "./codex.js";
export {
  CodexProvider,
  codexProvider,
  type CodexProviderConfig,
} from "./codex.js";

// Gemini provider (uses gemini CLI)
import { geminiProvider } from "./gemini.js";
export {
  GeminiProvider,
  geminiProvider,
  type GeminiProviderConfig,
} from "./gemini.js";

// Gemini ACP provider (uses gemini CLI with --experimental-acp)
import { geminiACPProvider } from "./gemini-acp.js";
export {
  GeminiACPProvider,
  geminiACPProvider,
  type GeminiACPProviderConfig,
} from "./gemini-acp.js";

// Grok Build ACP provider (uses `grok agent stdio`)
// Phase 1 isolated addition per topics/grok.md. Gated by ENABLED_PROVIDERS=grok.
import { grokACPProvider } from "./grok-acp.js";
export {
  GrokACPProvider,
  grokACPProvider,
  type GrokACPProviderConfig,
} from "./grok-acp.js";

// CodexOSS provider (uses codex CLI with --oss for local models)
import { codexOSSProvider } from "./codex-oss.js";
export {
  CodexOSSProvider,
  codexOSSProvider,
  type CodexOSSProviderConfig,
} from "./codex-oss.js";

// Claude + Ollama provider (uses Claude SDK with Ollama backend)
import { claudeOllamaProvider } from "./claude-ollama.js";
export {
  ClaudeOllamaProvider,
  claudeOllamaProvider,
} from "./claude-ollama.js";

// OpenCode provider (uses opencode serve for multi-provider agent)
import { opencodeProvider } from "./opencode.js";
export {
  OpenCodeProvider,
  opencodeProvider,
  type OpenCodeProviderConfig,
} from "./opencode.js";

/**
 * Get all available provider instances.
 * Useful for provider detection UI.
 */
export function getAllProviders(): AgentProvider[] {
  return [
    claudeProvider,
    claudeOllamaProvider,
    codexProvider,
    codexOSSProvider,
    geminiProvider,
    geminiACPProvider,
    grokACPProvider, // Phase 1: additive only (see grok-acp.ts header + topics/grok.md)
    opencodeProvider,
  ];
}

/**
 * Get a provider by name.
 *
 * Note: "gemini" maps to geminiACPProvider (ACP mode) since it's the better
 * implementation with proper permission handling. The non-ACP stream-json
 * provider is deprecated and will be removed.
 *
 * "grok" added (additive, isolated). When ENABLED_PROVIDERS does not include "grok",
 * getProvider("grok") is never reached from normal flows.
 */
export function getProvider(name: ProviderName): AgentProvider | null {
  switch (name) {
    case "claude":
      return claudeProvider;
    case "claude-ollama":
      return claudeOllamaProvider;
    case "codex":
      return codexProvider;
    case "codex-oss":
      return codexOSSProvider;
    case "gemini":
    case "gemini-acp":
      // Both map to ACP provider - "gemini" is legacy name for backward compatibility
      return geminiACPProvider;
    case "grok":
      return grokACPProvider; // Phase 1 Grok Build (ACP)
    case "opencode":
      return opencodeProvider;
    default:
      return null;
  }
}
