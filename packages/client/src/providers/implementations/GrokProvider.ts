import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

export class GrokProvider implements Provider {
  readonly id = "grok";
  readonly displayName = "Grok Build";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "xAI Grok Build via Agent Client Protocol. Experimental integration with structured tool and thinking updates.",
    limitations: [
      "Requires the grok CLI to be installed and logged in",
      "Session history replay is currently summary-only",
    ],
    website: "https://docs.x.ai/build",
    cliName: "grok",
  };
}
