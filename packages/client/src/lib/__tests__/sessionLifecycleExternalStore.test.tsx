import { act, cleanup, renderHook } from "@testing-library/react";
import type { SessionOwnership, UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockActivityCallback = (event: unknown) => void;

const mockActivityBus = vi.hoisted(() => {
  const listeners = new Map<string, Set<MockActivityCallback>>();
  const on = vi.fn((eventType: string, callback: MockActivityCallback) => {
    let set = listeners.get(eventType);
    if (!set) {
      set = new Set();
      listeners.set(eventType, set);
    }
    set.add(callback);
    return () => {
      set?.delete(callback);
    };
  });

  return {
    listeners,
    on,
    emit(eventType: string, event: unknown) {
      for (const callback of listeners.get(eventType) ?? []) {
        callback(event);
      }
    },
    listenerCount() {
      let count = 0;
      for (const set of listeners.values()) {
        count += set.size;
      }
      return count;
    },
  };
});

vi.mock("../activityBus", () => ({
  activityBus: {
    on: mockActivityBus.on,
  },
}));

import {
  reportSessionLifecycleSnapshot,
  resetSessionLifecycleStoreForTests,
  useAnySessionWorking,
  useSessionActivity,
  useSessionLifecycle,
} from "../sessionLifecycleExternalStore";

const PROJECT_ID = "project-1" as UrlProjectId;
const SELF_OWNER: SessionOwnership = {
  owner: "self",
  processId: "process-1",
};

beforeEach(() => {
  resetSessionLifecycleStoreForTests();
  mockActivityBus.listeners.clear();
  mockActivityBus.on.mockClear();
});

afterEach(() => {
  cleanup();
  resetSessionLifecycleStoreForTests();
  mockActivityBus.listeners.clear();
});

describe("sessionLifecycleExternalStore", () => {
  it("subscribes to activityBus once while hooks are mounted", () => {
    const first = renderHook(() => useAnySessionWorking());
    expect(mockActivityBus.on).toHaveBeenCalledTimes(6);
    expect(mockActivityBus.listenerCount()).toBe(6);

    const second = renderHook(() => useSessionActivity("session-1"));
    expect(mockActivityBus.on).toHaveBeenCalledTimes(6);
    expect(mockActivityBus.listenerCount()).toBe(6);

    first.unmount();
    expect(mockActivityBus.listenerCount()).toBe(6);

    second.unmount();
    expect(mockActivityBus.listenerCount()).toBe(0);
  });

  it("reduces process-state events into session activity hooks", () => {
    const { result } = renderHook(() => useSessionActivity("session-1"));

    expect(result.current).toMatchObject({
      isWorking: false,
      needsInput: false,
    });

    act(() => {
      mockActivityBus.emit("process-state-changed", {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "in-turn",
        timestamp: "2026-05-31T16:30:00.000Z",
      });
    });

    expect(result.current).toMatchObject({
      activity: "in-turn",
      isWorking: true,
      needsInput: false,
    });

    act(() => {
      mockActivityBus.emit("process-state-changed", {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "waiting-input",
        pendingInputType: "tool-approval",
        timestamp: "2026-05-31T16:30:01.000Z",
      });
    });

    expect(result.current).toMatchObject({
      activity: "waiting-input",
      pendingInputType: "tool-approval",
      isWorking: false,
      needsInput: true,
    });

    act(() => {
      mockActivityBus.emit("process-state-changed", {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        activity: "idle",
        timestamp: "2026-05-31T16:30:02.000Z",
      });
    });

    expect(result.current).toMatchObject({
      activity: undefined,
      pendingInputType: undefined,
      isWorking: false,
      needsInput: false,
    });
  });

  it("applies API snapshot reports without requiring activityBus events", () => {
    const { result } = renderHook(() => useAnySessionWorking());

    act(() => {
      reportSessionLifecycleSnapshot(
        {
          sessionId: "session-1",
          projectId: PROJECT_ID,
          ownership: SELF_OWNER,
          activity: "in-turn",
          includesActivity: true,
        },
        100,
      );
    });

    expect(result.current).toBe(true);

    act(() => {
      reportSessionLifecycleSnapshot(
        {
          sessionId: "session-1",
          projectId: PROJECT_ID,
          ownership: SELF_OWNER,
          includesActivity: true,
        },
        200,
      );
    });

    expect(result.current).toBe(false);
  });

  it("seeds and updates lifecycle metadata from activity events", () => {
    const { result } = renderHook(() => useSessionLifecycle("session-1"));

    act(() => {
      mockActivityBus.emit("session-created", {
        type: "session-created",
        session: {
          id: "session-1",
          projectId: PROJECT_ID,
          title: "Started session",
          fullTitle: "Started session",
          createdAt: "2026-05-31T16:30:00.000Z",
          updatedAt: "2026-05-31T16:30:00.000Z",
          messageCount: 0,
          ownership: SELF_OWNER,
          provider: "claude",
          activity: "in-turn",
          hasUnread: true,
        },
        timestamp: "2026-05-31T16:30:00.000Z",
      });
    });

    expect(result.current).toMatchObject({
      sessionId: "session-1",
      projectId: PROJECT_ID,
      title: "Started session",
      ownership: SELF_OWNER,
      activity: "in-turn",
      hasUnread: true,
    });

    act(() => {
      mockActivityBus.emit("session-updated", {
        type: "session-updated",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        title: "Derived title",
        updatedAt: "2026-05-31T16:31:00.000Z",
        timestamp: "2026-05-31T16:31:00.000Z",
      });
    });

    expect(result.current).toMatchObject({
      title: "Derived title",
      updatedAt: "2026-05-31T16:31:00.000Z",
    });

    act(() => {
      mockActivityBus.emit("session-metadata-changed", {
        type: "session-metadata-changed",
        sessionId: "session-1",
        title: "Custom title",
        timestamp: "2026-05-31T16:32:00.000Z",
      });
      mockActivityBus.emit("session-seen", {
        type: "session-seen",
        sessionId: "session-1",
        timestamp: "2026-05-31T16:33:00.000Z",
      });
    });

    expect(result.current).toMatchObject({
      customTitle: "Custom title",
      hasUnread: false,
    });
  });
});
