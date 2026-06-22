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
    needsApproxMessageDedup: false,
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
