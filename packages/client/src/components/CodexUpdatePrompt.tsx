import { useEffect, useState } from "react";
import { useCodexUpdateStatus } from "../hooks/useCodexUpdateStatus";
import { useServerSettings } from "../hooks/useServerSettings";
import { Modal } from "./ui/Modal";

const STORAGE_KEY = "codex-update-seen-tag";

function readSeenTag(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeSeenTag(tag: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, tag);
  } catch {
    // Storage denied / full: prompt will reappear next session.
  }
}

export function CodexUpdatePrompt() {
  const { status, isInstalling, error, installOutput, install } =
    useCodexUpdateStatus();
  const { settings, updateSetting } = useServerSettings();
  const [seenTag, setSeenTag] = useState<string | null>(() => readSeenTag());
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [dismissedTag, setDismissedTag] = useState<string | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [installAttempted, setInstallAttempted] = useState(false);
  const [installSucceeded, setInstallSucceeded] = useState<boolean | null>(
    null,
  );
  const [policyError, setPolicyError] = useState<string | null>(null);

  const policy = settings?.codexUpdatePolicy ?? "notify";

  useEffect(() => {
    setSeenTag(readSeenTag());
  }, []);

  const latestTag = status?.latest ?? null;
  const shouldPrompt =
    policy === "notify" &&
    !!status &&
    status.updateAvailable &&
    status.updateMethod === "npm" &&
    !!latestTag &&
    latestTag !== seenTag &&
    latestTag !== dismissedTag;

  useEffect(() => {
    if (!shouldPrompt || !latestTag || activeTag === latestTag) {
      return;
    }
    setActiveTag(latestTag);
    setAutoUpdate(true);
    setInstallAttempted(false);
    setInstallSucceeded(null);
    setPolicyError(null);
  }, [activeTag, latestTag, shouldPrompt]);

  if (!activeTag || !status || !latestTag) {
    return null;
  }

  const close = ({ markSeen = false }: { markSeen?: boolean } = {}) => {
    if (markSeen) {
      writeSeenTag(activeTag);
      setSeenTag(activeTag);
    }
    setDismissedTag(activeTag);
    setActiveTag(null);
    setInstallAttempted(false);
    setInstallSucceeded(null);
    setPolicyError(null);
  };

  const handleModalClose = () => {
    if (isInstalling) {
      return;
    }
    close({ markSeen: installSucceeded !== false });
  };

  const handleUpdate = async () => {
    setInstallAttempted(false);
    setInstallSucceeded(null);
    setPolicyError(null);

    if (autoUpdate) {
      try {
        await updateSetting("codexUpdatePolicy", "auto");
      } catch {
        setPolicyError(
          "The auto-update preference could not be saved; future releases may still need manual confirmation.",
        );
      }
    }
    const ok = await install();
    setInstallAttempted(true);
    setInstallSucceeded(ok);
  };

  const handleNotNow = () => {
    close({ markSeen: true });
  };

  const installCommand =
    status.manualInstallCommand ??
    (status.installedPackage
      ? `npm install -g ${status.installedPackage}@latest`
      : null);
  const rawOutput =
    installOutput?.trim() ||
    (isInstalling
      ? "Running the Codex CLI update. Raw output will appear here when the command finishes."
      : installAttempted
        ? "(The update command did not produce stdout or stderr.)"
        : null);

  return (
    <Modal title="Codex CLI update available" onClose={handleModalClose}>
      <div className="settings-group codex-update-prompt">
        <p className="codex-update-prompt__summary">
          {installSucceeded ? (
            <>
              Codex CLI <strong>{status.installed ?? activeTag}</strong> is now
              installed.
            </>
          ) : (
            <>
              Codex {status.installed} → <strong>{status.latest}</strong> is
              ready to install.
            </>
          )}
        </p>

        {status.releaseUrl && (
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="settings-link codex-update-prompt__release-link"
          >
            Release notes
          </a>
        )}

        {installCommand && (
          <div className="codex-update-prompt__command-block">
            <span className="settings-hint">Yep Anywhere will run:</span>
            <code className="codex-update-prompt__command">
              {installCommand}
            </code>
          </div>
        )}

        <label className="codex-update-prompt__checkbox-label">
          <input
            type="checkbox"
            className="codex-update-prompt__checkbox"
            checked={autoUpdate}
            onChange={(e) => setAutoUpdate(e.target.checked)}
            disabled={isInstalling || installSucceeded === true}
          />
          <span>Update next versions too</span>
        </label>

        {isInstalling && (
          <p className="settings-hint codex-update-prompt__progress">
            Updating Codex CLI now. This dialog stays open so you can verify the
            command output.
          </p>
        )}

        {installAttempted && installSucceeded === true && (
          <p className="form-success">
            Codex updated successfully. Review the raw output below, then close
            this dialog.
          </p>
        )}

        {installAttempted && installSucceeded === false && error && (
          <p className="settings-warning">{error}</p>
        )}

        {policyError && <p className="settings-warning">{policyError}</p>}

        {(isInstalling || installAttempted) && rawOutput && (
          <div className="codex-update-prompt__output-block">
            <div className="codex-update-prompt__output-header">
              <strong className="codex-update-prompt__output-title">
                Raw output
              </strong>
              {installCommand && (
                <code className="codex-update-prompt__output-command">
                  {installCommand}
                </code>
              )}
            </div>
            <pre className="codex-update-prompt__output">{rawOutput}</pre>
          </div>
        )}

        <div className="codex-update-prompt__actions">
          {installSucceeded === true ? (
            <button
              type="button"
              className="settings-button"
              onClick={() => close({ markSeen: true })}
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                className="settings-button settings-button-secondary"
                onClick={
                  installAttempted
                    ? () => close()
                    : handleNotNow
                }
                disabled={isInstalling}
              >
                {installAttempted ? "Dismiss" : "Not now"}
              </button>
              <button
                type="button"
                className="settings-button"
                onClick={() => void handleUpdate()}
                disabled={isInstalling}
              >
                {isInstalling
                  ? "Installing…"
                  : installAttempted
                    ? "Retry update"
                    : "Update now"}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
