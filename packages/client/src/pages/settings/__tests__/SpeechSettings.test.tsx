// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechSettings } from "../SpeechSettings";

const modelSettings = vi.hoisted(() => {
  const state = {
    voiceInputEnabled: true,
    setVoiceInputEnabled: vi.fn(),
    speechMethod: "ya-parakeet",
    hasStoredSpeechMethod: true,
    setSpeechMethod: vi.fn(),
    speechSmartTurnSettings: {
      enabled: false,
      threshold: 0.5,
      timeoutMs: 2000,
    },
    setSpeechSmartTurnSettings: vi.fn(),
    parakeetSpeechModel: "nvidia/parakeet-tdt-0.6b-v3",
    setParakeetSpeechModel: vi.fn(),
  };
  state.setSpeechMethod = vi.fn((method: string) => {
    state.speechMethod = method;
  });
  state.setParakeetSpeechModel = vi.fn((model: string) => {
    state.parakeetSpeechModel = model;
  });
  return state;
});
const speechCaptureSettings = vi.hoisted(() => ({
  keepMicWarm: false,
  setKeepMicWarm: vi.fn(),
}));
const browserXaiKey = vi.hoisted(() => ({
  browserXaiSttApiKey: "",
  hasBrowserXaiSttApiKey: false,
  setBrowserXaiSttApiKey: vi.fn(),
}));
const versionState = vi.hoisted(() => ({
  voiceBackends: ["ya-grok", "ya-parakeet", "ya-nemo"],
}));
const prewarmYaServerSpeechBackend = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../../hooks/useModelSettings", () => ({
  useModelSettings: () => modelSettings,
}));

vi.mock("../../../hooks/useSpeechCaptureSettings", () => ({
  useSpeechCaptureSettings: () => speechCaptureSettings,
}));

vi.mock("../../../hooks/useBrowserXaiSttApiKey", () => ({
  useBrowserXaiSttApiKey: () => browserXaiKey,
}));

vi.mock("../../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: ["voiceInput"],
      voiceBackends: versionState.voiceBackends,
      voiceBackendCapabilities: {
        "ya-grok": { streaming: true, smartTurn: true },
      },
    },
    loading: false,
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.backend
        ? `${key} ${values.backend}`
        : values?.label
          ? `${key} ${values.label}`
          : key,
  }),
}));

vi.mock("../../../lib/speechProviders/YaServerProvider", () => ({
  prewarmYaServerSpeechBackend,
}));

describe("SpeechSettings", () => {
  afterEach(() => {
    cleanup();
    modelSettings.speechMethod = "ya-parakeet";
    modelSettings.parakeetSpeechModel = "nvidia/parakeet-tdt-0.6b-v3";
    versionState.voiceBackends = ["ya-grok", "ya-parakeet", "ya-nemo"];
    modelSettings.setSpeechMethod.mockClear();
    modelSettings.setParakeetSpeechModel.mockClear();
    speechCaptureSettings.setKeepMicWarm.mockClear();
    browserXaiKey.setBrowserXaiSttApiKey.mockClear();
    prewarmYaServerSpeechBackend.mockClear();
  });

  it("prewarms a Parakeet preset selected in global STT options", () => {
    render(<SpeechSettings />);

    fireEvent.change(
      screen.getByLabelText("speechSettingsParakeetModelPresetLabel"),
      {
        target: { value: "nvidia/parakeet-ctc-1.1b" },
      },
    );

    expect(modelSettings.setParakeetSpeechModel).toHaveBeenCalledWith(
      "nvidia/parakeet-ctc-1.1b",
    );
    expect(prewarmYaServerSpeechBackend).toHaveBeenCalledWith(
      "ya-parakeet",
      "nvidia/parakeet-ctc-1.1b",
    );
  });

  it("switches to a compatible enabled backend for a selected Parakeet preset", () => {
    render(<SpeechSettings />);

    fireEvent.change(
      screen.getByLabelText("speechSettingsParakeetModelPresetLabel"),
      {
        target: { value: "nvidia/parakeet-rnnt-1.1b" },
      },
    );

    expect(modelSettings.setParakeetSpeechModel).toHaveBeenCalledWith(
      "nvidia/parakeet-rnnt-1.1b",
    );
    expect(modelSettings.setSpeechMethod).toHaveBeenCalledWith("ya-nemo");
    expect(prewarmYaServerSpeechBackend).toHaveBeenCalledWith(
      "ya-nemo",
      "nvidia/parakeet-rnnt-1.1b",
    );
  });

  it("disables Parakeet presets unsupported by enabled local backends", () => {
    versionState.voiceBackends = ["ya-grok", "ya-parakeet"];

    render(<SpeechSettings />);

    const option = screen.getByRole("option", {
      name: /RNNT 1\.1B English lowercase/,
    }) as HTMLOptionElement;

    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain("NeMo Parakeet");
  });

  it("prewarms the current Parakeet model when selecting a local STT backend globally", () => {
    modelSettings.speechMethod = "ya-grok";
    render(<SpeechSettings />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "filterByLabel speechSettingsBackendTitle",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /NeMo Parakeet STT/ }));

    expect(modelSettings.setSpeechMethod).toHaveBeenCalledWith("ya-nemo");
    expect(prewarmYaServerSpeechBackend).toHaveBeenCalledWith(
      "ya-nemo",
      "nvidia/parakeet-tdt-0.6b-v3",
    );
  });

  it("normalizes an incompatible preset when selecting a local STT backend globally", () => {
    modelSettings.speechMethod = "ya-grok";
    modelSettings.parakeetSpeechModel = "nvidia/parakeet-rnnt-1.1b";
    render(<SpeechSettings />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "filterByLabel speechSettingsBackendTitle",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Parakeet STT/ }));

    expect(modelSettings.setSpeechMethod).toHaveBeenCalledWith("ya-parakeet");
    expect(modelSettings.setParakeetSpeechModel).toHaveBeenCalledWith(
      "nvidia/parakeet-tdt-0.6b-v3",
    );
    expect(prewarmYaServerSpeechBackend).toHaveBeenCalledWith(
      "ya-parakeet",
      "nvidia/parakeet-tdt-0.6b-v3",
    );
  });
});
