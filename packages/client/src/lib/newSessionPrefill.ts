const NEW_SESSION_PREFILL_KEY = "new-session-prefill";

export function getNewSessionPrefill(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(NEW_SESSION_PREFILL_KEY);
}

export function clearNewSessionPrefill(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(NEW_SESSION_PREFILL_KEY);
}

export function setNewSessionPrefill(text: string): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(NEW_SESSION_PREFILL_KEY, text);
}
