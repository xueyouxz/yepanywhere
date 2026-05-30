export const PREDICTIVE_SCROLL_AHEAD_PX = 1600;
export const PREDICTIVE_SCROLL_ROOT_MARGIN = `${PREDICTIVE_SCROLL_AHEAD_PX}px 0px`;

export function isNearScrollEnd(
  element: HTMLElement,
  aheadPx = PREDICTIVE_SCROLL_AHEAD_PX,
): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= aheadPx
  );
}
