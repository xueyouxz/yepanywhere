import { describe, expect, it } from "vitest";
import {
  getRecallSubmissionAfterQueuedCancel,
  type LastComposerSubmission,
  type SentComposerSubmission,
} from "../composerRecall";

describe("getRecallSubmissionAfterQueuedCancel", () => {
  const lastSent: SentComposerSubmission = {
    kind: "sent",
    text: "real previous turn",
    id: "sent-1",
  };

  it("falls back to the previous sent turn after the remembered queued item is cancelled", () => {
    const current: LastComposerSubmission = {
      kind: "queued",
      text: "cancel me",
      tempId: "temp-2",
    };

    expect(
      getRecallSubmissionAfterQueuedCancel(current, lastSent, [], "temp-2"),
    ).toEqual(lastSent);
  });

  it("retargets to the newest remaining queued item", () => {
    const current: LastComposerSubmission = {
      kind: "queued",
      text: "third",
      tempId: "temp-3",
    };

    expect(
      getRecallSubmissionAfterQueuedCancel(
        current,
        lastSent,
        [
          {
            tempId: "temp-1",
            content: "first",
            timestamp: "2026-04-25T00:00:00.000Z",
          },
          {
            tempId: "temp-2",
            content: "second",
            timestamp: "2026-04-25T00:00:01.000Z",
          },
          {
            tempId: "temp-3",
            content: "third",
            timestamp: "2026-04-25T00:00:02.000Z",
          },
        ],
        "temp-3",
      ),
    ).toEqual({ kind: "queued", text: "second", tempId: "temp-2" });
  });

  it("does not disturb recall when cancelling a different queued item", () => {
    const current: LastComposerSubmission = {
      kind: "queued",
      text: "second",
      tempId: "temp-2",
    };

    expect(
      getRecallSubmissionAfterQueuedCancel(current, lastSent, [], "temp-1"),
    ).toEqual(current);
  });
});
