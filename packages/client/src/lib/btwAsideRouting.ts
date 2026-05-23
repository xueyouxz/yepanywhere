export interface BtwSplitRoutingInput {
  isWideScreen: boolean;
  hasFocusedAside: boolean;
  sidePaneCollapsed: boolean;
}

export interface BtwSplitRoutingState {
  wantSplitLayout: boolean;
  showSidePane: boolean;
  footerRoutesToAside: boolean;
}

export type BtwToolbarMode =
  | "start"
  | "focus-existing"
  | "focused-footer"
  | "focused-pane"
  | "child-session";

export interface BtwToolbarModeInput {
  hasChildParentHref: boolean;
  hasFocusedAside: boolean;
  footerRoutesToAside: boolean;
  paneComposerVisible: boolean;
  hasAvailableAsides: boolean;
}

export function getBtwSplitRouting({
  isWideScreen,
  hasFocusedAside,
  sidePaneCollapsed,
}: BtwSplitRoutingInput): BtwSplitRoutingState {
  const wantSplitLayout = isWideScreen && hasFocusedAside;
  const showSidePane = wantSplitLayout && !sidePaneCollapsed;
  return {
    wantSplitLayout,
    showSidePane,
    footerRoutesToAside: hasFocusedAside && !showSidePane,
  };
}

export function getBtwToolbarMode({
  hasChildParentHref,
  hasFocusedAside,
  footerRoutesToAside,
  paneComposerVisible,
  hasAvailableAsides,
}: BtwToolbarModeInput): BtwToolbarMode {
  if (hasChildParentHref) {
    return "child-session";
  }

  if (hasFocusedAside && paneComposerVisible) {
    return "focused-pane";
  }

  if (hasFocusedAside || footerRoutesToAside) {
    return "focused-footer";
  }

  return hasAvailableAsides ? "focus-existing" : "start";
}
