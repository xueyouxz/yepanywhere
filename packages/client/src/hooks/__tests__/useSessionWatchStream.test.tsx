// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionWatchStream } from "../useSessionWatchStream";

const connectionMocks = vi.hoisted(() => ({
  handlers: [] as Array<{
    onOpen?: () => void;
    onClose?: () => void;
    onError?: (err: Error) => void;
    onEvent: (
      eventType: string,
      eventId: string | undefined,
      data: unknown,
    ) => void;
  }>,
  stateListeners: [] as Array<(state: string) => void>,
  subscriptions: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  subscribeSessionWatch: vi.fn(),
}));

vi.mock("../../lib/connection", () => ({
  connectionManager: {
    handleError: vi.fn(),
    markConnected: vi.fn(),
    on: vi.fn((_event: string, listener: (state: string) => void) => {
      connectionMocks.stateListeners.push(listener);
      return vi.fn();
    }),
    recordEvent: vi.fn(),
    recordHeartbeat: vi.fn(),
  },
  getGlobalConnection: vi.fn(() => null),
  getWebSocketConnection: vi.fn(() => ({
    subscribeSessionWatch: connectionMocks.subscribeSessionWatch,
  })),
  isNonRetryableError: vi.fn(() => false),
}));

beforeEach(() => {
  connectionMocks.handlers = [];
  connectionMocks.stateListeners = [];
  connectionMocks.subscriptions = [];
  connectionMocks.subscribeSessionWatch.mockImplementation(
    (_sessionId, handlers) => {
      connectionMocks.handlers.push(handlers);
      const subscription = { close: vi.fn() };
      connectionMocks.subscriptions.push(subscription);
      return subscription;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSessionWatchStream", () => {
  it("does not resubscribe for a new target object with the same values", () => {
    const { rerender, unmount } = renderHook(
      ({ target }) =>
        useSessionWatchStream(target, {
          onChange: vi.fn(),
        }),
      {
        initialProps: {
          target: {
            projectId: "project-1",
            provider: "claude",
            sessionId: "session-1",
          },
        },
      },
    );

    expect(connectionMocks.subscribeSessionWatch).toHaveBeenCalledTimes(1);
    expect(connectionMocks.subscriptions).toHaveLength(1);

    rerender({
      target: {
        projectId: "project-1",
        provider: "claude",
        sessionId: "session-1",
      },
    });

    expect(connectionMocks.subscribeSessionWatch).toHaveBeenCalledTimes(1);
    expect(connectionMocks.subscriptions[0]?.close).not.toHaveBeenCalled();

    rerender({
      target: {
        projectId: "project-1",
        provider: "codex",
        sessionId: "session-1",
      },
    });

    expect(connectionMocks.subscribeSessionWatch).toHaveBeenCalledTimes(2);
    expect(connectionMocks.subscriptions[0]?.close).toHaveBeenCalledTimes(1);

    unmount();

    expect(connectionMocks.subscriptions[1]?.close).toHaveBeenCalledTimes(1);
  });
});
