// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import { SpeechControlMenu } from "../SpeechControlMenu";

function installMediaDevices(devices: MediaDeviceInfo[]) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => devices),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

describe("SpeechControlMenu", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("persists a selected microphone device for server STT capture", async () => {
    installMediaDevices([
      {
        kind: "audioinput",
        deviceId: "default",
        label: "Default microphone",
      } as MediaDeviceInfo,
      {
        kind: "audioinput",
        deviceId: "usb-mic",
        label: "USB microphone",
      } as MediaDeviceInfo,
      {
        kind: "videoinput",
        deviceId: "camera",
        label: "Camera",
      } as MediaDeviceInfo,
    ]);

    render(
      <SpeechControlMenu
        trigger={<button type="button">voice</button>}
        showMethodSelector={false}
        methodOptions={[]}
        selectedMethod="ya-grok"
        onMethodChange={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));
    const select = await screen.findByRole("combobox", {
      name: "Microphone",
    });
    await waitFor(() =>
      expect(screen.getByText("USB microphone")).toBeDefined(),
    );

    fireEvent.change(select, { target: { value: "usb-mic" } });

    expect(localStorage.getItem(UI_KEYS.speechMicDeviceId)).toBe("usb-mic");
  });

  it("prewarms once while the mouse remains near the trigger margin", () => {
    installMediaDevices([]);
    const prewarm = vi.fn();

    render(
      <SpeechControlMenu
        trigger={<button type="button">voice</button>}
        showMethodSelector={false}
        methodOptions={[]}
        selectedMethod="ya-grok"
        onMethodChange={vi.fn()}
        onPointerNearTrigger={prewarm}
      />,
    );

    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 1, clientY: 1 }),
    );
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 2, clientY: 2 }),
    );
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 100, clientY: 100 }),
    );
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 1, clientY: 1 }),
    );

    expect(prewarm).toHaveBeenCalledTimes(2);
  });
});
