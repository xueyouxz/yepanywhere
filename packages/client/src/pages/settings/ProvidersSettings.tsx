import { useCallback, useEffect, useId, useState } from "react";
import {
  type HelperTargetConfig,
  type ModelInfo,
} from "@yep-anywhere/shared";
import { api, type ServerSettings } from "../../api/client";
import { useToastContext } from "../../contexts/ToastContext";
import { useCodexUpdateStatus } from "../../hooks/useCodexUpdateStatus";
import { useProviders } from "../../hooks/useProviders";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import {
  helperTargetDescription,
  helperTargetValue,
} from "../../lib/helperTargets";
import { getAllProviders } from "../../providers/registry";

const DEFAULT_OLLAMA_SYSTEM_PROMPT =
  "You are a helpful coding assistant. You help users with software engineering tasks. You have access to tools for reading files, editing files, running shell commands, and searching code. Use tools when needed to answer questions or make changes. Be concise and direct.";

interface HelperTargetDraft {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
}

type UpdateServerSetting = <K extends keyof ServerSettings>(
  key: K,
  value: ServerSettings[K],
) => Promise<void>;

interface HelperTargetsSettingsProps {
  settings: ServerSettings | null;
  updateSetting: UpdateServerSetting;
}

const DEFAULT_HELPER_TARGET_DRAFT: HelperTargetDraft = {
  name: "Local vLLM",
  baseUrl: "http://localhost:8001/v1",
  model: "",
};

function createHelperTargetId(
  name: string,
  targets: readonly HelperTargetConfig[],
): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "helper-target";
  const existingIds = new Set(targets.map((target) => target.id));
  if (!existingIds.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existingIds.has(candidate)) return candidate;
  }

  return `${base}-${Date.now().toString(36)}`;
}

function draftFromTarget(target: HelperTargetConfig): HelperTargetDraft {
  return {
    id: target.id,
    name: target.name,
    baseUrl: target.baseUrl,
    model: target.model ?? "",
  };
}

function targetFromDraft(
  draft: HelperTargetDraft,
  targets: readonly HelperTargetConfig[],
): HelperTargetConfig {
  const name = draft.name.trim();
  const model = draft.model.trim();
  return {
    id: draft.id ?? createHelperTargetId(name, targets),
    name,
    kind: "openai-compatible",
    baseUrl: draft.baseUrl.trim(),
    ...(model ? { model } : {}),
  };
}

function mergeModelOptions(
  selectedModel: string,
  discoveredModels: readonly ModelInfo[],
): ModelInfo[] {
  if (
    selectedModel &&
    !discoveredModels.some((model) => model.id === selectedModel)
  ) {
    return [{ id: selectedModel, name: selectedModel }, ...discoveredModels];
  }
  return [...discoveredModels];
}

