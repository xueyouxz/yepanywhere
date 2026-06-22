import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  hasEquivalentJsonlMessage,
  reconcileLinearMessages,
} from "../linearMessageDedup";

describe("hasEquivalentJsonlMessage", () => {
  it("requires matching content and close timestamps", () => {
    const existing: Message[] = [
      {
        uuid: "jsonl-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.900Z",
        _source: "jsonl",
        message: { role: "assistant", content: "Done." },
      },
    ];

    expect(
      hasEquivalentJsonlMessage(existing, {
        uuid: "sdk-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:01.200Z",
        _source: "sdk",
        message: { role: "assistant", content: "Done." },
      }),
    ).toBe(true);

    expect(
      hasEquivalentJsonlMessage(existing, {
        uuid: "sdk-2",
        type: "assistant",
        timestamp: "2026-03-09T10:00:10.200Z",
        _source: "sdk",
        message: { role: "assistant", content: "Done." },
      }),
    ).toBe(false);
  });

  it("uses the same tightened window for replay (no wide reconnect window)", () => {
    const existing: Message[] = [
      {
        uuid: "jsonl-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "jsonl",
        message: {
          role: "assistant",
          content:
            "There's one small TypeScript widening issue in the new helper.",
        },
      },
    ];

    // Within the tight window: a replay copy still matches its persisted row.
    expect(
      hasEquivalentJsonlMessage(existing, {
        uuid: "sdk-replay-near",
        type: "assistant",
        timestamp: "2026-03-09T10:00:01.500Z",
        _source: "sdk",
        isReplay: true,
        message: {
          role: "assistant",
          content:
            "There's one small TypeScript widening issue in the new helper.",
        },
      }),
    ).toBe(true);

    // Beyond it: no longer matched on content alone. The old 90s window risked
    // false-merging two genuinely distinct identical messages; deterministic id
    // matching now covers wide reconnect gaps instead.
    expect(
      hasEquivalentJsonlMessage(existing, {
        uuid: "sdk-replay-far",
        type: "assistant",
        timestamp: "2026-03-09T10:00:45.000Z",
        _source: "sdk",
        isReplay: true,
        message: {
          role: "assistant",
          content:
            "There's one small TypeScript widening issue in the new helper.",
        },
      }),
    ).toBe(false);
  });
});

