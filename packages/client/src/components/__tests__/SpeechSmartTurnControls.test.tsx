// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import type { SpeechSmartTurnSettings } from "../../lib/speechProviders/SpeechProvider";
import { SpeechSmartTurnControls } from "../SpeechSmartTurnControls";

afterEach(() => {
  cleanup();
});

function SmartTurnHarness() {
  const [settings, setSettings] = useState<SpeechSmartTurnSettings>({
    enabled: false,
    threshold: 0.95,
    timeoutMs: 3000,
  });

  return <SpeechSmartTurnControls settings={settings} onChange={setSettings} />;
}

describe("SpeechSmartTurnControls", () => {
  it("enables Smart Turn when the threshold slider is adjusted", () => {
    render(
      <I18nProvider>
        <SmartTurnHarness />
      </I18nProvider>,
    );

    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", {
      name: /Smart Turn/,
    });
    expect(checkbox.checked).toBe(false);

    const slider = screen.getByLabelText("Threshold");
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, {
      target: { value: "0.82" },
    });
    fireEvent.pointerUp(slider);

    expect(checkbox.checked).toBe(true);
  });

  it("allows Smart Turn timeout up to 10 seconds", () => {
    render(
      <I18nProvider>
        <SmartTurnHarness />
      </I18nProvider>,
    );

    expect(screen.getByText("1 requires perfect confidence.")).toBeDefined();
    expect(screen.getByLabelText("Timeout").getAttribute("max")).toBe("10000");
    expect(
      screen
        .getByLabelText("Smart Turn timeout milliseconds")
        .getAttribute("max"),
    ).toBe("10000");
    fireEvent.click(screen.getByRole("checkbox", { name: /Smart Turn/ }));
    expect(
      screen.getByText(
        "Timeout is the max wait. At turn end, say send, cancel, or wait; no command means send.",
      ),
    ).toBeDefined();
  });
});