function HelperTargetsSettings({
  settings,
  updateSetting,
}: HelperTargetsSettingsProps) {
  const { t } = useI18n();
  const targets = settings?.helperTargets ?? [];
  const [draft, setDraft] = useState<HelperTargetDraft>(
    DEFAULT_HELPER_TARGET_DRAFT,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<ModelInfo[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modelFieldId = useId();

  const resetDraft = useCallback(() => {
    setDraft(DEFAULT_HELPER_TARGET_DRAFT);
    setEditingId(null);
    setDiscoveredModels([]);
    setMessage(null);
    setError(null);
  }, []);

  const beginEdit = useCallback((target: HelperTargetConfig) => {
    setDraft(draftFromTarget(target));
    setEditingId(target.id);
    setDiscoveredModels(
      target.model ? [{ id: target.model, name: target.model }] : [],
    );
    setMessage(null);
    setError(null);
  }, []);

  const deleteTarget = useCallback(
    async (targetId: string) => {
      setIsSaving(true);
      setError(null);
      try {
        await updateSetting(
          "helperTargets",
          targets.filter((target) => target.id !== targetId),
        );
        if (editingId === targetId) {
          resetDraft();
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t("helperTargetsSaveError"),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [editingId, resetDraft, t, targets, updateSetting],
  );

  const discoverModels = useCallback(async () => {
    setIsDiscovering(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.discoverHelperTargetModels(draft.baseUrl);
      setDraft((prev) => ({ ...prev, baseUrl: result.baseUrl }));
      setDiscoveredModels(result.models);
      setMessage(
        t("helperTargetsDiscovered", {
          count: String(result.models.length),
        }),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("helperTargetsLoadError"),
      );
    } finally {
      setIsDiscovering(false);
    }
  }, [draft.baseUrl, t]);

  const saveTarget = useCallback(async () => {
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      setError(t("helperTargetsInvalid"));
      return;
    }

    const nextTarget = targetFromDraft(draft, targets);
    const nextTargets = editingId
      ? targets.map((target) => (target.id === editingId ? nextTarget : target))
      : [...targets, nextTarget];

    setIsSaving(true);
    setError(null);
    try {
      await updateSetting("helperTargets", nextTargets);
      resetDraft();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("helperTargetsSaveError"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [draft, editingId, resetDraft, t, targets, updateSetting]);

  const modelOptions = mergeModelOptions(draft.model, discoveredModels);

  return (
    <div className="settings-item helper-targets-settings">
      <div className="settings-item-info">
        <strong>{t("helperTargetsTitle")}</strong>
        <p>{t("helperTargetsDescription")}</p>
        <p className="settings-hint">{t("helperTargetsRuntimeNote")}</p>
      </div>

      <div className="helper-targets-panel">
        {targets.length === 0 ? (
          <p className="settings-hint">{t("helperTargetsEmpty")}</p>
        ) : (
          <div className="helper-target-list">
            {targets.map((target) => (
              <div key={target.id} className="helper-target-row">
                <div className="helper-target-row-main">
                  <strong>{target.name}</strong>
                  <span>{helperTargetDescription(target)}</span>
                  <code>
                    {t("helperTargetsIdPrefix")} {helperTargetValue(target)}
                  </code>
                </div>
                <div className="helper-target-row-actions">
                  <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() => beginEdit(target)}
                    disabled={isSaving}
                  >
                    {t("helperTargetsEdit")}
                  </button>
                  <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() => void deleteTarget(target.id)}
                    disabled={isSaving}
                  >
                    {t("helperTargetsDelete")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="helper-target-editor">
          <label>
            <span>{t("helperTargetsNameLabel")}</span>
            <input
              type="text"
              className="settings-input"
              value={draft.name}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, name: event.target.value }))
              }
            />
          </label>
          <label>
            <span>{t("helperTargetsBaseUrlLabel")}</span>
            <input
              type="text"
              className="settings-input"
              value={draft.baseUrl}
              placeholder={t("helperTargetsBaseUrlPlaceholder")}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))
              }
            />
          </label>
          <label htmlFor={modelFieldId}>
            <span>{t("helperTargetsModelLabel")}</span>
            {modelOptions.length > 0 ? (
              <select
                id={modelFieldId}
                className="settings-select"
                value={draft.model}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    model: event.target.value,
                  }))
                }
              >
                <option value="">{t("helperTargetsModelDefault")}</option>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={modelFieldId}
                type="text"
                className="settings-input"
                value={draft.model}
                placeholder={t("helperTargetsModelPlaceholder")}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    model: event.target.value,
                  }))
                }
              />
            )}
          </label>
        </div>

        <div className="helper-target-actions">
          <button
            type="button"
            className="settings-button settings-button-secondary"
            onClick={() => void discoverModels()}
            disabled={isDiscovering || !draft.baseUrl.trim()}
          >
            {isDiscovering
              ? t("helperTargetsDiscovering")
              : t("helperTargetsDiscover")}
          </button>
          {editingId && (
            <button
              type="button"
              className="settings-button settings-button-secondary"
              onClick={resetDraft}
              disabled={isSaving}
            >
              {t("helperTargetsCancelEdit")}
            </button>
          )}
          <button
            type="button"
            className="settings-button"
            onClick={() => void saveTarget()}
            disabled={isSaving}
          >
            {isSaving
              ? t("providersSaving")
              : editingId
                ? t("helperTargetsSave")
                : t("helperTargetsAdd")}
          </button>
        </div>

        {message && <p className="settings-hint">{message}</p>}
        {error && <p className="settings-warning">{error}</p>}
      </div>
    </div>
  );
}

function OllamaUrlInput() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const [url, setUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const serverValue = settings?.ollamaUrl ?? "";

  useEffect(() => {
    if (settings) {
      setUrl(settings.ollamaUrl ?? "");
    }
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await updateSetting("ollamaUrl", url.trim() || undefined);
      setHasChanges(false);
    } catch {
      // Error handled by useServerSettings
    } finally {
      setIsSaving(false);
    }
  }, [url, updateSetting]);

  return (
    <div style={{ marginTop: "var(--space-2)", width: "100%" }}>
      <div
        style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}
      >
        <input
          type="text"
          className="settings-input"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setHasChanges(e.target.value !== serverValue);
          }}
          placeholder="http://localhost:11434"
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="settings-button"
          disabled={!hasChanges || isSaving}
          onClick={handleSave}
        >
          {isSaving ? t("providersSaving") : t("providersSave")}
        </button>
      </div>
      <span className="settings-hint">{t("providersOllamaUrlHint")}</span>
    </div>
  );
}

