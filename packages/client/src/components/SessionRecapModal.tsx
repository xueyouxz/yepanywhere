import {
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  type ModelInfo,
  type ProviderName,
  type RecapMode,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useProviders } from "../hooks/useProviders";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import { helperTargetsToModelOptions } from "../lib/helperTargets";
import { Modal } from "./ui/Modal";

interface SessionRecapModalProps {
  sessionId: string;
  processId: string;
  provider?: ProviderName;
  currentModel?: string;
  onClose: () => void;
  onSaved: (settings: {
    recapMode: RecapMode;
    helperSideModel: string;
  }) => void;
}

const RECAP_MODE_ORDER: RecapMode[] = ["off", "native", "side-session"];
type Translate = ReturnType<typeof useI18n>["t"];

function modeLabel(mode: RecapMode, t: Translate): string {
  if (mode === "native") return t("recapModeNative");
  if (mode === "side-session") return t("recapModeSideSession");
  return t("recapModeOff");
}

function modeDescription(mode: RecapMode, t: Translate): string {
  if (mode === "native") return t("recapModeNativeDescription");
  if (mode === "side-session") {
    return t("recapModeSideSessionDescription");
  }
  return t("recapModeOffDescription");
}

export function SessionRecapModal({
  sessionId,
  processId,
  provider,
  currentModel,
  onClose,
  onSaved,
}: SessionRecapModalProps) {
  const { t } = useI18n();
  const { providers } = useProviders();
  const { settings } = useServerSettings();
  const [recapMode, setRecapMode] = useState<RecapMode>("off");
  const [helperSideModel, setHelperSideModel] = useState<string>(
    HELPER_SIDE_MODEL_CHEAPEST,
  );
  const [processProvider, setProcessProvider] = useState<ProviderName | undefined>(
    provider,
  );
  const [processModel, setProcessModel] = useState<string | undefined>(
    currentModel,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    api
      .getProcessInfo(sessionId)
      .then((response) => {
        if (cancelled) return;
        const process = response.process;
        setRecapMode(process?.recapMode ?? "off");
        setHelperSideModel(
          process?.helperSideModel ?? HELPER_SIDE_MODEL_CHEAPEST,
        );
        setProcessProvider((process?.provider as ProviderName | undefined) ?? provider);
        setProcessModel(process?.model ?? currentModel);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("sessionRecapLoadFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentModel, provider, sessionId, t]);

  const providerInfo = providers.find((p) => p.name === processProvider);
  const models = providerInfo?.models ?? [];
  const helperTargetModelOptions = useMemo(
    () => helperTargetsToModelOptions(settings?.helperTargets),
    [settings?.helperTargets],
  );
  const modeAvailability = useMemo(
    () => ({
      off: true,
      native: providerInfo?.supportsNativeRecaps === true,
      "side-session": providerInfo?.supportsRecaps === true,
    }),
    [providerInfo],
  );
  const modelOptions = useMemo<ModelInfo[]>(
    () => [
      {
        id: HELPER_SIDE_MODEL_CHEAPEST,
        name: t("helperSideModelCheapest"),
      },
      {
        id: HELPER_SIDE_MODEL_SAME_AS_MAIN,
        name: t("helperSideModelSameAsMain"),
        description:
          processModel && processModel !== HELPER_SIDE_MODEL_SAME_AS_MAIN
            ? processModel
            : undefined,
      },
      ...helperTargetModelOptions,
      ...models,
    ],
    [helperTargetModelOptions, models, processModel, t],
  );

  const save = useCallback(async () => {
    if (!modeAvailability[recapMode]) {
      setError(t("sessionRecapUnsupportedMode"));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const result = await api.setProcessRecapConfig(processId, {
        recapMode,
        helperSideModel,
      });
      onSaved({
        recapMode: result.recapMode,
        helperSideModel: result.helperSideModel,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sessionRecapSaveFailed"));
    } finally {
      setIsSaving(false);
    }
  }, [
    helperSideModel,
    modeAvailability,
    onClose,
    onSaved,
    processId,
    recapMode,
    t,
  ]);

  return (
    <Modal title={t("sessionRecapTitle")} onClose={isSaving ? () => {} : onClose}>
      <div className="settings-group session-recap-modal">
        <div className="settings-item model-settings-item">
          <div className="settings-item-info">
            <strong>{t("sessionRecapModeTitle")}</strong>
            <p>{t("sessionRecapModeDescription")}</p>
          </div>
          <div className="font-size-selector model-settings-chip-group">
            {RECAP_MODE_ORDER.map((mode) => {
              const available = modeAvailability[mode];
              return (
                <button
                  key={mode}
                  type="button"
                  className={`font-size-option ${recapMode === mode ? "active" : ""}`}
                  onClick={() => setRecapMode(mode)}
                  disabled={isLoading || isSaving || !available}
                  title={modeDescription(mode, t)}
                >
                  {modeLabel(mode, t)}
                </button>
              );
            })}
          </div>
        </div>

        {recapMode === "side-session" && (
          <label className="settings-item model-settings-item">
            <div className="settings-item-info">
              <strong>{t("helperSideModelTitle")}</strong>
              <p>{t("helperSideModelDescription")}</p>
            </div>
            <select
              className="settings-select"
              value={helperSideModel}
              onChange={(event) => setHelperSideModel(event.target.value)}
              disabled={isLoading || isSaving}
            >
              {modelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {error && <p className="settings-warning">{error}</p>}

        <div className="model-switch-actions">
          <button
            type="button"
            className="settings-button settings-button-secondary"
            onClick={onClose}
            disabled={isSaving}
          >
            {t("modalCancel")}
          </button>
          <button
            type="button"
            className="settings-button"
            onClick={() => void save()}
            disabled={isLoading || isSaving || !modeAvailability[recapMode]}
          >
            {isSaving ? t("providersSaving") : t("sessionRecapSave")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
