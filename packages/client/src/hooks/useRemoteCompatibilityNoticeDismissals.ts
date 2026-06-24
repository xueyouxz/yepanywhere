import { useCallback, useEffect, useMemo, useState } from "react";
import type { RemoteCompatibilityNotice } from "../lib/remoteCompatibilityNotices";

const DISMISSAL_EVENT = "yep-anywhere:remote-compatibility-dismissal-change";
export const REMOTE_COMPATIBILITY_REMINDER_SNOOZE_MS = 24 * 60 * 60 * 1000;
const LEGACY_PERMANENT_DISMISSAL_VALUE = "1";
const PERMANENT_DISMISSAL_VALUE = "dismissed";
const SNOOZE_UNTIL_PREFIX = "snooze-until:";

interface DismissalChangeDetail {
  keys: string[];
  action: "dismiss" | "snooze" | "restore";
}

function readSnoozed(keys: string[]): Set<string> {
  const snoozed = new Set<string>();
  const now = Date.now();
  for (const key of keys) {
    try {
      const value = window.localStorage.getItem(key);
      if (!value) {
        continue;
      }
      if (value === PERMANENT_DISMISSAL_VALUE) {
        const snoozeUntil = now + REMOTE_COMPATIBILITY_REMINDER_SNOOZE_MS;
        window.localStorage.setItem(
          key,
          `${SNOOZE_UNTIL_PREFIX}${snoozeUntil}`,
        );
        snoozed.add(key);
        continue;
      }
      if (value === LEGACY_PERMANENT_DISMISSAL_VALUE) {
        const snoozeUntil = now + REMOTE_COMPATIBILITY_REMINDER_SNOOZE_MS;
        window.localStorage.setItem(
          key,
          `${SNOOZE_UNTIL_PREFIX}${snoozeUntil}`,
        );
        snoozed.add(key);
        continue;
      }
      if (value.startsWith(SNOOZE_UNTIL_PREFIX)) {
        const snoozeUntil = Number(value.slice(SNOOZE_UNTIL_PREFIX.length));
        if (Number.isFinite(snoozeUntil) && snoozeUntil > now) {
          snoozed.add(key);
        } else {
          window.localStorage.removeItem(key);
        }
      }
    } catch {
      // Storage denied / unavailable: notice remains visible.
    }
  }
  return snoozed;
}

function getNextSnoozeExpiry(keys: string[]): number | null {
  const now = Date.now();
  let nextExpiry: number | null = null;
  for (const key of keys) {
    try {
      const value = window.localStorage.getItem(key);
      if (!value?.startsWith(SNOOZE_UNTIL_PREFIX)) continue;
      const snoozeUntil = Number(value.slice(SNOOZE_UNTIL_PREFIX.length));
      if (!Number.isFinite(snoozeUntil) || snoozeUntil <= now) continue;
      nextExpiry =
        nextExpiry === null ? snoozeUntil : Math.min(nextExpiry, snoozeUntil);
    } catch {
      // Storage denied / unavailable: there is no expiry to schedule.
    }
  }
  return nextExpiry;
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
  emitDismissalChange({ keys, action: "restore" });
}

export function useRemoteCompatibilityNoticeDismissals(
  notices: RemoteCompatibilityNotice[],
) {
  const keys = useMemo(
    () => notices.map((notice) => notice.dismissKey),
    [notices],
  );
  const [sessionDismissed, setSessionDismissed] = useState<Set<string>>(
    () => new Set(),
  );
  const [snoozed, setSnoozed] = useState<Set<string>>(() => readSnoozed(keys));

  useEffect(() => {
    setSessionDismissed(
      (current) => new Set([...current].filter((key) => keys.includes(key))),
    );
    setSnoozed(readSnoozed(keys));
  }, [keys]);

  useEffect(() => {
    const nextExpiry = getNextSnoozeExpiry(keys);
    if (nextExpiry === null) return;
    const delay = Math.max(0, nextExpiry - Date.now());
    const timer = setTimeout(() => {
      setSnoozed(readSnoozed(keys));
    }, delay);
    return () => clearTimeout(timer);
  }, [keys, snoozed]);

  useEffect(() => {
    const handleDismissalChange = (event: Event) => {
      const detail = (event as CustomEvent<DismissalChangeDetail>).detail;
      if (!detail?.keys?.length) return;
      setSessionDismissed((current) => {
        const next = new Set(current);
        for (const key of detail.keys) {
          if (!keys.includes(key)) continue;
          if (detail.action === "dismiss") {
            next.add(key);
          } else if (detail.action === "restore") {
            next.delete(key);
          }
        }
        return next;
      });
      setSnoozed((current) => {
        const next = new Set(current);
        for (const key of detail.keys) {
          if (!keys.includes(key)) continue;
          if (detail.action === "snooze") {
            next.add(key);
          } else if (detail.action === "restore") {
            next.delete(key);
          }
        }
        return next;
      });
    };

    const handleStorageChange = () => {
      setSnoozed(readSnoozed(keys));
    };

    window.addEventListener(DISMISSAL_EVENT, handleDismissalChange);
    window.addEventListener("storage", handleStorageChange);
    return () => {
      window.removeEventListener(DISMISSAL_EVENT, handleDismissalChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [keys]);

  const visibleNotices = useMemo(
    () =>
      notices.filter(
        (notice) =>
          !sessionDismissed.has(notice.dismissKey) &&
          !snoozed.has(notice.dismissKey),
      ),
    [notices, sessionDismissed, snoozed],
  );

  const dismissedNotices = useMemo(
    () =>
      notices.filter(
        (notice) =>
          sessionDismissed.has(notice.dismissKey) ||
          snoozed.has(notice.dismissKey),
      ),
    [notices, sessionDismissed, snoozed],
  );

  const dismissNotice = useCallback((notice: RemoteCompatibilityNotice) => {
    setSessionDismissed((current) => new Set([...current, notice.dismissKey]));
    emitDismissalChange({ keys: [notice.dismissKey], action: "dismiss" });
  }, []);

  const snoozeNotice = useCallback((notice: RemoteCompatibilityNotice) => {
    const value = `${SNOOZE_UNTIL_PREFIX}${
      Date.now() + REMOTE_COMPATIBILITY_REMINDER_SNOOZE_MS
    }`;
    try {
      window.localStorage.setItem(notice.dismissKey, value);
    } catch {
      // Keep same-session dismissal even if persistence fails.
    }
    setSnoozed((current) => new Set([...current, notice.dismissKey]));
    emitDismissalChange({ keys: [notice.dismissKey], action: "snooze" });
  }, []);

  const restoreNotices = useCallback(
    (noticesToRestore: RemoteCompatibilityNotice[]) => {
      restoreRemoteCompatibilityNoticeDismissals(noticesToRestore);
    },
    [],
  );

  return {
    dismissNotice,
    dismissedNotices,
    restoreNotices,
    snoozeNotice,
    visibleNotices,
  };
}
