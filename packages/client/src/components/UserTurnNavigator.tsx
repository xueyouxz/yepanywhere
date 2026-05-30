import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

export interface UserTurnNavAnchor {
  id: string;
  preview: string;
  searchText?: string;
}

export interface UserTurnNavSearchState {
  activeId: string | null;
  matchIds: ReadonlySet<string>;
  preview: string | null;
  previewsById: ReadonlyMap<string, string>;
  query: string;
}

export interface UserTurnNavMotionCue {
  direction: "up" | "down";
  token: number;
}

interface Props {
  anchors?: UserTurnNavAnchor[];
  getAnchors?: () => UserTurnNavAnchor[];
  messageListRef: RefObject<HTMLDivElement | null>;
  motionCue?: UserTurnNavMotionCue | null;
  onNavigateStart?: () => void;
  onTrimAnchor?: (id: string) => void;
  searchState?: UserTurnNavSearchState | null;
}

interface UserTurnMarker extends UserTurnNavAnchor {
  topPct: number;
  scrollTopPx: number;
}

interface UserTurnNavLayout {
  top: number;
  right: number;
  height: number;
  thumbTopPct: number;
  thumbHeightPct: number;
  activeId: string;
  markers: UserTurnMarker[];
  signature: string;
}

interface UserTurnPreviewLabel {
  id: string;
  topPx: number;
  text: string;
  compact: boolean;
  active: boolean;
}

const MIN_NAV_ANCHORS = 2;
const NAV_EDGE_INSET_PX = 4;
const NAV_VERTICAL_INSET_PX = 8;
const PREVIEW_VERTICAL_MARGIN_PX = 22;
const PREVIEW_FULL_MIN_GAP_PX = 62;
const PREVIEW_COMPACT_MIN_GAP_PX = 24;
const NAV_REVEAL_HOTZONE_PX = 64;
const MAX_SEARCH_PREVIEW_LABELS = 10;
const MOTION_CUE_CLEAR_MS = 760;

type LayoutUpdateKind = "full" | "scroll";

function getScrollContainer(
  messageList: HTMLDivElement | null,
): HTMLElement | null {
  return messageList?.parentElement ?? null;
}

