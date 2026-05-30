// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collector: {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
  },
  developerModeListeners: new Set<() => void>(),
  getRemoteLogCollectionEnabled: vi.fn(() => false),
  getServerSettings: vi.fn(() =>
    Promise.resolve({
      settings: {
        serviceWorkerEnabled: true,
        persistRemoteSessionsToDisk: false,
        clientLogCollectionRequested: false,
      },
    }),
  ),
}));

vi.mock("../../../api/client", () => ({
  api: {
    getServerSettings: mocks.getServerSettings,
  },
}));

vi.mock("../../../hooks/useDeveloperMode", () => ({
  getRemoteLogCollectionEnabled: mocks.getRemoteLogCollectionEnabled,
  subscribeDeveloperMode: vi.fn((listener: () => void) => {
    mocks.developerModeListeners.add(listener);
    return () => mocks.developerModeListeners.delete(listener);
  }),
}));

vi.mock("../ClientLogCollector", () => ({
  ClientLogCollector: vi.fn(() => mocks.collector),
}));

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("initClientLogCollection", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    sessionStorage.clear();
    cleanup = null;
    mocks.collector.start.mockClear();
    mocks.collector.stop.mockClear();
    mocks.developerModeListeners.clear();
    mocks.getRemoteLogCollectionEnabled.mockReturnValue(false);
    mocks.getServerSettings.mockReset();
    mocks.getServerSettings.mockResolvedValue({
      settings: {
        serviceWorkerEnabled: true,
        persistRemoteSessionsToDisk: false,
        clientLogCollectionRequested: false,
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("starts collection when the server requests it", async () => {
    mocks.getServerSettings.mockResolvedValueOnce({
      settings: {
        serviceWorkerEnabled: true,
        persistRemoteSessionsToDisk: false,
        clientLogCollectionRequested: true,
      },
    });

    const diagnostics = await import("../index");
    cleanup = diagnostics.initClientLogCollection();
    await flushPromises();

    expect(mocks.collector.start).toHaveBeenCalledTimes(1);
  });

  it("starts collection when the browser developer setting requests it", async () => {
    mocks.getRemoteLogCollectionEnabled.mockReturnValue(true);

    const diagnostics = await import("../index");
    cleanup = diagnostics.initClientLogCollection();

    expect(mocks.collector.start).toHaveBeenCalledTimes(1);
  });

  it("does not opt in on a failed server settings fetch", async () => {
    mocks.getServerSettings.mockRejectedValueOnce(new Error("offline"));

    const diagnostics = await import("../index");
    cleanup = diagnostics.initClientLogCollection();
    await flushPromises();

    expect(mocks.collector.start).not.toHaveBeenCalled();
  });

  it("lets the user stop server-requested collection for this tab", async () => {
    mocks.getServerSettings.mockResolvedValueOnce({
      settings: {
        serviceWorkerEnabled: true,
        persistRemoteSessionsToDisk: false,
        clientLogCollectionRequested: true,
      },
    });

    const diagnostics = await import("../index");
    cleanup = diagnostics.initClientLogCollection();
    await flushPromises();

    expect(mocks.collector.start).toHaveBeenCalledTimes(1);

    diagnostics.disableClientLogCollectionForTab();

    expect(mocks.collector.stop).toHaveBeenCalled();
    expect(
      sessionStorage.getItem("yep-anywhere-client-log-collection-disabled"),
    ).toBe("true");
  });
});
