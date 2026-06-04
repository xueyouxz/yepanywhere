import { useMemo } from "react";
import type { VersionInfo } from "../api/client";
import { useRemoteCompatibilityNoticeDismissals } from "../hooks/useRemoteCompatibilityNoticeDismissals";
import {
  type RemoteCompatibilityNotice,
  getRemoteCompatibilityNotices,
} from "../lib/remoteCompatibilityNotices";
import { CopyTextButton } from "./ui/CopyTextButton";

interface RemoteCompatibilityNoticesProps {
  versionInfo: VersionInfo | null;
  relayUsername: string | null;
  installId?: string | null;
}

export function RemoteCompatibilityNotices({
  versionInfo,
  relayUsername,
  installId,
}: RemoteCompatibilityNoticesProps) {
  const notices = useMemo(
    () =>
      getRemoteCompatibilityNotices({
        currentVersion: versionInfo?.current ?? null,
        latestVersion: versionInfo?.latest ?? null,
        updateAvailable: versionInfo?.updateAvailable ?? false,
        installSource: versionInfo?.installSource,
        resumeProtocolVersion: versionInfo?.resumeProtocolVersion,
        capabilities: versionInfo?.capabilities,
        relayUsername,
        installId,
      }),
    [installId, relayUsername, versionInfo],
  );
  const { dismissNotice, visibleNotices } =
    useRemoteCompatibilityNoticeDismissals(notices);

  const notice = visibleNotices[0];
  if (!notice) return null;

  return (
    <RemoteCompatibilityNoticeCard
      notice={notice}
      noticeCount={visibleNotices.length}
      placement="floating"
      onDismiss={() => dismissNotice(notice)}
    />
  );
}

interface RemoteCompatibilityNoticeCardProps {
  notice: RemoteCompatibilityNotice;
  noticeCount?: number;
  placement: "floating" | "inline";
  onDismiss?: () => void;
  onRestore?: () => void;
}

export function RemoteCompatibilityNoticeCard({
  notice,
  noticeCount = 1,
  placement,
  onDismiss,
  onRestore,
}: RemoteCompatibilityNoticeCardProps) {
  const action = notice.action;
  const dismissLabel =
    notice.severity === "info" ? "Dismiss" : "Remind me later";
  const commandField = action?.command
    ? {
        command: action.command,
        label: action.label,
        lines: action.command.split("\n").length,
      }
    : null;

  return (
    <section
      className={`remote-compatibility-notice remote-compatibility-notice--${placement} remote-compatibility-notice--${notice.severity}`}
      role={
        notice.severity === "security" || notice.severity === "blocking"
          ? "alert"
          : "status"
      }
      data-testid="remote-compatibility-notice"
    >
      <div className="remote-compatibility-notice__content">
        <div className="remote-compatibility-notice__headline">
          <strong className="remote-compatibility-notice__title">
            {notice.title}
          </strong>
          {notice.versionSummary && (
            <span className="remote-compatibility-notice__meta">
              {notice.versionSummary}
            </span>
          )}
          {noticeCount > 1 && (
            <span className="remote-compatibility-notice__count">
              {noticeCount} notices
            </span>
          )}
        </div>
        <span className="remote-compatibility-notice__body">{notice.body}</span>
        {notice.guidance && (
          <span className="remote-compatibility-notice__guidance">
            {notice.guidance}
          </span>
        )}
        {commandField && (
          <div className="remote-compatibility-notice__command-field">
            {commandField.lines > 1 ? (
              <textarea
                className="remote-compatibility-notice__command-input remote-compatibility-notice__command-input--multi"
                value={commandField.command}
                readOnly
                rows={Math.min(commandField.lines, 4)}
                aria-label={`${commandField.label} text`}
                onFocus={(event) => event.currentTarget.select()}
              />
            ) : (
              <input
                className="remote-compatibility-notice__command-input"
                value={commandField.command}
                readOnly
                aria-label={`${commandField.label} text`}
                onFocus={(event) => event.currentTarget.select()}
              />
            )}
            <CopyTextButton
              text={commandField.command}
              label={commandField.label}
              copiedLabel="Copied"
              className="remote-compatibility-notice__copy-button"
              copiedClassName="is-copied"
            />
          </div>
        )}
      </div>
      <div className="remote-compatibility-notice__actions">
        {notice.action?.href && (
          <a
            className="remote-compatibility-notice__button remote-compatibility-notice__button-primary"
            href={notice.action.href}
          >
            {notice.action.label}
          </a>
        )}
        {onRestore && (
          <button
            type="button"
            className="remote-compatibility-notice__button remote-compatibility-notice__button-primary"
            onClick={onRestore}
          >
            Show reminder
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            className="remote-compatibility-notice__button"
            onClick={onDismiss}
          >
            {dismissLabel}
          </button>
        )}
      </div>
    </section>
  );
}
