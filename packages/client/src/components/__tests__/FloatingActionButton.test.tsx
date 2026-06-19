// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockVoiceCancelProcessing, mockVoiceToggle, voicePropsState } =
  vi.hoisted(() => ({
    mockVoiceCancelProcessing: vi.fn(),
    mockVoiceToggle: vi.fn(),
    voicePropsState: {
      current: null as null | {
        onPendingSpeechChange?: (
          kind: "listening" | "transcribing" | "finalizing" | null,
        ) => void;
        onInterimTranscript?: (text: string) => void;
      },
    },
  }));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/" }),
}));

vi.mock("../../hooks/useDraftPersistence", () => ({
  useDraftPersistence: () => {
    const [value, setValueInternal] = useState("");
    const valueRef = useRef("");
    const setValue = useCallback((next: string) => {
      valueRef.current = next;
      setValueInternal(next);
    }, []);
    const getDraft = useCallback(() => valueRef.current, []);
    const setDraft = setValue;
    const noop = useCallback(() => {}, []);
    const clearInput = useCallback(() => setValue(""), [setValue]);
    const controls = useMemo(
      () => ({
        getDraft,
        setDraft,
        flushDraft: noop,
        clearInput,
        clearDraft: clearInput,
        restoreFromStorage: noop,
      }),
      [getDraft, setDraft, noop, clearInput],
    );
    return [value, setValue, controls] as const;
  },
}));

vi.mock("../../hooks/useFabVisibility", () => ({
  useFabVisibility: () => ({ right: 24, bottom: 80, maxWidth: 200 }),
}));

vi.mock("../../hooks/useFloatingActionButtonEnabled", () => ({
  useFloatingActionButtonEnabled: () => ({ floatingActionButtonEnabled: true }),
}));

vi.mock("../../hooks/useRecentProject", () => ({
  setRecentProjectId: vi.fn(),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../VoiceInputButton", () => ({
  VoiceInputButton: forwardRef((props: Record<string, unknown>, ref) => {
    voicePropsState.current = props as typeof voicePropsState.current;
    useImperativeHandle(
      ref,
      () => ({
        stopAndFinalize: () => "",
        toggle: mockVoiceToggle,
        cancelProcessing: mockVoiceCancelProcessing,
        isListening: false,
        isAvailable: true,
      }),
      [],
    );
    return <button type="button">voice</button>;
  }),
}));

import { FloatingActionButton } from "../FloatingActionButton";

afterEach(() => {
  cleanup();
  mockVoiceCancelProcessing.mockReset();
  mockVoiceToggle.mockReset();
  voicePropsState.current = null;
});

describe("FloatingActionButton speech", () => {
  it("keeps the quick composer editable with an inline transcribing badge", async () => {
    render(<FloatingActionButton />);

    // Expand the quick-compose panel.
    fireEvent.click(screen.getByLabelText("fabNewSession"));
    const textarea = (await screen.findByPlaceholderText(
      "fabPlaceholder",
    )) as HTMLTextAreaElement;

    expect(document.querySelector(".speech-processing-inline")).toBeNull();

    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
    });
    const badge = await waitFor(() => {
      const el = document.querySelector(".speech-processing-inline");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(badge.textContent).toContain("Transcribing");

    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: "typed while transcribing" } });
    expect(textarea.value).toBe("typed while transcribing");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(mockVoiceCancelProcessing).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(document.querySelector(".speech-processing-inline")).toBeNull();
    });
    expect(textarea.value).toBe("typed while transcribing");
  });
});
