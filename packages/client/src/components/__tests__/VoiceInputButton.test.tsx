// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UseSpeechRecognitionOptions } from "../../hooks/useSpeechRecognition";
import { VoiceInputButton } from "../VoiceInputButton";

const { connection, observedSpeechOptions, openSpeechSocket, speechState } =
  vi.hoisted(() => {
    const openSpeechSocket = vi.fn();
    return {
      connection: { openSpeechSocket },
      observedSpeechOptions: [] as UseSpeechRecognitionOptions[],
      openSpeechSocket,
      speechState: {
        isListening: false,
        status: "idle" as
          | "idle"
          | "starting"
          | "listening"
          | "receiving"
          | "processing"
          | "finalizing"
          | "reconnecting"
          | "error",
      },
    };
  });

vi.mock("../../hooks/useConnection", () => ({
  useConnection: () => connection,
}));

vi.mock("../../hooks/useModelSettings", () => ({
  useModelSettings: () => ({
    voiceInputEnabled: true,
    speechMethod: "browser-native",
    hasStoredSpeechMethod: false,
    parakeetSpeechModel: "nvidia/parakeet-ctc-1.1b",
    grokSpeechAudioSettings: { uplinkMode: "pcm16" },
  }),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "/ygraehl",
}));

vi.mock("../../hooks/useSpeechCaptureSettings", () => ({
  useSpeechCaptureSettings: () => ({
    keepMicWarm: false,
    micDeviceId: null,
  }),
}));

vi.mock("../../hooks/useSpeechRecognition", () => ({
  SPEECH_STATUS_LABELS: {
    idle: "Idle",
    starting: "Connecting...",
    listening: "Listening",
    receiving: "Receiving",
    processing: "Transcribing",
    finalizing: "Finalizing",
    reconnecting: "Reconnecting...",
    error: "Error",
  },
  useSpeechRecognition: (options: UseSpeechRecognitionOptions) => {
    observedSpeechOptions.push(options);
    return {
      isSupported: true,
      isListening: speechState.isListening,
      status: speechState.status,
      interimTranscript: "",
      startListening: vi.fn(),
      stopListening: vi.fn(),
      toggleListening: vi.fn(),
      prewarm: vi.fn(),
      error: null,
    };
  },
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: ["voiceInput"],
      voiceBackends: [],
      voiceBackendCapabilities: {},
    },
  }),
}));

vi.mock("../../hooks/useViewportWidth", () => ({
  useViewportWidth: () => 800,
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../lib/deviceDetection", () => ({
  hasCoarsePointer: () => false,
}));

describe("VoiceInputButton", () => {
  afterEach(() => {
    cleanup();
    observedSpeechOptions.length = 0;
    openSpeechSocket.mockReset();
    speechState.isListening = false;
    speechState.status = "idle";
  });

  it("keeps the relayed speech socket opener stable across rerenders", () => {
    const props = {
      onTranscript: vi.fn(),
      onInterimTranscript: vi.fn(),
      speechMethod: "browser-native",
    };

    const { rerender } = render(<VoiceInputButton {...props} />);
    const firstOpenSpeechSocket =
      observedSpeechOptions.at(-1)?.openRelayedSpeechSocket;

    rerender(<VoiceInputButton {...props} />);
    const secondOpenSpeechSocket =
      observedSpeechOptions.at(-1)?.openRelayedSpeechSocket;

    expect(firstOpenSpeechSocket).toBeDefined();
    expect(secondOpenSpeechSocket).toBe(firstOpenSpeechSocket);
  });

  it("does not render post-capture processing as active capture", () => {
    speechState.status = "processing";

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    const button = screen.getByRole("button", { name: "voiceInputStartLabel" });
    expect(button.className).not.toContain("listening");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".voice-input-recording")).toBeNull();
  });

  it("passes the browser-selected Parakeet model to speech providers", () => {
    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="ya-parakeet"
      />,
    );

    expect(observedSpeechOptions.at(-1)?.parakeetModel).toBe(
      "nvidia/parakeet-ctc-1.1b",
    );
  });

  it("does not render streaming finalization as active capture", () => {
    speechState.status = "finalizing";

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    const button = screen.getByRole("button", { name: "Finalizing" });
    expect(button.className).not.toContain("listening");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".voice-input-recording")).toBeNull();
  });

  it("reports a listening pending kind during active capture", () => {
    speechState.status = "listening";
    speechState.isListening = true;
    const onPendingSpeechChange = vi.fn();

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        onPendingSpeechChange={onPendingSpeechChange}
        speechMethod="browser-native"
      />,
    );

    // The composer surfaces capture as a cancellable chip too, so the ✕ can
    // abandon the in-flight utterance — not just the post-capture waits.
    expect(onPendingSpeechChange).toHaveBeenCalledWith("listening");
  });
});
