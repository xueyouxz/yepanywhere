/**
 * Mock Grok Build provider for testing.
 */

import type { SDKMessage } from "../../types.js";
import type { ProviderName } from "../types.js";
import { BaseMockProvider } from "./base.js";
import type { MockProviderConfig, MockScenario } from "./types.js";

export class MockGrokProvider extends BaseMockProvider {
  readonly name: ProviderName = "grok";
  readonly displayName = "Grok Build (ACP)";

  constructor(config: MockProviderConfig = {}) {
    super(config);
  }
}

export function createGrokScenario(
  sessionId: string,
  assistantResponse: string,
  options: { delayMs?: number; includeThoughts?: boolean } = {},
): MockScenario {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "grok-build",
    },
  ];

  if (options.includeThoughts) {
    messages.push({
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Planning the Grok Build response...",
          },
        ],
      },
    });
  }

  messages.push(
    {
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: assistantResponse,
      },
    },
    {
      type: "result",
      session_id: sessionId,
    },
  );

  return {
    messages,
    delayMs: options.delayMs ?? 10,
    sessionId,
  };
}
