import { useEffect, useRef } from "react";
import { useInboxContext } from "../contexts/InboxContext";
import { useTabTitleActivityPreference } from "./useTabTitleActivityPreference";

// Regex to match and strip existing badge prefix like "(3) "
const BADGE_PREFIX_REGEX = /^\(\d+\)\s*/;
const ACTIVITY_PREFIX_REGEX = /^\((?:●|○|\*| )\)\s*/u;
const ACTIVITY_FRAMES = ["(●)", "(○)"] as const;
export const TAB_TITLE_ACTIVITY_CADENCE_MS = 1500;

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

export function getTabTitleActivityFrame(
  activityStartedAtMs: number,
  nowMs = Date.now(),
): string {
  const elapsedMs = Math.max(0, nowMs - activityStartedAtMs);
  const frameIndex =
    Math.floor(elapsedMs / TAB_TITLE_ACTIVITY_CADENCE_MS) %
    ACTIVITY_FRAMES.length;
  return ACTIVITY_FRAMES[frameIndex] ?? ACTIVITY_FRAMES[0];
}

/**
 * Hook that monitors the global inbox "needs attention" count and updates
 * the browser tab title with indicator prefixes like "(3)" and "(●)".
 *
 * This hook works independently of useDocumentTitle - it observes title changes
 * and prepends/updates indicators as needed.
 *
 * Uses InboxContext for data - no independent fetching.
 */
export function useNeedsAttentionBadge() {
  const activityStartedAtRef = useRef<number | null>(null);
  const { totalNeedsAttention: count, totalActive } = useInboxContext();
  const { tabTitleActivityEnabled } = useTabTitleActivityPreference();
  const showSessionActivity = tabTitleActivityEnabled && totalActive > 0;

  useEffect(() => {
    return () => {
      document.title = stripTabTitlePrefixes(document.title);
    };
  }, []);

  // Update document title when count or configured activity changes.
  useEffect(() => {
    if (showSessionActivity && activityStartedAtRef.current === null) {
      activityStartedAtRef.current = Date.now();
    } else if (!showSessionActivity) {
      activityStartedAtRef.current = null;
    }

    // Track if we're currently updating to avoid observer loop
    let isUpdating = false;
    let activityTimer: ReturnType<typeof setInterval> | null = null;

    const updateTitle = () => {
      isUpdating = true;
      // Strip existing indicator prefixes before composing the next title.
      const baseTitle = stripTabTitlePrefixes(document.title);
      const activityStartedAt = activityStartedAtRef.current;
      const activityFrame =
        showSessionActivity && activityStartedAt !== null
          ? getTabTitleActivityFrame(activityStartedAt)
          : undefined;

      document.title = composeTabTitle(baseTitle, count, activityFrame);
      // Use setTimeout to reset flag after current mutation cycle completes
      setTimeout(() => {
        isUpdating = false;
      }, 0);
    };

    updateTitle();

    if (showSessionActivity) {
      activityTimer = setInterval(() => {
        updateTitle();
      }, TAB_TITLE_ACTIVITY_CADENCE_MS);
    }

    // Also observe title changes from useDocumentTitle and re-apply indicators
    const observer = new MutationObserver(() => {
      // Skip if we're the ones who triggered the change
      if (isUpdating) return;

      // Check if the indicators need to be (re)applied
      const currentTitle = document.title;
      const baseTitle = stripTabTitlePrefixes(currentTitle);
      const activityStartedAt = activityStartedAtRef.current;
      const activityFrame =
        showSessionActivity && activityStartedAt !== null
          ? getTabTitleActivityFrame(activityStartedAt)
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
    };
  }, [count, showSessionActivity]);

  return count;
}
