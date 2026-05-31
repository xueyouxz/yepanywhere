import { useCallback, useEffect, useState } from "react";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

const MAX_URL_LENGTH = 2000;
const MAX_TOKEN_LENGTH = 5000;

export function LifecycleWebhooksSettings() {
  const { t } = useI18n();
  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasDraftEdits, setHasDraftEdits] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const serverEnabled = settings?.lifecycleWebhooksEnabled ?? false;
  const serverUrl = settings?.lifecycleWebhookUrl ?? "";
  const serverToken = settings?.lifecycleWebhookToken ?? "";
  const serverDryRun = settings?.lifecycleWebhookDryRun ?? true;
  const normalizedUrl = url.trim();
  const normalizedToken = token.trim();
  const hasChanges =
    enabled !== serverEnabled ||
    normalizedUrl !== serverUrl ||
    normalizedToken !== serverToken ||
    dryRun !== serverDryRun;

  useEffect(() => {
    if (!settings) return;
    if (hasDraftEdits || isSaving) return;
    setEnabled(serverEnabled);
    setUrl(serverUrl);
    setToken(serverToken);
    setDryRun(serverDryRun);
  }, [
    hasDraftEdits,
    isSaving,
    serverDryRun,
    serverEnabled,
    serverToken,
    serverUrl,
    settings,
  ]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateSettings({
        lifecycleWebhooksEnabled: enabled,
        lifecycleWebhookUrl: normalizedUrl || undefined,
        lifecycleWebhookToken: normalizedToken || undefined,
        lifecycleWebhookDryRun: dryRun,
      });
      setEnabled(enabled);
      setUrl(normalizedUrl);
      setToken(normalizedToken);
      setDryRun(dryRun);
      setHasDraftEdits(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("lifecycleWebhooksSaveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [dryRun, enabled, normalizedToken, normalizedUrl, t, updateSettings]);

  if (isLoading) {
    return (
      <section className="settings-section">
        <h2>{t("lifecycleWebhooksTitle")}</h2>
        <p className="settings-section-description">
          {t("lifecycleWebhooksLoading")}
        </p>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h2>{t("lifecycleWebhooksTitle")}</h2>
      <p className="settings-section-description">
        {t("lifecycleWebhooksDescription")}
      </p>

      <div className="settings-group">
        <label className="settings-item">
          <div className="settings-item-info">
            <strong>{t("lifecycleWebhooksEnableTitle")}</strong>
            <p>{t("lifecycleWebhooksEnableDescription")}</p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              setHasDraftEdits(true);
              setSaveError(null);
            }}
          />
        </label>

        <div
          className="settings-item"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="settings-item-info">
            <strong>{t("lifecycleWebhooksUrlTitle")}</strong>
            <p>{t("lifecycleWebhooksUrlDescription")}</p>
          </div>
          <input
            aria-label={t("lifecycleWebhooksUrlTitle")}
            autoComplete="off"
            type="url"
            className="settings-input"
            id="lifecycle-webhook-url"
            name="yep-lifecycle-webhook-url"
            value={url}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_URL_LENGTH);
              setUrl(value);
              setHasDraftEdits(true);
              setSaveError(null);
            }}
            placeholder="https://example.com/hooks/yep"
            spellCheck={false}
          />
        </div>

        <div
          className="settings-item"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="settings-item-info">
            <strong>{t("lifecycleWebhooksTokenTitle")}</strong>
            <p>{t("lifecycleWebhooksTokenDescription")}</p>
          </div>
          <input
            aria-label={t("lifecycleWebhooksTokenTitle")}
            autoComplete="new-password"
            type="password"
            className="settings-input"
            id="lifecycle-webhook-token"
            name="yep-lifecycle-webhook-token"
            value={token}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_TOKEN_LENGTH);
              setToken(value);
              setHasDraftEdits(true);
              setSaveError(null);
            }}
            placeholder={t("lifecycleWebhooksTokenPlaceholder")}
            spellCheck={false}
          />
        </div>

        <label className="settings-item">
          <div className="settings-item-info">
            <strong>{t("lifecycleWebhooksDryRunTitle")}</strong>
            <p>{t("lifecycleWebhooksDryRunDescription")}</p>
          </div>
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => {
              setDryRun(e.target.checked);
              setHasDraftEdits(true);
              setSaveError(null);
            }}
          />
        </label>

        <div
          className="settings-item"
          style={{ justifyContent: "flex-end", gap: "var(--space-2)" }}
        >
          <button
            type="button"
            className="settings-button"
            disabled={!hasChanges || isSaving}
            onClick={handleSave}
          >
            {isSaving ? t("providersSaving") : t("providersSave")}
          </button>
        </div>

        {(saveError || error) && (
          <p className="settings-warning">{saveError || error}</p>
        )}
      </div>
    </section>
  );
}
