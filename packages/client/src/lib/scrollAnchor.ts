import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Preserves the visual position of a button element across a toggle that changes
 * the height of its scroll container's content. Call handleClick in place of the
 * raw toggle function; the hook adjusts scrollTop after React commits the DOM
 * change so the button appears to stay in the same viewport position.
 */
export function useScrollPreservingToggle(
  isToggled: boolean,
  toggleFn: () => void,
) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<{ scrollEl: Element; initialOffset: number } | null>(
    null,
  );

  const handleClick = useCallback(() => {
    const btn = btnRef.current;
    if (btn) {
      let scrollEl: Element | null = btn.parentElement;
      while (scrollEl) {
        const { overflowY } = window.getComputedStyle(scrollEl);
        if (overflowY === "auto" || overflowY === "scroll") break;
        scrollEl = scrollEl.parentElement;
      }
      if (scrollEl) {
        pendingRef.current = {
          scrollEl,
          initialOffset:
            btn.getBoundingClientRect().top -
            scrollEl.getBoundingClientRect().top,
        };
      }
    }
    toggleFn();
  }, [toggleFn]);

  // Runs synchronously after React commits the DOM — before the browser paints.
  // Corrects scrollTop so the button stays at the same viewport position.
  useLayoutEffect(() => {
    const state = pendingRef.current;
    if (!state) return;
    pendingRef.current = null;
    const btn = btnRef.current;
    if (!btn) return;
    const newOffset =
      btn.getBoundingClientRect().top -
      state.scrollEl.getBoundingClientRect().top;
    const shift = newOffset - state.initialOffset;
    if (Math.abs(shift) > 1) {
      (state.scrollEl as HTMLElement).scrollTop += shift;
    }
  }, [isToggled]);

  return { btnRef, handleClick };
}
