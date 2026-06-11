import { useCallback, useMemo, useState } from "react";
import type { RemoteExecutorTestResult } from "../../api/client";
import { useRemoteExecutors } from "../../hooks/useRemoteExecutors";
import { useI18n } from "../../i18n";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

interface ExecutorStatus {
  testing: boolean;
  result?: RemoteExecutorTestResult;
}

export function RemoteExecutorsSettings() {
  const { t } = useI18n();
  const { executors, loading, addExecutor, removeExecutor, testExecutor } =
    useRemoteExecutors();

  const [newHost, setNewHost] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [executorStatus, setExecutorStatus] = useState<
    Record<string, ExecutorStatus>
  >({});

  // Header undo reconciles the executor list back to the open-time set
  // (removes hosts added since, re-adds hosts removed since). Re-added hosts
  // may land at the end of the list rather than their original position.
  const undoState = useMemo(
    () => (loading ? null : { executors }),
    [loading, executors],
  );
  const restoreUndoState = useCallback(
    async (snapshot: NonNullable<typeof undoState>) => {
      const want = new Set(snapshot.executors);
      const have = new Set(executors);
      for (const host of executors) {
        if (!want.has(host)) await removeExecutor(host);
      }
      for (const host of snapshot.executors) {
        if (!have.has(host)) await addExecutor(host);
      }
      setAddError(null);
    },
    [executors, addExecutor, removeExecutor],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const handleAddExecutor = async () => {
    if (!newHost.trim() || isAdding) return;

    setIsAdding(true);
    setAddError(null);

    try {
      await addExecutor(newHost.trim());
      setNewHost("");
    } catch (err) {
      setAddError(
        err instanceof Error ? err.message : t("remoteExecutorsAddFailed"),
      );
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemoveExecutor = async (host: string) => {
    try {
      await removeExecutor(host);
      // Clear status for removed executor
      setExecutorStatus((prev) => {
        const { [host]: _, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      console.error("Failed to remove executor:", err);
    }
  };

  const handleTestExecutor = async (host: string) => {
    setExecutorStatus((prev) => ({
      ...prev,
      [host]: { testing: true },
    }));

    try {
      const result = await testExecutor(host);
      setExecutorStatus((prev) => ({
        ...prev,
        [host]: { testing: false, result },
      }));
    } catch (err) {
      setExecutorStatus((prev) => ({
        ...prev,
        [host]: {
          testing: false,
          result: {
            success: false,
            error:
              err instanceof Error
                ? err.message
                : t("remoteExecutorsConnectionFailed"),
          },
        },
      }));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddExecutor();
    }
  };

  return (
    <section className="settings-section">
      <h2>{t("remoteExecutorsTitle")}</h2>
      <p className="settings-section-description">
        {t("remoteExecutorsDescription")}
      </p>

      {/* Add new executor */}
      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("remoteExecutorsAddTitle")}</strong>
            <p>{t("remoteExecutorsAddDescription")}</p>
          </div>
          <div className="remote-executor-add">
            <input
              type="text"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("remoteExecutorsHostPlaceholder")}
              disabled={isAdding}
              className="remote-executor-input"
            />
            <button
              type="button"
              onClick={handleAddExecutor}
              disabled={!newHost.trim() || isAdding}
              className="remote-executor-add-button"
            >
              {isAdding ? t("remoteExecutorsAdding") : t("remoteExecutorsAdd")}
            </button>
          </div>
          {addError && <p className="settings-error">{addError}</p>}
        </div>
      </div>

      {/* Executor list */}
      <div className="settings-group">
        <h3>{t("remoteExecutorsConfigured")}</h3>
        {loading ? (
          <p className="settings-loading">{t("loginLoading")}</p>
        ) : executors.length === 0 ? (
          <p className="settings-empty">{t("remoteExecutorsEmpty")}</p>
        ) : (
          <div className="remote-executor-list">
            {executors.map((host) => {
              const status = executorStatus[host];
              return (
                <div key={host} className="remote-executor-item">
                  <div className="remote-executor-item-info">
                    <span className="remote-executor-host">{host}</span>
                    {status?.result && (
                      <span
                        className={`settings-status-badge ${status.result.success ? "settings-status-detected" : "settings-status-not-detected"}`}
                      >
                        {status.result.success
                          ? t("remoteExecutorsConnected")
                          : t("remoteExecutorsFailed")}
                      </span>
                    )}
                  </div>
                  {status?.result && !status.result.success && (
                    <p className="settings-error remote-executor-error">
                      {status.result.error}
                    </p>
                  )}
                  {status?.result?.success && (
                    <p className="remote-executor-details">
                      {status.result.claudeAvailable
                        ? status.result.claudeVersion
                          ? t("remoteExecutorsClaudeVersion", {
                              version: status.result.claudeVersion,
                            })
                          : t("remoteExecutorsClaudeAvailable")
                        : t("remoteExecutorsClaudeMissing")}
                    </p>
                  )}
                  <div className="remote-executor-actions">
                    <button
                      type="button"
                      onClick={() => handleTestExecutor(host)}
                      disabled={status?.testing}
                      className="remote-executor-test-button"
                    >
                      {status?.testing
                        ? t("remoteExecutorsTesting")
                        : t("remoteExecutorsTestConnection")}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveExecutor(host)}
                      className="remote-executor-remove-button"
                    >
                      {t("remoteExecutorsRemove")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Help text */}
      <div className="settings-group">
        <h3>{t("remoteExecutorsSetupRequirements")}</h3>
        <ul className="settings-requirements">
          <li>{t("remoteExecutorsRequirementSshConfig")}</li>
          <li>{t("remoteExecutorsRequirementKeyAuth")}</li>
          <li>{t("remoteExecutorsRequirementClaude")}</li>
          <li>{t("remoteExecutorsRequirementPaths")}</li>
        </ul>
      </div>
    </section>
  );
}
