import { useEffect } from "react";
import { useInboxContext } from "../contexts/InboxContext";
import { useTabTitleActivityPreference } from "./useTabTitleActivityPreference";

// Regex to match and strip existing badge prefix like "(3) "
const BADGE_PREFIX_REGEX = /^\(\d+\)\s*/;
const ACTIVITY_PREFIX_REGEX = /^\((?:\*| )\)\s*/;
const ACTIVITY_FRAMES = ["(*)", "( )"] as const;

export function stripTabTitlePrefixes(title: string): string {
  let next = title;
  for (;;) {
    const stripped = next
      .replace(BADGE_PREFIX_REGEX, "")
      .replace(ACTIVITY_PREFIX_REGEX, "");
    if (stripped === next) {
      return next;
    }
    next = stripped;
  }
}

export function composeTabTitle(
  baseTitle: string,
  count: number,
  activityFrame?: string,
): string {
  const prefixes: string[] = [];
  if (count > 0) {
    prefixes.push(`(${count})`);
  }
  if (activityFrame) {
    prefixes.push(activityFrame);
  }
  return prefixes.length > 0 ? `${prefixes.join(" ")} ${baseTitle}` : baseTitle;
}

/**
 * Hook that monitors the global inbox "needs attention" count and updates
 * the browser tab title with indicator prefixes like "(3)" and "(*)".
 *
 * This hook works independently of useDocumentTitle - it observes title changes
 * and prepends/updates indicators as needed.
 *
 * Uses InboxContext for data - no independent fetching.
 */
export function useNeedsAttentionBadge() {
  const { totalNeedsAttention: count, totalActive } = useInboxContext();
  const { tabTitleActivityEnabled, tabTitleActivityScope } =
    useTabTitleActivityPreference();
  const showAllSessionActivity =
    tabTitleActivityEnabled &&
    tabTitleActivityScope === "all" &&
    totalActive > 0;

  // Update document title when count or configured activity changes.
  useEffect(() => {
    // Track if we're currently updating to avoid observer loop
    let isUpdating = false;
    let activityFrameIndex = 0;
    let activityTimer: ReturnType<typeof setInterval> | null = null;

    const updateTitle = () => {
      isUpdating = true;
      // Strip existing indicator prefixes before composing the next title.
      const baseTitle = stripTabTitlePrefixes(document.title);
      const activityFrame = showAllSessionActivity
        ? ACTIVITY_FRAMES[activityFrameIndex]
        : undefined;

      document.title = composeTabTitle(baseTitle, count, activityFrame);
      // Use setTimeout to reset flag after current mutation cycle completes
      setTimeout(() => {
        isUpdating = false;
      }, 0);
    };

    updateTitle();

    if (showAllSessionActivity) {
      activityTimer = setInterval(() => {
        activityFrameIndex = (activityFrameIndex + 1) % ACTIVITY_FRAMES.length;
        updateTitle();
      }, 1000);
    }

    // Also observe title changes from useDocumentTitle and re-apply indicators
    const observer = new MutationObserver(() => {
      // Skip if we're the ones who triggered the change
      if (isUpdating) return;

      // Check if the indicators need to be (re)applied
      const currentTitle = document.title;
      const baseTitle = stripTabTitlePrefixes(currentTitle);
      const activityFrame = showAllSessionActivity
        ? ACTIVITY_FRAMES[activityFrameIndex]
        : undefined;
      const expectedTitle = composeTabTitle(baseTitle, count, activityFrame);

      if (currentTitle !== expectedTitle) {
        updateTitle();
      }
    });

    const titleElement = document.querySelector("title");
    if (titleElement) {
      observer.observe(titleElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    return () => {
      observer.disconnect();
      if (activityTimer) {
        clearInterval(activityTimer);
      }
      // Clean up title indicators on unmount.
      document.title = stripTabTitlePrefixes(document.title);
    };
  }, [count, showAllSessionActivity]);

  return count;
}
