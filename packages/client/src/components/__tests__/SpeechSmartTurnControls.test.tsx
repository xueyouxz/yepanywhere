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

  return (
    <SpeechSmartTurnControls settings={settings} onChange={setSettings} />
  );
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

    fireEvent.change(screen.getByLabelText("Threshold"), {
      target: { value: "0.82" },
    });

    expect(checkbox.checked).toBe(true);
  });
});
