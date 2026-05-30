import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isClientLogCollectionActive: vi.fn(() => true),
  record: vi.fn(),
}));

vi.mock("../index", () => ({
  clientLogCollector: {
    record: mocks.record,
  },
  isClientLogCollectionActive: mocks.isClientLogCollectionActive,
}));

import { logSessionUiTrace } from "../uiTrace";

function parseTraceMessage(message: string): Record<string, unknown> {
  const prefix = "[SessionUITrace] ";
  expect(message.startsWith(prefix)).toBe(true);
  return JSON.parse(message.slice(prefix.length));
}

describe("logSessionUiTrace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    vi.clearAllMocks();
    mocks.isClientLogCollectionActive.mockReturnValue(true);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes internal trace records without retaining them in Chrome console", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    logSessionUiTrace("stream-complete", { sessionId: "session-1" });

    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record.mock.calls[0]?.[0]).toBe("log");
    expect(mocks.record.mock.calls[0]?.[1]).toBe("[SessionUITrace]");
    expect(parseTraceMessage(mocks.record.mock.calls[0]?.[2] as string)).toEqual(
      {
        event: "stream-complete",
        sessionId: "session-1",
      },
    );
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("skips traces when collection is inactive", () => {
    mocks.isClientLogCollectionActive.mockReturnValue(false);

    logSessionUiTrace("stream-complete", { sessionId: "session-1" });

    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("batches token-level stream dispatch traces", () => {
    logSessionUiTrace("session-stream-dispatch", {
      sessionId: "session-1",
      eventType: "message",
      sdkType: "stream_event",
    });
    logSessionUiTrace("session-stream-dispatch", {
      sessionId: "session-1",
      eventType: "message",
      sdkType: "stream_event",
    });
    logSessionUiTrace("session-stream-dispatch", {
      sessionId: "session-1",
      eventType: "message",
      sdkType: "stream_event",
    });

    expect(mocks.record).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);

    expect(mocks.record).toHaveBeenCalledTimes(1);
    const trace = parseTraceMessage(mocks.record.mock.calls[0]?.[2] as string);
    expect(trace).toMatchObject({
      event: "session-ui-trace-batch",
      sessionId: "session-1",
      total: 3,
      counts: {
        "dispatch:message:stream_event": 3,
      },
    });
  });
});