function OllamaUseFullSystemPrompt() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const enabled = settings?.ollamaUseFullSystemPrompt ?? false;

  return (
    <label
      style={{
        display: "flex",
        gap: "var(--space-2)",
        alignItems: "center",
        marginTop: "var(--space-2)",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) =>
          updateSetting("ollamaUseFullSystemPrompt", e.target.checked)
        }
      />
      <span>{t("providersUseFullPrompt")}</span>
      <span className="settings-hint" style={{ marginLeft: "auto" }}>
        {t("providersUseFullPromptHint")}
      </span>
    </label>
  );
}

function OllamaSystemPromptInput() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const [prompt, setPrompt] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const serverValue = settings?.ollamaSystemPrompt ?? "";

  useEffect(() => {
    if (settings) {
      setPrompt(settings.ollamaSystemPrompt ?? "");
    }
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await updateSetting("ollamaSystemPrompt", prompt.trim() || undefined);
      setHasChanges(false);
    } catch {
      // Error handled by useServerSettings
    } finally {
      setIsSaving(false);
    }
  }, [prompt, updateSetting]);

  return (
    <div style={{ marginTop: "var(--space-2)", width: "100%" }}>
      <textarea
        className="settings-textarea"
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          setHasChanges(e.target.value !== serverValue);
        }}
        placeholder={DEFAULT_OLLAMA_SYSTEM_PROMPT}
        rows={4}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "var(--space-2)",
        }}
      >
        <span className="settings-hint">{t("providersOllamaPromptHint")}</span>
        <button
          type="button"
          className="settings-button"
          disabled={!hasChanges || isSaving}
          onClick={handleSave}
        >
          {isSaving ? t("providersSaving") : t("providersSave")}
        </button>
      </div>
    </div>
  );
}

function GrokBuildApiKeySettings() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const enabled = settings?.grokBuildUseXaiApiKey ?? false;

  return (
    <label
      style={{
        display: "flex",
        gap: "var(--space-2)",
        alignItems: "flex-start",
        marginTop: "var(--space-2)",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(event) =>
          updateSetting("grokBuildUseXaiApiKey", event.target.checked)
        }
        style={{ marginTop: "0.2rem" }}
      />
      <span>
        <span>{t("providersGrokUseXaiApiKey")}</span>
        <span className="settings-hint" style={{ display: "block" }}>
          {t("providersGrokUseXaiApiKeyHint")}
        </span>
      </span>
    </label>
  );
}

