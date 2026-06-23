import { useEffect, useState } from "react";
import { useI18n } from "../i18n";

// Backgrounded fork-after-summary job state. The generation step is a full
// LLM turn over the entire forked context (30+ s, worse cold-cache), so it
// runs detached from the composer with this persistent indicator instead of
// graying out the send button. See topics/fork-from-turn.md.
export type ForkSummaryJob = {
  status: "generating" | "ready" | "error";
  startedAt: number;
  /** App-relative session path, used for in-app navigation if needed. */
  targetUrl?: string;
  /** Absolute URL for the new-tab anchor (origin + base + path). */
  targetHref?: string;
  targetSessionId?: string;
  /** Display title (summary first line); also the follow-link label. */
  title?: string;
  /** Whether the post-completion window.open succeeded (usually popup-blocked
   * because it fires outside a user gesture — then the link is the path). */
  autoOpened?: boolean;
  error?: string;
};

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function ForkSummaryIndicator({
  job,
  onCancel,
  onDismiss,
}: {
  job: ForkSummaryJob;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (job.status !== "generating") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [job.status]);

  if (job.status === "generating") {
    return (
      <div
        className="fork-summary-indicator fork-summary-indicator-generating"
        role="status"
        aria-live="polite"
      >
        <span className="fork-summary-indicator-spinner" aria-hidden="true" />
        <span className="fork-summary-indicator-label">
          {t("forkSummaryProgress")}
        </span>
        <span className="fork-summary-indicator-elapsed">
          {formatElapsed(now - job.startedAt)}
        </span>
        <button
          type="button"
          className="fork-summary-indicator-cancel"
          onClick={onCancel}
        >
          {t("forkSummaryCancelInFlight")}
        </button>
      </div>
    );
  }

  if (job.status === "error") {
    return (
      <div className="fork-summary-indicator fork-summary-indicator-error" role="alert">
        <span className="fork-summary-indicator-label">
          {job.error
            ? `${t("forkSummaryFailed")}: ${job.error}`
            : t("forkSummaryFailed")}
        </span>
        <button
          type="button"
          className="fork-summary-indicator-dismiss"
          onClick={onDismiss}
          aria-label={t("forkSummaryDismiss")}
        >
          ×
        </button>
      </div>
    );
  }

  const title = job.title ?? t("forkSummaryReadyFallbackTitle");
  return (
    <div
      className="fork-summary-indicator fork-summary-indicator-ready"
      role="status"
      aria-live="polite"
    >
      <span className="fork-summary-indicator-label">
        {job.autoOpened
          ? t("forkSummaryOpenedNewTab")
          : t("forkSummaryReadyOpen")}
      </span>
      <a
        className="fork-summary-indicator-link"
        href={job.targetHref ?? job.targetUrl ?? "#"}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onDismiss}
        title={title}
      >
        {title} ↗
      </a>
      <button
        type="button"
        className="fork-summary-indicator-dismiss"
        onClick={onDismiss}
        aria-label={t("forkSummaryDismiss")}
      >
        ×
      </button>
    </div>
  );
}
