export type SessionIsearchScope = "user" | "all";

export interface SessionIsearchGuideState {
  active: boolean;
  scope: SessionIsearchScope;
}

export const SESSION_ISEARCH_GUIDE_EVENT = "yepanywhere:session-isearch-guide";

export function dispatchSessionIsearchGuideState(
  detail: SessionIsearchGuideState,
) {
  window.dispatchEvent(
    new CustomEvent<SessionIsearchGuideState>(SESSION_ISEARCH_GUIDE_EVENT, {
      detail,
    }),
  );
}
