// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { SpeechControlMenu } from "../SpeechControlMenu";

const modelSettings = vi.hoisted(() => {
  const state = {
    parakeetSpeechModel: "nvidia/parakeet-tdt-0.6b-v3",
    setParakeetSpeechModel: vi.fn(),
  };
  state.setParakeetSpeechModel = vi.fn((model: string) => {
    state.parakeetSpeechModel = model;
  });
  return state;
});

vi.mock("../../hooks/useModelSettings", () => ({
  useModelSettings: () => ({
    parakeetSpeechModel: modelSettings.parakeetSpeechModel,
    setParakeetSpeechModel: modelSettings.setParakeetSpeechModel,
  }),
}));

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

function renderSpeechControlMenu(
  props: React.ComponentProps<typeof SpeechControlMenu>,
) {
  return render(
    <I18nProvider>
      <SpeechControlMenu {...props} />
    </I18nProvider>,
  );
}

describe("SpeechControlMenu", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    modelSettings.parakeetSpeechModel = "nvidia/parakeet-tdt-0.6b-v3";
    modelSettings.setParakeetSpeechModel.mockClear();
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

    renderSpeechControlMenu({
      trigger: <button type="button">voice</button>,
      showMethodSelector: false,
      methodOptions: [],
      selectedMethod: "ya-grok",
      onMethodChange: vi.fn(),
    });

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

    renderSpeechControlMenu({
      trigger: <button type="button">voice</button>,
      showMethodSelector: false,
      methodOptions: [],
      selectedMethod: "ya-grok",
      onMethodChange: vi.fn(),
      onPointerNearTrigger: prewarm,
    });

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

  it("stops active capture before opening speech options", () => {
    installMediaDevices([]);
    const onBeforeOpen = vi.fn();

    renderSpeechControlMenu({
      trigger: <button type="button">voice</button>,
      showMethodSelector: false,
      methodOptions: [],
      selectedMethod: "ya-grok",
      onMethodChange: vi.fn(),
      onBeforeOpen,
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));

    expect(onBeforeOpen).toHaveBeenCalledTimes(1);
  });

  it("stops active capture before changing speech backend", () => {
    installMediaDevices([]);
    const onBeforeCaptureChange = vi.fn();
    const onMethodChange = vi.fn();

    renderSpeechControlMenu({
      trigger: <button type="button">voice</button>,
      showMethodSelector: true,
      methodOptions: [
        { value: "browser-native", label: "Browser" },
        { value: "xai-grok-direct-streaming", label: "Grok direct" },
      ],
      selectedMethod: "browser-native",
      onMethodChange,
      onBeforeCaptureChange,
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));
    fireEvent.click(screen.getByRole("radio", { name: "Grok direct" }));

    expect(onBeforeCaptureChange).toHaveBeenCalledTimes(1);
    expect(onMethodChange).toHaveBeenCalledWith(["xai-grok-direct-streaming"]);
  });

  it("does not expose browser xAI key editing in the mic options", () => {
    installMediaDevices([]);

    renderSpeechControlMenu({
      trigger: <button type="button">voice</button>,
      showMethodSelector: false,
      methodOptions: [],
      selectedMethod: "ya-grok",
      onMethodChange: vi.fn(),
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));

    expect(screen.queryByLabelText("Browser xAI STT Key")).toBeNull();
  });

  it("shows preset and free-text Parakeet model controls", () => {
    installMediaDevices([]);
    const onBeforeCaptureChange = vi.fn();

    renderSpeechControlMenu({
      trigger: <button type="button">voice</button>,
      showMethodSelector: false,
      methodOptions: [],
      selectedMethod: "ya-parakeet",
      onMethodChange: vi.fn(),
      onBeforeCaptureChange,
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));
    const preset = screen.getByLabelText("Parakeet model preset");
    expect(screen.getByText("CTC 1.1B English lowercase")).toBeDefined();
    fireEvent.change(preset, {
      target: { value: "nvidia/parakeet-ctc-1.1b" },
    });

    const input = screen.getByLabelText("Parakeet model id");
    fireEvent.change(input, {
      target: { value: "nvidia/custom-parakeet" },
    });

    expect(modelSettings.setParakeetSpeechModel).toHaveBeenCalledWith(
      "nvidia/parakeet-ctc-1.1b",
    );
    expect(modelSettings.setParakeetSpeechModel).toHaveBeenCalledWith(
      "nvidia/custom-parakeet",
    );
    expect(onBeforeCaptureChange).toHaveBeenCalledTimes(2);
  });
});
