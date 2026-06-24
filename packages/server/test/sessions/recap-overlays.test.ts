import type { DurableRecapMessage } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  applyRecapOverlayToSummary,
  mergeRecapMessages,
} from "../../src/sessions/recap-overlays.js";
import type { Message, SessionSummary } from "../../src/supervisor/types.js";

function recap(
  overrides: Partial<DurableRecapMessage> & {
    uuid: string;
    content: string;
  },
): DurableRecapMessage {
  return {
    type: "system",
    subtype: "away_summary",
    timestamp: "2026-06-24T12:00:00.000Z",
    id: overrides.uuid,
    yaRecapSource: "ya-synthetic",
    ...overrides,
  };
}

function providerMessage(
  overrides: Partial<Message> & { uuid: string },
): Message {
  return {
    type: "assistant",
    timestamp: "2026-06-24T12:00:00.000Z",
    message: { role: "assistant", content: "assistant text" },
    ...overrides,
  };
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as SessionSummary["projectId"],
    title: "Session",
    fullTitle: "Session",
    createdAt: "2026-06-24T11:00:00.000Z",
    updatedAt: "2026-06-24T12:00:00.000Z",
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "claude",
    ...overrides,
  };
}

describe("recap overlays", () => {
  it("renders same-content persisted recaps within the duplicate window once", () => {
    const merged = mergeRecapMessages(
      [],
      [
        recap({
          uuid: "recap-1",
          content: "Finished the cleanup.",
          timestamp: "2026-06-24T12:00:00.000Z",
        }),
        recap({
          uuid: "recap-2",
          content: "Finished the cleanup.",
          timestamp: "2026-06-24T12:00:04.000Z",
        }),
      ],
    );

    expect(merged.map((message) => message.uuid)).toEqual(["recap-1"]);
  });

  it("dedupes persisted recaps with the same UUID", () => {
    const merged = mergeRecapMessages(
      [],
      [
        recap({
          uuid: "recap-1",
          content: "First copy.",
          timestamp: "2026-06-24T12:00:00.000Z",
        }),
        recap({
          uuid: "recap-1",
          content: "Second copy.",
          timestamp: "2026-06-24T12:00:10.000Z",
        }),
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.uuid).toBe("recap-1");
  });

  it("suppresses durable overlays equivalent to provider away summaries", () => {
    const merged = mergeRecapMessages(
      [
        providerMessage({
          uuid: "native-recap",
          type: "system",
          subtype: "away_summary",
          content: "Native recap wins.",
          timestamp: "2026-06-24T12:00:00.000Z",
        }),
      ],
      [
        recap({
          uuid: "overlay-recap",
          content: "Native recap wins.",
          timestamp: "2026-06-24T12:00:03.000Z",
        }),
      ],
    );

    expect(merged.map((message) => message.uuid)).toEqual(["native-recap"]);
  });

  it("appends invalid-timestamp recaps without crashing", () => {
    const merged = mergeRecapMessages(
      [
        providerMessage({
          uuid: "provider-1",
          timestamp: "2026-06-24T12:00:30.000Z",
        }),
      ],
      [
        recap({
          uuid: "recap-invalid",
          content: "Timestamp was missing.",
          timestamp: null as unknown as string,
        }),
      ],
    );

    expect(merged.map((message) => message.uuid)).toEqual([
      "provider-1",
      "recap-invalid",
    ]);
  });

  it("inserts timestamped recaps before later provider messages", () => {
    const merged = mergeRecapMessages(
      [
        providerMessage({
          uuid: "provider-later",
          timestamp: "2026-06-24T12:00:30.000Z",
        }),
      ],
      [
        recap({
          uuid: "recap-earlier",
          content: "Earlier recap.",
          timestamp: "2026-06-24T12:00:10.000Z",
        }),
      ],
    );

    expect(merged.map((message) => message.uuid)).toEqual([
      "recap-earlier",
      "provider-later",
    ]);
  });

  it("updates summary freshness and excerpt only for fresher valid recaps", () => {
    const base = summary({
      updatedAt: "2026-06-24T12:00:00.000Z",
      lastAgentText: "Provider ending.",
    });

    expect(
      applyRecapOverlayToSummary(base, [
        recap({
          uuid: "old-recap",
          content: "Older recap.",
          timestamp: "2026-06-24T11:59:00.000Z",
        }),
      ]),
    ).toBe(base);

    expect(
      applyRecapOverlayToSummary(base, [
        recap({
          uuid: "invalid-recap",
          content: "Invalid recap.",
          timestamp: "not-a-date",
        }),
      ]),
    ).toBe(base);

    expect(
      applyRecapOverlayToSummary(base, [
        recap({
          uuid: "fresh-recap",
          content: "Fresh recap. (disable recaps in /config)",
          timestamp: "2026-06-24T12:01:00.000Z",
        }),
      ]),
    ).toMatchObject({
      updatedAt: "2026-06-24T12:01:00.000Z",
      lastAgentText: "Fresh recap.",
    });
  });
});
