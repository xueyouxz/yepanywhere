import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Controllable fake activityBus: on() registers handlers, emit() fires them.
const busMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<() => void>>();
  return {
    on: vi.fn((event: string, handler: () => void) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => handlers.get(event)?.delete(handler);
    }),
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
    reset() {
      handlers.clear();
    },
  };
});

vi.mock("../../lib/activityBus", () => ({
  activityBus: { on: busMock.on },
}));

import { useBackgroundRevalidation } from "../useBackgroundRevalidation";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  busMock.reset();
  busMock.on.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Fire an activity event and let the async trigger settle under fake timers. */
async function emitAndSettle(event: string) {
  await act(async () => {
    busMock.emit(event);
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useBackgroundRevalidation", () => {
  it("does not revalidate within the debounce window", async () => {
    const fetcher = vi.fn().mockResolvedValue([2]);
    const apply = vi.fn();
    renderHook(() =>
      useBackgroundRevalidation({
        fetcher,
        current: [1],
        apply,
        minIntervalMs: 1000,
      }),
    );

    // Mount counts as a fresh load, so an immediate reconnect is debounced.
    await emitAndSettle("reconnect");

    expect(fetcher).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("revalidates and applies changed data after the debounce window", async () => {
    const fetcher = vi.fn().mockResolvedValue([2]);
    const apply = vi.fn();
    renderHook(() =>
      useBackgroundRevalidation({
        fetcher,
        current: [1],
        apply,
        minIntervalMs: 1000,
      }),
    );

    await vi.advanceTimersByTimeAsync(2000);
    await emitAndSettle("reconnect");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith([2]);
  });

  it("does not apply when the fetched data is unchanged", async () => {
    const fetcher = vi.fn().mockResolvedValue([1]);
    const apply = vi.fn();
    renderHook(() =>
      useBackgroundRevalidation({
        fetcher,
        current: [1],
        apply,
        minIntervalMs: 1000,
      }),
    );

    await vi.advanceTimersByTimeAsync(2000);
    await emitAndSettle("reconnect");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it("stays quiet when the fetch fails", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    const apply = vi.fn();
    renderHook(() =>
      useBackgroundRevalidation({
        fetcher,
        current: [1],
        apply,
        minIntervalMs: 1000,
      }),
    );

    await vi.advanceTimersByTimeAsync(2000);
    await emitAndSettle("reconnect");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it("also revalidates on a refresh (visibility) event", async () => {
    const fetcher = vi.fn().mockResolvedValue([2]);
    const apply = vi.fn();
    renderHook(() =>
      useBackgroundRevalidation({
        fetcher,
        current: [1],
        apply,
        minIntervalMs: 1000,
      }),
    );

    await vi.advanceTimersByTimeAsync(2000);
    await emitAndSettle("refresh");

    expect(apply).toHaveBeenCalledWith([2]);
  });

  it("fetches once for a near-simultaneous reconnect + refresh", async () => {
    const fetcher = vi.fn().mockResolvedValue([2]);
    const apply = vi.fn();
    renderHook(() =>
      useBackgroundRevalidation({
        fetcher,
        current: [1],
        apply,
        minIntervalMs: 1000,
      }),
    );

    await vi.advanceTimersByTimeAsync(2000);
    await act(async () => {
      busMock.emit("reconnect");
      busMock.emit("refresh");
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe when disabled", () => {
    const fetcher = vi.fn();
    renderHook(() =>
      useBackgroundRevalidation({
        fetcher,
        current: [1],
        apply: vi.fn(),
        enabled: false,
      }),
    );

    expect(busMock.on).not.toHaveBeenCalled();
  });
});
