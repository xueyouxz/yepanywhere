import { useCallback, useEffect, useMemo, useState } from "react";
import type { RemoteCompatibilityNotice } from "../lib/remoteCompatibilityNotices";

const DISMISSAL_EVENT = "yep-anywhere:remote-compatibility-dismissal-change";

interface DismissalChangeDetail {
  keys: string[];
  dismissed: boolean;
}

function readDismissed(keys: string[]): Set<string> {
  const dismissed = new Set<string>();
  for (const key of keys) {
    try {
      if (window.localStorage.getItem(key) === "1") {
        dismissed.add(key);
      }
    } catch {
      // Storage denied / unavailable: notice remains visible.
    }
  }
  return dismissed;
}

function emitDismissalChange(detail: DismissalChangeDetail) {
  window.dispatchEvent(new CustomEvent(DISMISSAL_EVENT, { detail }));
}

export function restoreRemoteCompatibilityNoticeDismissals(
  notices: RemoteCompatibilityNotice[],
) {
  const keys = notices.map((notice) => notice.dismissKey);
  if (keys.length === 0) return;
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage denied / unavailable: still notify same-tab listeners.
    }
  }
  emitDismissalChange({ keys, dismissed: false });
}

export function useRemoteCompatibilityNoticeDismissals(
  notices: RemoteCompatibilityNotice[],
) {
  const keys = useMemo(
    () => notices.map((notice) => notice.dismissKey),
    [notices],
  );
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    readDismissed(keys),
  );

  useEffect(() => {
    setDismissed((current) => new Set([...current, ...readDismissed(keys)]));
  }, [keys]);

  useEffect(() => {
    const handleDismissalChange = (event: Event) => {
      const detail = (event as CustomEvent<DismissalChangeDetail>).detail;
      if (!detail?.keys?.length) return;
      setDismissed((current) => {
        const next = new Set(current);
        for (const key of detail.keys) {
          if (!keys.includes(key)) continue;
          if (detail.dismissed) {
            next.add(key);
          } else {
            next.delete(key);
          }
        }
        return next;
      });
    };

    const handleStorageChange = () => {
      setDismissed(readDismissed(keys));
    };

    window.addEventListener(DISMISSAL_EVENT, handleDismissalChange);
    window.addEventListener("storage", handleStorageChange);
    return () => {
      window.removeEventListener(DISMISSAL_EVENT, handleDismissalChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [keys]);

  const visibleNotices = useMemo(
    () => notices.filter((notice) => !dismissed.has(notice.dismissKey)),
    [dismissed, notices],
  );

  const dismissedNotices = useMemo(
    () => notices.filter((notice) => dismissed.has(notice.dismissKey)),
    [dismissed, notices],
  );

  const dismissNotice = useCallback((notice: RemoteCompatibilityNotice) => {
    try {
      window.localStorage.setItem(notice.dismissKey, "1");
    } catch {
      // Keep same-session dismissal even if persistence fails.
    }
    setDismissed((current) => new Set([...current, notice.dismissKey]));
    emitDismissalChange({ keys: [notice.dismissKey], dismissed: true });
  }, []);

  const restoreNotices = useCallback(
    (noticesToRestore: RemoteCompatibilityNotice[]) => {
      restoreRemoteCompatibilityNoticeDismissals(noticesToRestore);
    },
    [],
  );

  return { dismissNotice, dismissedNotices, restoreNotices, visibleNotices };
}