function findRenderRow(
  messageList: HTMLDivElement | null,
  id: string,
): HTMLElement | null {
  if (!messageList) return null;
  for (const row of messageList.querySelectorAll<HTMLElement>(
    "[data-render-id]",
  )) {
    if (row.dataset.renderId === id) {
      return row;
    }
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function renderHighlightedText(text: string, query: string) {
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalizedQuery) {
    return text;
  }

  const lowerText = text.toLowerCase();
  const parts: Array<string | ReactElement> = [];
  let cursor = 0;
  let key = 0;

  while (cursor < text.length) {
    const index = lowerText.indexOf(normalizedQuery, cursor);
    if (index === -1) {
      break;
    }
    if (index > cursor) {
      parts.push(text.slice(cursor, index));
    }
    parts.push(
      <mark key={key} className="user-turn-nav-preview-match">
        {text.slice(index, index + normalizedQuery.length)}
      </mark>,
    );
    key += 1;
    cursor = index + normalizedQuery.length;
  }

  if (parts.length === 0) {
    return text;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

function findActiveId(
  markers: UserTurnMarker[],
  scrollTop: number,
  clientHeight: number,
): string {
  const activeCutoff = scrollTop + Math.min(clientHeight * 0.35, 220);
  let activeId = markers[0]?.id ?? "";
  for (const marker of markers) {
    if (marker.scrollTopPx <= activeCutoff) {
      activeId = marker.id;
    } else {
      break;
    }
  }
  return activeId;
}

function getAnimationFrame(): {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
} {
  if (typeof window.requestAnimationFrame === "function") {
    return {
      request: window.requestAnimationFrame.bind(window),
      cancel: window.cancelAnimationFrame.bind(window),
    };
  }
  return {
    request: (callback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    cancel: window.clearTimeout.bind(window),
  };
}

function buildSignature(layout: Omit<UserTurnNavLayout, "signature">): string {
  const markerSignature = layout.markers
    .map((marker) => `${marker.id}:${Math.round(marker.topPct * 100)}`)
    .join("|");
  return [
    Math.round(layout.top),
    Math.round(layout.right),
    Math.round(layout.height),
    Math.round(layout.thumbTopPct * 100),
    Math.round(layout.thumbHeightPct * 100),
    layout.activeId,
    markerSignature,
  ].join(":");
}

function measureLayout(
  anchors: UserTurnNavAnchor[],
  messageList: HTMLDivElement | null,
  minAnchors = MIN_NAV_ANCHORS,
): UserTurnNavLayout | null {
  if (anchors.length < minAnchors || !messageList) {
    return null;
  }

  const scrollContainer = getScrollContainer(messageList);
  if (!scrollContainer) {
    return null;
  }

  const scrollRect = scrollContainer.getBoundingClientRect();
  if (scrollRect.width <= 0 || scrollRect.height <= 0) {
    return null;
  }

  const scrollHeight = Math.max(scrollContainer.scrollHeight, 1);
  const clientHeight = Math.max(scrollContainer.clientHeight, 1);
  const markers: UserTurnMarker[] = [];
  const rowsById = new Map<string, HTMLElement>();

  for (const row of messageList.querySelectorAll<HTMLElement>(
    "[data-render-id]",
  )) {
    if (row.dataset.renderId) {
      rowsById.set(row.dataset.renderId, row);
    }
  }

  for (const anchor of anchors) {
    const row = rowsById.get(anchor.id);
    if (!row) {
      continue;
    }
    const rowRect = row.getBoundingClientRect();
    const scrollTopPx =
      scrollContainer.scrollTop + rowRect.top - scrollRect.top;
    markers.push({
      ...anchor,
      scrollTopPx,
      topPct: clamp(scrollTopPx / scrollHeight, 0, 1),
    });
  }

  if (markers.length < minAnchors) {
    return null;
  }

  const top = scrollRect.top + NAV_VERTICAL_INSET_PX;
  const height = Math.max(scrollRect.height - NAV_VERTICAL_INSET_PX * 2, 1);
  const layoutWithoutSignature = {
    top,
    right:
      window.innerWidth -
      scrollRect.right +
      NAV_EDGE_INSET_PX +
      (scrollContainer.offsetWidth - scrollContainer.clientWidth),
    height,
    thumbTopPct: clamp(scrollContainer.scrollTop / scrollHeight, 0, 1),
    thumbHeightPct: clamp(clientHeight / scrollHeight, 0.04, 1),
    activeId: findActiveId(markers, scrollContainer.scrollTop, clientHeight),
    markers,
  };
  return {
    ...layoutWithoutSignature,
    signature: buildSignature(layoutWithoutSignature),
  };
}

function updateScrollPosition(
  layout: UserTurnNavLayout,
  scrollContainer: HTMLElement,
): UserTurnNavLayout {
  const scrollHeight = Math.max(scrollContainer.scrollHeight, 1);
  const clientHeight = Math.max(scrollContainer.clientHeight, 1);
  const nextLayout = {
    ...layout,
    thumbTopPct: clamp(scrollContainer.scrollTop / scrollHeight, 0, 1),
    thumbHeightPct: clamp(clientHeight / scrollHeight, 0.04, 1),
    activeId: findActiveId(
      layout.markers,
      scrollContainer.scrollTop,
      clientHeight,
    ),
  };
  return {
    ...nextLayout,
    signature: buildSignature(nextLayout),
  };
}

function spreadPreviewLabels(
  labels: UserTurnPreviewLabel[],
  layoutHeight: number,
  compact: boolean,
): UserTurnPreviewLabel[] {
  if (labels.length <= 1) {
    return labels;
  }

  const minTop = PREVIEW_VERTICAL_MARGIN_PX;
  const maxTop = Math.max(minTop, layoutHeight - PREVIEW_VERTICAL_MARGIN_PX);
  const availableHeight = Math.max(1, maxTop - minTop);
  const preferredGap = compact
    ? PREVIEW_COMPACT_MIN_GAP_PX
    : PREVIEW_FULL_MIN_GAP_PX;
  const minGap = Math.min(preferredGap, availableHeight / (labels.length - 1));
  const placed = labels.map((label) => ({ ...label }));

  for (let index = 1; index < placed.length; index += 1) {
    const current = placed[index];
    const previous = placed[index - 1];
    if (!current || !previous) continue;
    current.topPx = Math.max(current.topPx, previous.topPx + minGap);
  }

  const lastPlaced = placed[placed.length - 1];
  const overflow = lastPlaced ? lastPlaced.topPx - maxTop : 0;
  if (overflow > 0) {
    for (const label of placed) {
      label.topPx -= overflow;
    }
  }

  const firstPlaced = placed[0];
  if (firstPlaced) {
    firstPlaced.topPx = Math.max(firstPlaced.topPx, minTop);
  }
  for (let index = 1; index < placed.length; index += 1) {
    const current = placed[index];
    const previous = placed[index - 1];
    if (!current || !previous) continue;
    current.topPx = Math.max(current.topPx, previous.topPx + minGap);
  }

  return placed.map((label) => ({
    ...label,
    topPx: clamp(label.topPx, minTop, maxTop),
  }));
}

function getSearchPreviewWindow(
  markers: UserTurnMarker[],
  activeId: string | null | undefined,
  layoutHeight: number,
): UserTurnMarker[] {
  if (markers.length <= 1) {
    return markers;
  }

  const capacity = Math.max(
    1,
    Math.min(
      MAX_SEARCH_PREVIEW_LABELS,
      Math.floor(
        Math.max(1, layoutHeight - PREVIEW_VERTICAL_MARGIN_PX * 2) /
          PREVIEW_COMPACT_MIN_GAP_PX,
      ) + 1,
    ),
  );
  if (markers.length <= capacity) {
    return markers;
  }

  const activeIndex = activeId
    ? markers.findIndex((marker) => marker.id === activeId)
    : -1;
  const centerIndex = activeIndex >= 0 ? activeIndex : markers.length - 1;
  const before = Math.floor((capacity - 1) / 2);
  const start = clamp(centerIndex - before, 0, markers.length - capacity);
  return markers.slice(start, start + capacity);
}

export const UserTurnNavigator = memo(function UserTurnNavigator({
  anchors = [],
  getAnchors,
  messageListRef,
  motionCue,
  onNavigateStart,
  onTrimAnchor,
  searchState,
}: Props) {
  const [layout, setLayout] = useState<UserTurnNavLayout | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [railActive, setRailActive] = useState(false);
  const [internalMotionCue, setInternalMotionCue] =
    useState<UserTurnNavMotionCue | null>(null);
  const anchorsRef = useRef(anchors);
  const frameRef = useRef<number | null>(null);
  const pendingUpdateKindRef = useRef<LayoutUpdateKind>("scroll");
  const motionCueTokenRef = useRef(0);
  const motionCueClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const activeMotionCue = motionCue ?? internalMotionCue;
  const minAnchorCount = searchState ? 1 : MIN_NAV_ANCHORS;
  const shouldMeasure = railActive || !!searchState || !!activeMotionCue;
  const resolveAnchors = useCallback(
    () => (getAnchors ? getAnchors() : anchors),
    [anchors, getAnchors],
  );

  const updateFullLayout = useCallback(() => {
    if (!shouldMeasure) {
      anchorsRef.current = [];
      setLayout(null);
      return;
    }
    const nextAnchors = resolveAnchors();
    anchorsRef.current = nextAnchors;
    const nextLayout = measureLayout(
      nextAnchors,
      messageListRef.current,
      minAnchorCount,
    );
    setLayout((previous) =>
      previous?.signature === nextLayout?.signature ? previous : nextLayout,
    );
  }, [messageListRef, minAnchorCount, resolveAnchors, shouldMeasure]);

  const updateScrollLayout = useCallback(() => {
    if (!shouldMeasure) {
      setLayout(null);
      return;
    }
    const scrollContainer = getScrollContainer(messageListRef.current);
    if (!scrollContainer) {
      setLayout(null);
      return;
    }

    setLayout((previous) => {
      if (!previous) {
        return measureLayout(
          anchorsRef.current,
          messageListRef.current,
          minAnchorCount,
        );
      }
      const nextLayout = updateScrollPosition(previous, scrollContainer);
      return previous.signature === nextLayout.signature ? previous : nextLayout;
    });
  }, [messageListRef, minAnchorCount, shouldMeasure]);

  const scheduleLayoutUpdate = useCallback(
    (kind: LayoutUpdateKind = "scroll") => {
      if (kind === "full") {
        pendingUpdateKindRef.current = "full";
      }
      if (frameRef.current !== null) return;
      const frame = getAnimationFrame();
      frameRef.current = frame.request(() => {
        frameRef.current = null;
        const nextKind = pendingUpdateKindRef.current;
        pendingUpdateKindRef.current = "scroll";
        if (nextKind === "full") {
          updateFullLayout();
        } else {
          updateScrollLayout();
        }
      });
    },
    [updateFullLayout, updateScrollLayout],
  );

  useEffect(() => {
    if (shouldMeasure) {
      scheduleLayoutUpdate("full");
    } else {
      anchorsRef.current = [];
      setLayout(null);
    }
  }, [resolveAnchors, scheduleLayoutUpdate, shouldMeasure]);

  useEffect(() => {
    const messageList = messageListRef.current;
    const scrollContainer = getScrollContainer(messageList);
    if (!messageList || !scrollContainer) {
      setLayout(null);
      return;
    }

    const updatePointerReveal = (event: PointerEvent) => {
      if (searchState) return;
      const rect = scrollContainer.getBoundingClientRect();
      const inVerticalRange =
        event.clientY >= rect.top && event.clientY <= rect.bottom;
      const nearScrollbar =
        event.clientX >= rect.right - NAV_REVEAL_HOTZONE_PX &&
        event.clientX <= rect.right + NAV_REVEAL_HOTZONE_PX;
      const nextActive = inVerticalRange && nearScrollbar;
      setRailActive((previous) => {
        if (previous === nextActive) return previous;
        return nextActive;
      });
    };
    const hideRail = () => {
      if (!searchState) {
        setRailActive(false);
      }
    };

    scrollContainer.addEventListener("pointermove", updatePointerReveal, {
      passive: true,
    });
    scrollContainer.addEventListener("pointerleave", hideRail);

    return () => {
      scrollContainer.removeEventListener("pointermove", updatePointerReveal);
      scrollContainer.removeEventListener("pointerleave", hideRail);
    };
  }, [messageListRef, searchState]);

  useEffect(() => {
    if (!shouldMeasure) {
      setLayout(null);
      return;
    }

    const messageList = messageListRef.current;
    const scrollContainer = getScrollContainer(messageList);
    if (!messageList || !scrollContainer) {
      setLayout(null);
      return;
    }

    const handleScroll = () => scheduleLayoutUpdate("scroll");
    const handleResize = () => scheduleLayoutUpdate("full");
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(messageList);
    resizeObserver.observe(scrollContainer);
    scheduleLayoutUpdate("full");

    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
      if (frameRef.current !== null) {
        getAnimationFrame().cancel(frameRef.current);
        frameRef.current = null;
      }
      pendingUpdateKindRef.current = "scroll";
    };
  }, [messageListRef, scheduleLayoutUpdate, shouldMeasure]);

  useEffect(
    () => () => {
      if (motionCueClearTimerRef.current !== null) {
        clearTimeout(motionCueClearTimerRef.current);
      }
    },
    [],
  );

  const showInternalMotionCue = useCallback((direction: "up" | "down") => {
    if (motionCueClearTimerRef.current !== null) {
      clearTimeout(motionCueClearTimerRef.current);
    }
    setInternalMotionCue({
      direction,
      token: (motionCueTokenRef.current += 1),
    });
    motionCueClearTimerRef.current = setTimeout(() => {
      setInternalMotionCue(null);
      motionCueClearTimerRef.current = null;
    }, MOTION_CUE_CLEAR_MS);
  }, []);

  const handleJump = useCallback(
    (id: string) => {
      const messageList = messageListRef.current;
      const scrollContainer = getScrollContainer(messageList);
      const row = findRenderRow(messageList, id);
      if (!scrollContainer || !row) return;

      onNavigateStart?.();
      const scrollRect = scrollContainer.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const nextTop = Math.max(
        0,
        scrollContainer.scrollTop + rowRect.top - scrollRect.top - 12,
      );
      const direction = nextTop < scrollContainer.scrollTop ? "up" : "down";
      showInternalMotionCue(direction);
      scrollContainer.scrollTo({ top: nextTop, behavior: "auto" });
      scheduleLayoutUpdate("scroll");
    },
    [messageListRef, onNavigateStart, scheduleLayoutUpdate, showInternalMotionCue],
  );

  const previewLabels = useMemo<UserTurnPreviewLabel[]>(() => {
    if (!layout) {
      return [];
    }

    const searchMatchIds = searchState?.matchIds;
    const hasSearchMatches = !!searchMatchIds && searchMatchIds.size > 0;
    if (hasSearchMatches) {
      const matchedMarkers = layout.markers.filter((marker) =>
        searchMatchIds.has(marker.id),
      );
      const previewMarkers = getSearchPreviewWindow(
        matchedMarkers,
        searchState.activeId,
        layout.height,
      );
      const rawTops = previewMarkers.map((marker) =>
        clamp(
          marker.topPct * layout.height,
          PREVIEW_VERTICAL_MARGIN_PX,
          Math.max(
            PREVIEW_VERTICAL_MARGIN_PX,
            layout.height - PREVIEW_VERTICAL_MARGIN_PX,
          ),
        ),
      );
      const crowded =
        previewMarkers.length > 1 &&
        (previewMarkers.length * PREVIEW_FULL_MIN_GAP_PX > layout.height ||
          rawTops.some(
            (top, index) =>
              index > 0 &&
              top - (rawTops[index - 1] ?? top) < PREVIEW_FULL_MIN_GAP_PX,
          ));
      const labels = previewMarkers.map((marker, index) => ({
        id: marker.id,
        topPx: rawTops[index] ?? PREVIEW_VERTICAL_MARGIN_PX,
        text:
          searchState.previewsById.get(marker.id) ??
          (marker.id === searchState.activeId ? searchState.preview : null) ??
          marker.preview,
        compact: crowded,
        active: marker.id === searchState.activeId,
      }));
      return spreadPreviewLabels(labels, layout.height, crowded);
    }

    const hoverPreviewMarker = previewId
      ? layout.markers.find((marker) => marker.id === previewId)
      : null;
    if (!hoverPreviewMarker) {
      return [];
    }

    return [
      {
        id: hoverPreviewMarker.id,
        topPx: clamp(
          hoverPreviewMarker.topPct * layout.height,
          PREVIEW_VERTICAL_MARGIN_PX,
          Math.max(
            PREVIEW_VERTICAL_MARGIN_PX,
            layout.height - PREVIEW_VERTICAL_MARGIN_PX,
          ),
        ),
        text: hoverPreviewMarker.preview,
        compact: false,
        active: false,
      },
    ];
  }, [layout, previewId, searchState]);

  if (!layout) {
    return null;
  }

  const activeMarkerId = searchState?.activeId ?? layout.activeId;
  const searchMatchIds = searchState?.matchIds;
  const hasSearchMatches = !!searchMatchIds && searchMatchIds.size > 0;
  const hasSingleSearchMatch = !!searchMatchIds && searchMatchIds.size === 1;
  const markersToRender = hasSearchMatches
    ? layout.markers.filter((marker) => searchMatchIds.has(marker.id))
    : layout.markers;
  const latestMarkerId = markersToRender[markersToRender.length - 1]?.id;

  return (
    <nav
      className="user-turn-nav"
      aria-label="Turn navigation"
      style={{
        top: `${layout.top}px`,
        right: `${layout.right}px`,
        height: `${layout.height}px`,
      }}
      onMouseLeave={() => setPreviewId(null)}
    >
      <div className="user-turn-nav-track">
        <div
          className="user-turn-nav-thumb"
          style={{
            top: `${layout.thumbTopPct * 100}%`,
            height: `${layout.thumbHeightPct * 100}%`,
          }}
        />
        {activeMotionCue && (
          <span
            key={activeMotionCue.token}
            className={[
              "user-turn-nav-motion-cue",
              `is-${activeMotionCue.direction}`,
            ].join(" ")}
            style={{ top: `${layout.thumbTopPct * 100}%` }}
          />
        )}
        {markersToRender.map((marker) => (
          <span key={marker.id}>
            <button
              type="button"
              className={[
                "user-turn-nav-marker",
                marker.id === activeMarkerId ? "is-active" : "",
                marker.id === latestMarkerId ? "is-latest" : "",
                hasSearchMatches && searchMatchIds.has(marker.id)
                  ? "is-search-match"
                  : "",
                hasSearchMatches && !searchMatchIds.has(marker.id)
                  ? "is-search-nonmatch"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ top: `${marker.topPct * 100}%` }}
              aria-label={`Jump to turn: ${marker.preview}`}
              title={marker.preview}
              onClick={() => handleJump(marker.id)}
              onFocus={() => setPreviewId(marker.id)}
              onBlur={() => setPreviewId(null)}
              onPointerEnter={() => setPreviewId(marker.id)}
              onPointerDown={() => setPreviewId(marker.id)}
            >
              <span className="user-turn-nav-marker-line" />
            </button>
            {onTrimAnchor && (
              <button
                type="button"
                className="user-turn-nav-trim-marker"
                style={{ top: `${marker.topPct * 100}%` }}
                aria-label={`Load client transcript from turn: ${marker.preview}`}
                title="Load client transcript from this turn"
                onClick={() => onTrimAnchor(marker.id)}
                onFocus={() => setPreviewId(marker.id)}
                onBlur={() => setPreviewId(null)}
                onPointerEnter={() => setPreviewId(marker.id)}
                onPointerDown={() => setPreviewId(marker.id)}
              >
                <span className="user-turn-nav-trim-dot" />
              </button>
            )}
          </span>
        ))}
        {previewLabels.map((label) => (
          <button
            key={
              hasSingleSearchMatch && searchState
                ? `${label.id}:${searchState.query}`
                : label.id
            }
            type="button"
            className={[
              "user-turn-nav-preview",
              hasSearchMatches ? "is-search-preview" : "",
              hasSingleSearchMatch ? "is-single-search-match" : "",
              label.compact ? "is-compact" : "",
              label.active ? "is-search-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ top: `${label.topPx}px` }}
            onClick={() => handleJump(label.id)}
          >
            {hasSearchMatches && searchState
              ? renderHighlightedText(label.text, searchState.query)
              : label.text}
          </button>
        ))}
      </div>
    </nav>
  );
});