describe("reconcileLinearMessages", () => {
  it("merges sdk/jsonl duplicates and prefers jsonl", () => {
    const messages: Message[] = [
      {
        uuid: "sdk-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.500Z",
        _source: "sdk",
        message: { role: "assistant", content: "Committed." },
      },
      {
        uuid: "jsonl-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.800Z",
        _source: "jsonl",
        message: { role: "assistant", content: "Committed." },
      },
    ];

    const result = reconcileLinearMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]?._source).toBe("jsonl");
    expect(result[0]?.uuid).toBe("jsonl-1");
    expect(result[0]?.timestamp).toBe("2026-03-09T10:00:00.800Z");
  });

  it("excludes tool messages from the backstop when excludeTools is set", () => {
    const toolPair = (source: "sdk" | "jsonl", uuid: string, ms: string) => ({
      uuid,
      type: "assistant" as const,
      timestamp: `2026-03-09T10:00:0${ms}Z`,
      _source: source,
      message: {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use",
            id: "call-x",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    });
    const messages: Message[] = [
      toolPair("sdk", "sdk-tool", "0.000"),
      toolPair("jsonl", "jsonl-tool", "0.300"),
      {
        uuid: "sdk-text",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "sdk",
        message: { role: "assistant", content: "Done." },
      },
      {
        uuid: "jsonl-text",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.300Z",
        _source: "jsonl",
        message: { role: "assistant", content: "Done." },
      },
    ];

    // Default: backstop merges both the tool and text duplicates.
    expect(reconcileLinearMessages(messages)).toHaveLength(2);

    // excludeTools: tool duplicates are kept (they dedup by id upstream),
    // text duplicates still merge.
    const excluded = reconcileLinearMessages(messages, { excludeTools: true });
    const toolUses = excluded.filter((m) =>
      Array.isArray((m.message as { content?: unknown })?.content),
    );
    const texts = excluded.filter(
      (m) => typeof (m.message as { content?: unknown })?.content === "string",
    );
    expect(toolUses).toHaveLength(2);
    expect(texts).toHaveLength(1);
  });

  it("orders messages by timestamp for Codex's linear history", () => {
    const messages: Message[] = [
      {
        uuid: "late",
        type: "assistant",
        timestamp: "2026-03-09T10:00:03.000Z",
        _source: "sdk",
        message: { role: "assistant", content: "Third" },
      },
      {
        uuid: "early",
        type: "user",
        timestamp: "2026-03-09T10:00:01.000Z",
        _source: "jsonl",
        message: { role: "user", content: "First" },
      },
      {
        uuid: "middle",
        type: "assistant",
        timestamp: "2026-03-09T10:00:02.000Z",
        _source: "jsonl",
        message: { role: "assistant", content: "Second" },
      },
    ];

    const result = reconcileLinearMessages(messages);

    expect(result.map((message) => message.uuid)).toEqual([
      "early",
      "middle",
      "late",
    ]);
  });

  it("keeps repeated same-text messages when they are far apart", () => {
    const messages: Message[] = [
      {
        uuid: "sdk-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "sdk",
        message: { role: "assistant", content: "Done." },
      },
      {
        uuid: "jsonl-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:09.000Z",
        _source: "jsonl",
        message: { role: "assistant", content: "Done." },
      },
    ];

    const result = reconcileLinearMessages(messages);

    expect(result).toHaveLength(2);
  });

  it("dedupes exact same-source repeats from live stream replay", () => {
    const messages: Message[] = [
      {
        uuid: "sdk-1",
        type: "user",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "sdk",
        message: { role: "user", content: "Test this." },
      },
      {
        uuid: "sdk-2",
        type: "user",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "sdk",
        message: { role: "user", content: "Test this." },
      },
    ];

    const result = reconcileLinearMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]?.uuid).toBe("sdk-2");
  });

  it("keeps same-source repeated text with distinct timestamps", () => {
    const messages: Message[] = [
      {
        uuid: "sdk-1",
        type: "user",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "sdk",
        message: { role: "user", content: "now" },
      },
      {
        uuid: "sdk-2",
        type: "user",
        timestamp: "2026-03-09T10:00:01.000Z",
        _source: "sdk",
        message: { role: "user", content: "now" },
      },
    ];

    const result = reconcileLinearMessages(messages);

    expect(result).toHaveLength(2);
  });

  it("merges replay/jsonl duplicates within the tightened window", () => {
    const messages: Message[] = [
      {
        uuid: "sdk-replay-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "sdk",
        isReplay: true,
        message: {
          role: "assistant",
          content:
            "There's one small TypeScript widening issue in the new helper.",
        },
      },
      {
        uuid: "jsonl-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:01.000Z",
        _source: "jsonl",
        message: {
          role: "assistant",
          content:
            "There's one small TypeScript widening issue in the new helper.",
        },
      },
    ];

    const result = reconcileLinearMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]?._source).toBe("jsonl");
    expect(result[0]?.uuid).toBe("jsonl-1");
  });

  it("does not merge content-identical messages beyond the tightened window", () => {
    const messages: Message[] = [
      {
        uuid: "sdk-replay-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "sdk",
        isReplay: true,
        message: {
          role: "assistant",
          content:
            "There's one small TypeScript widening issue in the new helper.",
        },
      },
      {
        uuid: "jsonl-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:45.000Z",
        _source: "jsonl",
        message: {
          role: "assistant",
          content:
            "There's one small TypeScript widening issue in the new helper.",
        },
      },
    ];

    const result = reconcileLinearMessages(messages);

    expect(result).toHaveLength(2);
  });
});