function CodexUpdatePanel() {
  const { showToast } = useToastContext();
  const { settings, updateSetting } = useServerSettings();
  const {
    status,
    isChecking,
    isInstalling,
    error,
    installOutput,
    refresh,
    install,
  } = useCodexUpdateStatus();

  const policy = settings?.codexUpdatePolicy ?? "notify";
  const canAuto = status?.updateMethod === "npm";

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast("Command copied", "success");
      } catch {
        showToast("Copy failed", "error");
      }
    },
    [showToast],
  );

  if (!status?.installed || !status.latest) {
    return null;
  }

  const updateAvailable = status.updateAvailable;

  return (
    <div style={{ marginTop: "var(--space-2)", width: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {updateAvailable ? (
          <span>
            <strong>Update available:</strong> {status.installed} →{" "}
            {status.latest}
          </span>
        ) : (
          <span className="settings-hint">
            Codex CLI {status.installed} is up to date
          </span>
        )}
        <button
          type="button"
          className="settings-button"
          onClick={() => void refresh(true)}
          disabled={isChecking}
          style={{ marginLeft: "auto" }}
        >
          {isChecking ? "Checking…" : "Check now"}
        </button>
        {status.releaseUrl && updateAvailable && (
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="settings-link"
          >
            Release notes
          </a>
        )}
      </div>

      {updateAvailable && (
        <div
          style={{
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "center",
            marginTop: "var(--space-2)",
            flexWrap: "wrap",
          }}
        >
          {status.updateMethod === "npm" ? (
            <button
              type="button"
              className="settings-button"
              onClick={() => void install()}
              disabled={isInstalling}
            >
              {isInstalling ? "Installing…" : "Update now"}
            </button>
          ) : (
            <span className="settings-hint">Update with your installer:</span>
          )}
          {status.manualInstallCommand && (
            <>
              <code
                style={{
                  padding: "2px 6px",
                  background: "var(--color-surface-raised, #f5f5f5)",
                  borderRadius: 4,
                  fontSize: "0.85em",
                }}
              >
                {status.manualInstallCommand}
              </code>
              <button
                type="button"
                className="settings-button"
                onClick={() => void copy(status.manualInstallCommand ?? "")}
              >
                Copy
              </button>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="settings-hint" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      )}
      {installOutput && (
        <details style={{ marginTop: "var(--space-2)" }}>
          <summary className="settings-hint">Install output</summary>
          <pre
            style={{
              fontSize: "0.8em",
              whiteSpace: "pre-wrap",
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {installOutput}
          </pre>
        </details>
      )}

      <fieldset
        style={{
          border: "none",
          padding: 0,
          marginTop: "var(--space-3)",
          display: "flex",
          gap: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <legend className="settings-hint" style={{ marginBottom: 4 }}>
          Update policy
        </legend>
        {(["auto", "notify", "off"] as const).map((value) => {
          const disabled = value === "auto" && !canAuto;
          return (
            <label
              key={value}
              style={{
                display: "inline-flex",
                gap: 4,
                alignItems: "center",
                opacity: disabled ? 0.55 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
              title={
                disabled ? "Auto requires an npm-global install" : undefined
              }
            >
              <input
                type="radio"
                name="codex-update-policy"
                value={value}
                checked={policy === value}
                disabled={disabled}
                onChange={() => void updateSetting("codexUpdatePolicy", value)}
              />
              <span>
                {value === "auto"
                  ? "Auto"
                  : value === "notify"
                    ? "Notify me"
                    : "Off"}
              </span>
            </label>
          );
        })}
      </fieldset>
    </div>
  );
}

function OllamaSettings() {
  const { settings } = useServerSettings();
  const useFullPrompt = settings?.ollamaUseFullSystemPrompt ?? false;

  return (
    <>
      <OllamaUrlInput />
      <OllamaUseFullSystemPrompt />
      {!useFullPrompt && <OllamaSystemPromptInput />}
    </>
  );
}

export function ProvidersSettings() {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const { providers: serverProviders } = useProviders();
  const { settings, updateSetting } = useServerSettings();

  const handleCopyClaudeLoginCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText("claude auth login --claudeai");
      showToast(t("providersClaudeLoginCommandCopied"), "success");
    } catch {
      showToast(t("providersClaudeLoginCommandCopyError"), "error");
    }
  }, [showToast, t]);

  // Merge server detection status with client-side metadata
  const registeredProviders = getAllProviders();
  const providerDisplayList = registeredProviders.map((clientProvider) => {
    const serverInfo = serverProviders.find(
      (p) => p.name === clientProvider.id,
    );
    return {
      ...clientProvider,
      installed: serverInfo?.installed ?? false,
      authenticated: serverInfo?.authenticated ?? false,
    };
  });

  return (
    <section className="settings-section">
      <h2>{t("providersSectionTitle")}</h2>
      <p className="settings-section-description">
        {t("providersSectionDescription")}
      </p>
      <div className="settings-group">
        <HelperTargetsSettings
          settings={settings}
          updateSetting={updateSetting}
        />
      </div>
      <div className="settings-group">
        {providerDisplayList.map((provider) => (
          <div key={provider.id} className="settings-item">
            <div className="settings-item-info">
              <div className="settings-item-header">
                <strong>{provider.displayName}</strong>
                {provider.installed ? (
                  <span className="settings-status-badge settings-status-detected">
                    {t("providersDetected")}
                  </span>
                ) : (
                  <span className="settings-status-badge settings-status-not-detected">
                    {t("providersNotDetected")}
                  </span>
                )}
              </div>
              <p>{provider.metadata.description}</p>
              {provider.metadata.limitations.length > 0 && (
                <ul className="settings-limitations">
                  {provider.metadata.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              )}
              {provider.id === "claude" &&
                provider.installed &&
                !provider.authenticated && (
                  <div style={{ marginTop: "var(--space-2)" }}>
                    <p className="settings-hint">
                      {t("providersClaudeLoginHint")}
                    </p>
                    <button
                      type="button"
                      className="settings-button"
                      onClick={() => void handleCopyClaudeLoginCommand()}
                      style={{ marginTop: "var(--space-2)" }}
                    >
                      {t("providersClaudeLoginCommandCopy")}
                    </button>
                  </div>
                )}
              {provider.id === "claude-ollama" && <OllamaSettings />}
              {provider.id === "grok" && <GrokBuildApiKeySettings />}
              {provider.id === "codex" && provider.installed && (
                <CodexUpdatePanel />
              )}
            </div>
            {provider.metadata.website && (
              <a
                href={provider.metadata.website}
                target="_blank"
                rel="noopener noreferrer"
                className="settings-link"
              >
                {t("providersWebsite")}
              </a>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
