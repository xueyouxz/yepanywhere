import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

export class OpenCodeProvider implements Provider {
  readonly id = "opencode";
  readonly displayName = "OpenCode";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
    needsApproxMessageDedup: true,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Multi-provider agent with tool streaming via SSE. Supports various LLM backends.",
    limitations: [
      "Tool approval flow still under investigation",
      "Transcript rendering WIP: 22/48 sampled export parts map to visible blocks",
      "Experimental integration",
    ],
    website: "https://opencode.ai",
    cliName: "opencode",
  };
}
