import { useCallback, useEffect, useRef, useState } from "react";
import { CommittedRangeInput } from "../../components/ui/CommittedRangeInput";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { useSettingsUndo } from "./SettingsUndoContext";

const JOIN_WINDOW_SLIDER_MAX_SECONDS = 120;
const JOIN_WINDOW_MAX_SECONDS = 86400;
const JOIN_WINDOW_SAVE_DEBOUNCE_MS = 400;

function parseJoinWindowSeconds(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, JOIN_WINDOW_MAX_SECONDS);
}

interface MessageDeliveryBaseline {
  joinWindowSeconds: number;
  composeAnchorsEnabled: boolean;
  steerNowDefault: boolean;
  patientQueueDefault: boolean;
}

/**
 * Message Delivery pane. Settings apply immediately on change (the house
 * style for toggle/slider panes — no Save button); the header-row Undo
 * (useSettingsUndo) reverts to the values from when the pane was opened.
 */
export function MessageDeliverySettings() {
  const { t } = useI18n();
  const { settings, isLoading, error, updateSettings } = useServerSettings();

  // null drafts mirror the server value; non-null while the user is editing
  // or a save is in flight, cleared once the server catches up.
  const [draftJoinWindow, setDraftJoinWindow] = useState<string | null>(null);
  const [draftAnchors, setDraftAnchors] = useState<boolean | null>(null);
  const [draftSteerNow, setDraftSteerNow] = useState<boolean | null>(null);
  const [draftPatientQueue, setDraftPatientQueue] = useState<boolean | null>(
    null,
  );
  const baselineRef = useRef<MessageDeliveryBaseline | null>(null);

  const serverJoinWindowSeconds = settings?.deferredJoinWindowSeconds ?? 0;
  const serverComposeAnchorsEnabled = settings?.composeAnchorsEnabled ?? false;
  const serverSteerNowDefault =
    settings?.clientDefaults?.steerNowDefault ?? false;
  const serverPatientQueueDefault =
    settings?.clientDefaults?.patientQueueDefault ?? false;

  useEffect(() => {
    if (settings && !baselineRef.current) {
      baselineRef.current = {
        joinWindowSeconds: settings.deferredJoinWindowSeconds ?? 0,
        composeAnchorsEnabled: settings.composeAnchorsEnabled ?? false,
        steerNowDefault: settings.clientDefaults?.steerNowDefault ?? false,
        patientQueueDefault:
          settings.clientDefaults?.patientQueueDefault ?? false,
      };
    }
  }, [settings]);

  const shownJoinWindowText =
    draftJoinWindow ?? String(serverJoinWindowSeconds);
  const shownJoinWindowSeconds = parseJoinWindowSeconds(shownJoinWindowText);
  const shownAnchors = draftAnchors ?? serverComposeAnchorsEnabled;
  const shownSteerNowDefault = draftSteerNow ?? serverSteerNowDefault;
  const shownPatientQueueDefault =
    draftPatientQueue ?? serverPatientQueueDefault;

  // Debounced auto-save for the join window (sliders fire continuously).
  useEffect(() => {
    if (draftJoinWindow === null) return;
    const parsed = parseJoinWindowSeconds(draftJoinWindow);
    if (parsed === serverJoinWindowSeconds) return;
    const timer = setTimeout(() => {
      void updateSettings({ deferredJoinWindowSeconds: parsed }).catch(() => {
        // surfaced via the hook's error state
      });
    }, JOIN_WINDOW_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftJoinWindow, serverJoinWindowSeconds, updateSettings]);

  // Drop drafts once the server reflects them.
  useEffect(() => {
    if (
      draftJoinWindow !== null &&
      parseJoinWindowSeconds(draftJoinWindow) === serverJoinWindowSeconds
    ) {
      setDraftJoinWindow(null);
    }
  }, [draftJoinWindow, serverJoinWindowSeconds]);
  useEffect(() => {
    if (draftAnchors !== null && draftAnchors === serverComposeAnchorsEnabled) {
      setDraftAnchors(null);
    }
  }, [draftAnchors, serverComposeAnchorsEnabled]);
  useEffect(() => {
    if (draftSteerNow !== null && draftSteerNow === serverSteerNowDefault) {
      setDraftSteerNow(null);
    }
  }, [draftSteerNow, serverSteerNowDefault]);
  useEffect(() => {
    if (
      draftPatientQueue !== null &&
      draftPatientQueue === serverPatientQueueDefault
    ) {
      setDraftPatientQueue(null);
    }
  }, [draftPatientQueue, serverPatientQueueDefault]);

  const baseline = baselineRef.current;
  const canUndo =
    !!baseline &&
    (shownJoinWindowSeconds !== baseline.joinWindowSeconds ||
      shownAnchors !== baseline.composeAnchorsEnabled ||
      shownSteerNowDefault !== baseline.steerNowDefault ||
      shownPatientQueueDefault !== baseline.patientQueueDefault);

  const undo = useCallback(async () => {
    const snapshot = baselineRef.current;
    if (!snapshot) return;
    setDraftJoinWindow(null);
    setDraftAnchors(null);
    setDraftSteerNow(null);
    setDraftPatientQueue(null);
    await updateSettings({
      deferredJoinWindowSeconds: snapshot.joinWindowSeconds,
      composeAnchorsEnabled: snapshot.composeAnchorsEnabled,
      clientDefaults: {
        steerNowDefault: snapshot.steerNowDefault,
        patientQueueDefault: snapshot.patientQueueDefault,
      },
    }).catch(() => {
      // surfaced via the hook's error state
    });
  }, [updateSettings]);

  useSettingsUndo(canUndo, undo);

  if (isLoading) {
    return (
      <section className="settings-section">
        <h2>{t("messageDeliveryTitle")}</h2>
        <p className="settings-section-description">
          {t("messageDeliveryLoading")}
        </p>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h2>{t("messageDeliveryTitle")}</h2>
      <p className="settings-section-description">
        {t("messageDeliveryDescription")}
      </p>

      <div className="settings-group">
        <div className="settings-item model-settings-item">
          <div className="settings-item-info">
            <strong>{t("messageDeliveryJoinWindowTitle")}</strong>
            <p>{t("messageDeliveryJoinWindowDescription")}</p>
          </div>
          <span className="output-appearance-slider-row">
            <CommittedRangeInput
              id="message-delivery-join-window"
              min={0}
              max={JOIN_WINDOW_SLIDER_MAX_SECONDS}
              step={5}
              value={Math.min(
                shownJoinWindowSeconds,
                JOIN_WINDOW_SLIDER_MAX_SECONDS,
              )}
              aria-label={t("messageDeliveryJoinWindowTitle")}
              onCommit={(value) => setDraftJoinWindow(String(value))}
            />
            <span className="output-appearance-number-wrap">
              <input
                type="number"
                className="settings-input-small output-appearance-number"
                min={0}
                max={JOIN_WINDOW_MAX_SECONDS}
                value={shownJoinWindowText}
                onChange={(e) => setDraftJoinWindow(e.target.value)}
                aria-label={t("messageDeliveryJoinWindowTitle")}
              />
              <span className="output-appearance-unit">s</span>
            </span>
          </span>
          <span className="settings-hint">
            {shownJoinWindowSeconds === 0
              ? t("messageDeliveryJoinWindowOffHint")
              : t("messageDeliveryJoinWindowOnHint", {
                  seconds: String(shownJoinWindowSeconds),
                })}
          </span>
        </div>

        <label className="settings-item">
          <div className="settings-item-info">
            <strong>{t("messageDeliveryComposeAnchorsTitle")}</strong>
            <p>{t("messageDeliveryComposeAnchorsDescription")}</p>
          </div>
          <input
            type="checkbox"
            checked={shownAnchors}
            onChange={(e) => {
              const next = e.target.checked;
              setDraftAnchors(next);
              void updateSettings({ composeAnchorsEnabled: next }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("messageDeliveryComposeAnchorsTitle")}
          />
        </label>

        <label className="settings-item">
          <div className="settings-item-info">
            <strong>{t("messageDeliverySteerNowDefaultTitle")}</strong>
            <p>{t("messageDeliverySteerNowDefaultDescription")}</p>
          </div>
          <input
            type="checkbox"
            checked={shownSteerNowDefault}
            onChange={(e) => {
              const next = e.target.checked;
              setDraftSteerNow(next);
              void updateSettings({
                clientDefaults: { steerNowDefault: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("messageDeliverySteerNowDefaultTitle")}
          />
        </label>

        <label className="settings-item">
          <div className="settings-item-info">
            <strong>{t("messageDeliveryPatientQueueDefaultTitle")}</strong>
            <p>{t("messageDeliveryPatientQueueDefaultDescription")}</p>
          </div>
          <input
            type="checkbox"
            checked={shownPatientQueueDefault}
            onChange={(e) => {
              const next = e.target.checked;
              setDraftPatientQueue(next);
              void updateSettings({
                clientDefaults: { patientQueueDefault: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("messageDeliveryPatientQueueDefaultTitle")}
          />
        </label>

        {error && <p className="settings-warning">{error}</p>}
      </div>
    </section>
  );
}
