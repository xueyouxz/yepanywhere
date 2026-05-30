import { describe, expect, it } from "vitest";
import { getBtwSplitRouting, getBtwToolbarMode } from "../btwAsideRouting";

describe("btwAsideRouting", () => {
  it("keeps wide open panes separate from footer-aside routing", () => {
    const routing = getBtwSplitRouting({
      isWideScreen: true,
      hasFocusedAside: true,
      sidePaneCollapsed: false,
    });

    expect(routing).toEqual({
      wantSplitLayout: true,
      showSidePane: true,
      footerRoutesToAside: false,
    });
    expect(
      getBtwToolbarMode({
        hasChildParentHref: false,
        hasFocusedAside: true,
        footerRoutesToAside: routing.footerRoutesToAside,
        paneComposerVisible: routing.showSidePane,
        hasAvailableAsides: false,
      }),
    ).toBe("focused-pane");
  });

  it("routes the wide collapsed footer composer to the focused aside", () => {
    const routing = getBtwSplitRouting({
      isWideScreen: true,
      hasFocusedAside: true,
      sidePaneCollapsed: true,
    });

    expect(routing).toEqual({
      wantSplitLayout: true,
      showSidePane: false,
      footerRoutesToAside: true,
    });
    expect(
      getBtwToolbarMode({
        hasChildParentHref: false,
        hasFocusedAside: true,
        footerRoutesToAside: routing.footerRoutesToAside,
        paneComposerVisible: routing.showSidePane,
        hasAvailableAsides: false,
      }),
    ).toBe("focused-footer");
  });

  it("routes the narrow footer composer to the focused aside", () => {
    const routing = getBtwSplitRouting({
      isWideScreen: false,
      hasFocusedAside: true,
      sidePaneCollapsed: false,
    });

    expect(routing).toEqual({
      wantSplitLayout: false,
      showSidePane: false,
      footerRoutesToAside: true,
    });
    expect(
      getBtwToolbarMode({
        hasChildParentHref: false,
        hasFocusedAside: true,
        footerRoutesToAside: routing.footerRoutesToAside,
        paneComposerVisible: routing.showSidePane,
        hasAvailableAsides: false,
      }),
    ).toBe("focused-footer");
  });

  it("keeps focused history asides active even without sticky asides", () => {
    const routing = getBtwSplitRouting({
      isWideScreen: true,
      hasFocusedAside: true,
      sidePaneCollapsed: false,
    });

    expect(
      getBtwToolbarMode({
        hasChildParentHref: false,
        hasFocusedAside: true,
        footerRoutesToAside: routing.footerRoutesToAside,
        paneComposerVisible: routing.showSidePane,
        hasAvailableAsides: false,
      }),
    ).toBe("focused-pane");
  });

  it("marks unfocused available asides separately from focused state", () => {
    expect(
      getBtwToolbarMode({
        hasChildParentHref: false,
        hasFocusedAside: false,
        footerRoutesToAside: false,
        paneComposerVisible: false,
        hasAvailableAsides: true,
      }),
    ).toBe("focus-existing");
  });
});
