import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

export class PiProvider implements Provider {
  readonly id = "pi";
  readonly displayName = "pi";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
    // pi's live stream echoes the user turn under YA's queue message.uuid, while
    // the durable PiSessionReader copy carries pi's own JSONL node id — they
    // never match, so by-id dedup leaves the initial turn double-rendered. Same
    // shape as OpenCode's user echo; rely on the content+timestamp backstop
    // until deterministic id alignment lands. See topics/stream-durable-id-dedup.md.
    needsApproxMessageDedup: true,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Mario Zechner's provider-agnostic coding agent, driven headless via `pi --mode rpc`. Bring-your-own keys across many model providers.",
    limitations: [
      "Requires the pi CLI to be installed",
      "Live streaming only — session reload/list (PiSessionReader) not wired yet",
      "Tools run autonomously — YA permission-mode approval bridge not wired yet",
    ],
    website: "https://github.com/earendil-works/pi",
    cliName: "pi",
  };
}
