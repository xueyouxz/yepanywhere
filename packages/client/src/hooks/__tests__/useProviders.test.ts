import type { ProviderInfo } from "@yep-anywhere/shared";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProviders } from "../useProviders";

const apiMock = vi.hoisted(() => ({
  getProviders: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: apiMock,
}));

afterEach(() => {
  cleanup();
});

describe("useProviders", () => {
  it("reuses cached providers when the hook remounts", async () => {
    const providers: ProviderInfo[] = [
      {
        name: "claude",
        displayName: "Claude",
        installed: true,
        authenticated: true,
        enabled: true,
        models: [{ id: "sonnet", name: "Sonnet" }],
      },
    ];
    apiMock.getProviders.mockResolvedValue({ providers });

    const first = renderHook(() => useProviders());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.providers).toEqual(providers);
    first.unmount();

    const second = renderHook(() => useProviders());

    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.providers).toEqual(providers);
    expect(apiMock.getProviders).toHaveBeenCalledTimes(1);
  });
});
