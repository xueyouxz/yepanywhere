import {
  type ChangeEvent,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

type NativeRangeProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "defaultValue" | "onChange" | "type" | "value"
>;

interface CommittedRangeInputProps extends NativeRangeProps {
  value: number;
  onCommit: (value: number) => void;
  onDraftChange?: (value: number) => void;
}

function readRangeValue(input: HTMLInputElement): number {
  const parsed = Number(input.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function CommittedRangeInput({
  value,
  onCommit,
  onDraftChange,
  onBlur,
  onKeyUp,
  onPointerCancel,
  onPointerDown,
  onPointerUp,
  ...inputProps
}: CommittedRangeInputProps) {
  const [draft, setDraft] = useState(value);
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) {
      setDraft(value);
    }
  }, [value]);

  const commit = (next: number) => {
    editingRef.current = false;
    setDraft(next);
    if (!Object.is(next, value)) {
      onCommit(next);
    }
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = readRangeValue(event.currentTarget);
    editingRef.current = true;
    setDraft(next);
    onDraftChange?.(next);
  };

  const handlePointerDown = (event: PointerEvent<HTMLInputElement>) => {
    editingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onPointerDown?.(event);
  };

  const handlePointerUp = (event: PointerEvent<HTMLInputElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commit(readRangeValue(event.currentTarget));
    onPointerUp?.(event);
  };

  const handlePointerCancel = (event: PointerEvent<HTMLInputElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commit(readRangeValue(event.currentTarget));
    onPointerCancel?.(event);
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLInputElement>) => {
    if (editingRef.current) {
      commit(readRangeValue(event.currentTarget));
    }
    onKeyUp?.(event);
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    if (editingRef.current) {
      commit(readRangeValue(event.currentTarget));
    }
    onBlur?.(event);
  };

  return (
    <input
      {...inputProps}
      type="range"
      value={draft}
      onBlur={handleBlur}
      onChange={handleChange}
      onKeyUp={handleKeyUp}
      onPointerCancel={handlePointerCancel}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    />
  );
}
