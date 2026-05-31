// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SpeechSmartTurnControls } from "../SpeechSmartTurnControls";
import type { SpeechSmartTurnSettings } from "../../lib/speechProviders/SpeechProvider";

afterEach(() => {
  cleanup();
});

function SmartTurnHarness() {
  const [settings, setSettings] = useState<SpeechSmartTurnSettings>({
    enabled: false,
    threshold: 0.7,
    timeoutMs: 3000,
  });

  return (
    <SpeechSmartTurnControls settings={settings} onChange={setSettings} />
  );
}

describe("SpeechSmartTurnControls", () => {
  it("enables Smart Turn when the threshold slider is adjusted", () => {
    render(<SmartTurnHarness />);

    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", {
      name: /Smart Turn/,
    });
    expect(checkbox.checked).toBe(false);

    fireEvent.change(screen.getByLabelText("Threshold"), {
      target: { value: "0.82" },
    });

    expect(checkbox.checked).toBe(true);
  });
});
