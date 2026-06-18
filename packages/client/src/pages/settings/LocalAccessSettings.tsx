import { useCallback, useEffect, useState } from "react";
import {
  api,
  DEFAULT_FILE_ACCESS,
  type FileAccessInfo,
  type FileAccessSettings,
} from "../../api/client";
import { FilterDropdown } from "../../components/FilterDropdown";
import { useOptionalAuth } from "../../contexts/AuthContext";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useNetworkBinding } from "../../hooks/useNetworkBinding";
import { useServerInfo } from "../../hooks/useServerInfo";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { useSettingsUndo } from "./SettingsUndoContext";

/** File-access form state — `custom` is edited as newline-separated text. */
interface FileAccessForm {
  projects: boolean;
  uploads: boolean;
  temp: boolean;
  home: boolean;
  customText: string;
}

function settingsToFileAccessForm(fa: FileAccessSettings): FileAccessForm {
  return {
    projects: fa.projects,
    uploads: fa.uploads,
    temp: fa.temp,
    home: fa.home,
    customText: fa.custom.join("\n"),
  };
}

function fileAccessFormToSettings(form: FileAccessForm): FileAccessSettings {
  return {
    projects: form.projects,
    uploads: form.uploads,
    temp: form.temp,
    home: form.home,
    custom: form.customText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function fileAccessEquals(a: FileAccessSettings, b: FileAccessSettings): boolean {
  return (
    a.projects === b.projects &&
    a.uploads === b.uploads &&
    a.temp === b.temp &&
    a.home === b.home &&
    a.custom.length === b.custom.length &&
    a.custom.every((value, index) => value === b.custom[index])
  );
}

/** A custom line that grants whole-disk read, so the UI can flag it. */
function isWholeDiskPath(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed);
}

export function LocalAccessSettings() {
  const { t } = useI18n();
  const auth = useOptionalAuth();
  const remoteConnection = useOptionalRemoteConnection();
  const { relayDebugEnabled, setRelayDebugEnabled } = useDeveloperMode();
  const { serverInfo, loading: serverInfoLoading } = useServerInfo();
  const {
    binding,
    loading: bindingLoading,
    applying,
    updateBinding,
  } = useNetworkBinding();
  const {
    settings: serverSettings,
    isLoading: settingsLoading,
    error: settingsError,
    updateSettings: updateServerSettings,
  } = useServerSettings();

  // Network binding form state
  const [localhostPort, setLocalhostPort] = useState<string>("");
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [selectedInterface, setSelectedInterface] = useState<string>("");
  const [customIp, setCustomIp] = useState("");

  // Auth form state (merged into same form)
  const [requirePassword, setRequirePassword] = useState(false);
  const [localhostOpenToggle, setLocalhostOpenToggle] = useState(false);
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");

  // Allowed hosts form state
  const [allowAllHostsToggle, setAllowAllHostsToggle] = useState(false);
  const [allowedHostsText, setAllowedHostsText] = useState("");

  // File access form state + read-only server info (env-pin + hint paths)
  const [fileAccess, setFileAccess] = useState<FileAccessForm>(
    settingsToFileAccessForm(DEFAULT_FILE_ACCESS),
  );
  const [fileAccessInfo, setFileAccessInfo] = useState<FileAccessInfo | null>(
    null,
  );

  // Form state
  const [formError, setFormError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  // Fetch read-only file-access info (env-pin state + resolved hint paths).
  // Supported by both direct/cookie clients and relayed SecureConnection fetches.
  useEffect(() => {
    if (!auth && !remoteConnection) return;
    let cancelled = false;
    api
      .getFileAccessInfo()
      .then((info) => {
        if (!cancelled) setFileAccessInfo(info);
      })
      .catch(() => {
        /* remote/unsupported — leave defaults */
      });
    return () => {
      cancelled = true;
    };
  }, [auth, remoteConnection]);

  // Initialize form from binding, auth, and settings state when it loads
  const [formInitialized, setFormInitialized] = useState(false);
  useEffect(() => {
    if (!binding || !auth || !serverSettings || formInitialized) {
      return;
    }

    setLocalhostPort(String(binding.localhost.port));
    setNetworkEnabled(binding.network.enabled);
    setSelectedInterface(binding.network.host ?? "");
    setRequirePassword(auth.authEnabled);
    setLocalhostOpenToggle(auth.localhostOpen);
    // Initialize allowed hosts from server settings
    const ah = serverSettings.allowedHosts;
    if (ah === "*") {
      setAllowAllHostsToggle(true);
      setAllowedHostsText("");
    } else {
      setAllowAllHostsToggle(false);
      setAllowedHostsText(ah ?? "");
    }
    setFileAccess(
      settingsToFileAccessForm(serverSettings.fileAccess ?? DEFAULT_FILE_ACCESS),
    );
    setFormInitialized(true);
  }, [auth, binding, formInitialized, serverSettings]);

  // Relay mode has no cookie-auth or network-binding context, but it can still
  // edit file access through the encrypted API connection.
  useEffect(() => {
    if (!remoteConnection || auth || !serverSettings || formInitialized) {
      return;
    }

    setFileAccess(
      settingsToFileAccessForm(serverSettings.fileAccess ?? DEFAULT_FILE_ACCESS),
    );
    setFormInitialized(true);
  }, [auth, formInitialized, remoteConnection, serverSettings]);

  // Compute the effective allowedHosts value for comparison/saving
  const getAllowedHostsValue = (
    toggle: boolean,
    text: string,
  ): string | undefined => {
    if (toggle) return "*";
    const trimmed = text.trim();
    return trimmed || undefined;
  };

  // Track changes - includes auth and allowed hosts changes
  const checkForChanges = (
    newPort: string,
    newNetworkEnabled: boolean,
    newInterface: string,
    newRequirePassword: boolean,
    newPassword: string,
    newAllowAllHosts: boolean,
    newAllowedHostsText: string,
    newLocalhostOpen: boolean,
    newFileAccess: FileAccessForm,
  ) => {
    if (!serverSettings) return false;
    const fileAccessChanged = !fileAccessEquals(
      fileAccessFormToSettings(newFileAccess),
      serverSettings.fileAccess ?? DEFAULT_FILE_ACCESS,
    );

    if (!binding || !auth) return fileAccessChanged;

    const portChanged = newPort !== String(binding.localhost.port);
    const networkEnabledChanged = newNetworkEnabled !== binding.network.enabled;
    const interfaceChanged = newInterface !== (binding.network.host ?? "");
    const authChanged = newRequirePassword !== auth.authEnabled;
    const passwordEntered = newPassword.length > 0;
    const localhostOpenChanged = newLocalhostOpen !== auth.localhostOpen;
    const newValue = getAllowedHostsValue(
      newAllowAllHosts,
      newAllowedHostsText,
    );
    const oldValue = serverSettings.allowedHosts;
    const allowedHostsChanged = (newValue ?? "") !== (oldValue ?? "");
    return (
      portChanged ||
      networkEnabledChanged ||
      interfaceChanged ||
      authChanged ||
      passwordEntered ||
      localhostOpenChanged ||
      allowedHostsChanged ||
      fileAccessChanged
    );
  };

  // Helper for onChange handlers
  const updateHasChanges = (overrides: {
    port?: string;
    networkEnabled?: boolean;
    iface?: string;
    requirePw?: boolean;
    password?: string;
    allowAll?: boolean;
    hostsText?: string;
    localhostOpen?: boolean;
    fileAccess?: FileAccessForm;
  }) => {
    setHasChanges(
      checkForChanges(
        overrides.port ?? localhostPort,
        overrides.networkEnabled ?? networkEnabled,
        overrides.iface ?? selectedInterface,
        overrides.requirePw ?? requirePassword,
        overrides.password ?? authPassword,
        overrides.allowAll ?? allowAllHostsToggle,
        overrides.hostsText ?? allowedHostsText,
        overrides.localhostOpen ?? localhostOpenToggle,
        overrides.fileAccess ?? fileAccess,
      ),
    );
  };

  // Patch a file-access field and recompute change state from the new value.
  const patchFileAccess = (patch: Partial<FileAccessForm>) => {
    setFileAccess((prev) => {
      const next = { ...prev, ...patch };
      updateHasChanges({ fileAccess: next });
      return next;
    });
  };

  // Header undo discards unapplied form edits back to the live server state.
  // Unlike snapshot panes, it never re-applies an old binding: applying is a
  // network-rebind action and must stay behind the explicit Apply button.
  const resetFormFromServer = useCallback(() => {
    if (!serverSettings) return;

    const resetFileAccess = () =>
      setFileAccess(
        settingsToFileAccessForm(
          serverSettings.fileAccess ?? DEFAULT_FILE_ACCESS,
        ),
      );

    if (!binding || !auth) {
      resetFileAccess();
      setFormError(null);
      setHasChanges(false);
      return;
    }

    setLocalhostPort(String(binding.localhost.port));
    setNetworkEnabled(binding.network.enabled);
    setSelectedInterface(binding.network.host ?? "");
    setCustomIp("");
    setRequirePassword(auth.authEnabled);
    setLocalhostOpenToggle(auth.localhostOpen);
    setAuthPassword("");
    setAuthPasswordConfirm("");
    const ah = serverSettings.allowedHosts;
    if (ah === "*") {
      setAllowAllHostsToggle(true);
      setAllowedHostsText("");
    } else {
      setAllowAllHostsToggle(false);
      setAllowedHostsText(ah ?? "");
    }
    resetFileAccess();
    setFormError(null);
    setHasChanges(false);
  }, [auth, binding, serverSettings]);
  useSettingsUndo(hasChanges, resetFormFromServer);

  const renderFileAccessSettings = () => (
    <>
      {/* File access — which local paths the HTTP file doors may read */}
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("fileAccessTitle")}</strong>
          <p>{t("fileAccessDescription")}</p>
        </div>
      </div>
      {fileAccessInfo?.envPinned ? (
        <div className="settings-item settings-item-inline-field">
          <div className="settings-item-info">
            <strong>{t("fileAccessAllowedFoldersTitle")}</strong>
            <p>{t("fileAccessEnvPinnedHint")}</p>
          </div>
          <span className="settings-value-readonly">
            {fileAccessInfo.envPaths.length > 0
              ? fileAccessInfo.envPaths.join(", ")
              : t("fileAccessNone")}{" "}
            <span className="settings-hint">{t("fileAccessSetViaEnv")}</span>
          </span>
        </div>
      ) : (
        <>
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("fileAccessProjects")}</strong>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={fileAccess.projects}
                onChange={(e) =>
                  patchFileAccess({ projects: e.target.checked })
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("fileAccessUploads")}</strong>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={fileAccess.uploads}
                onChange={(e) =>
                  patchFileAccess({ uploads: e.target.checked })
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("fileAccessTemp")}</strong>
              {fileAccessInfo && fileAccessInfo.tempPaths.length > 0 && (
                <p className="settings-hint">
                  {fileAccessInfo.tempPaths.join(", ")}
                </p>
              )}
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={fileAccess.temp}
                onChange={(e) => patchFileAccess({ temp: e.target.checked })}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("fileAccessHome")}</strong>
              <p>{t("fileAccessHomeDescription")}</p>
            </div>
            {fileAccess.home && (
              <span className="settings-status-badge settings-status-warning">
                {t("fileAccessHomeCaution")}
              </span>
            )}
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={fileAccess.home}
                onChange={(e) => patchFileAccess({ home: e.target.checked })}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <div className="settings-item settings-item-inline-field">
            <div className="settings-item-info">
              <strong>{t("fileAccessCustomTitle")}</strong>
              <p>{t("fileAccessCustomDescription")}</p>
            </div>
            <textarea
              className="settings-input"
              rows={3}
              value={fileAccess.customText}
              placeholder={t("fileAccessCustomPlaceholder")}
              onChange={(e) =>
                patchFileAccess({ customText: e.target.value })
              }
            />
          </div>
          {fileAccess.customText
            .split("\n")
            .some((line) => isWholeDiskPath(line)) && (
            <p className="form-warning">{t("fileAccessWholeDiskWarning")}</p>
          )}
        </>
      )}
    </>
  );

  const handleApplyChanges = async () => {
    if (!auth) return;
    setFormError(null);

    // Validate port
    const portNum = Number.parseInt(localhostPort, 10);
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setFormError(t("localAccessErrorPortRange"));
      return;
    }

    // Validate password if enabling or changing auth
    const enablingAuth = requirePassword && !auth.authEnabled;
    const changingPassword =
      requirePassword && auth.authEnabled && authPassword.length > 0;
    if (enablingAuth || changingPassword) {
      if (authPassword.length < 6) {
        setFormError(t("localAccessErrorPasswordLength"));
        return;
      }
      if (authPassword !== authPasswordConfirm) {
        setFormError(t("localAccessErrorPasswordMismatch"));
        return;
      }
    }

    const effectiveInterface =
      selectedInterface === "custom" ? customIp : selectedInterface;

    setIsApplying(true);
    try {
      // Apply network binding changes (skip overridden fields to avoid 400 errors)
      const bindingUpdate: Parameters<typeof updateBinding>[0] = {};
      if (!binding?.localhost.overriddenByCli) {
        bindingUpdate.localhostPort = portNum;
      }
      if (!binding?.network.overriddenByCli) {
        bindingUpdate.network = {
          enabled: networkEnabled,
          host: networkEnabled ? effectiveInterface : undefined,
        };
      }
      const result = await updateBinding(bindingUpdate);

      // Apply auth changes
      if (enablingAuth) {
        await auth.enableAuth(authPassword);
        setAuthPassword("");
        setAuthPasswordConfirm("");
      } else if (changingPassword) {
        await auth.changePassword(authPassword);
        setAuthPassword("");
        setAuthPasswordConfirm("");
      } else if (!requirePassword && auth.authEnabled) {
        await auth.disableAuth();
      }

      // Apply localhost access changes (desktop token floor bypass)
      if (localhostOpenToggle !== auth.localhostOpen) {
        await auth.setLocalhostOpen(localhostOpenToggle);
      }

      // Apply allowed hosts changes
      const newAllowedHosts = getAllowedHostsValue(
        allowAllHostsToggle,
        allowedHostsText,
      );
      await updateServerSettings({
        allowedHosts: newAllowedHosts ?? "",
        // Skip when env-pinned (server ignores it, but avoid a confusing write).
        ...(fileAccessInfo?.envPinned
          ? {}
          : { fileAccess: fileAccessFormToSettings(fileAccess) }),
      });

      if (result.redirectUrl) {
        // Server changed port, redirect to new URL preserving current path
        const newUrl = new URL(result.redirectUrl);
        newUrl.pathname = window.location.pathname;
        newUrl.search = window.location.search;
        window.location.href = newUrl.toString();
      } else {
        setHasChanges(false);
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : t("localAccessErrorApplyFailed"),
      );
    } finally {
      setIsApplying(false);
    }
  };

  const handleApplyRemoteFileAccess = async () => {
    if (!serverSettings || fileAccessInfo?.envPinned) return;
    setFormError(null);
    setIsApplying(true);

    try {
      await updateServerSettings({
        fileAccess: fileAccessFormToSettings(fileAccess),
      });
      setHasChanges(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : t("localAccessErrorApplyFailed"),
      );
    } finally {
      setIsApplying(false);
    }
  };

  // Non-remote mode (cookie-based auth)
  if (auth) {
    // Show loading state until data is ready
    const isLoading =
      serverInfoLoading ||
      bindingLoading ||
      settingsLoading ||
      auth.isLoading ||
      !formInitialized;

    if (isLoading) {
      return (
        <section className="settings-section">
          <h2>{t("settingsLocalAccessTitle")}</h2>
          <p className="settings-section-description">
            {t("localAccessLoading")}
          </p>
        </section>
      );
    }

    // Show password fields when auth is enabled or being enabled
    const showPasswordFields = requirePassword;

    return (
      <section className="settings-section">
        <h2>{t("settingsLocalAccessTitle")}</h2>
        <p className="settings-section-description">
          {t("localAccessDescription")}
        </p>

        {/* Current status */}
        <div className="settings-group">
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("localAccessStatusTitle")}</strong>
              <p>
                {serverInfo
                  ? (() => {
                      const networkHost = binding?.network.host;
                      const networkPort =
                        binding?.network.port ?? serverInfo.port;
                      const isAllInterfaces =
                        networkHost === "0.0.0.0" || networkHost === "::";
                      const samePort = networkPort === serverInfo.port;

                      // If bound to all interfaces on same port, just show that
                      if (
                        binding?.network.enabled &&
                        isAllInterfaces &&
                        samePort
                      ) {
                        return (
                          <>
                            {t("localAccessListeningOn")}{" "}
                            <code>
                              {networkHost}:{networkPort}
                            </code>
                          </>
                        );
                      }

                      // Otherwise show localhost, and optionally network
                      return (
                        <>
                          {t("localAccessListeningOn")}{" "}
                          <code>
                            {serverInfo.host}:{serverInfo.port}
                          </code>
                          {binding?.network.enabled && networkHost && (
                            <>
                              {" "}
                              {t("localAccessListeningAnd")}{" "}
                              <code>
                                {networkHost}:{networkPort}
                              </code>
                            </>
                          )}
                        </>
                      );
                    })()
                  : t("localAccessUnableToFetch")}
              </p>
            </div>
            {serverInfo?.localhostOnly && !binding?.network.enabled && (
              <span className="settings-status-badge settings-status-detected">
                {t("localAccessBadgeLocalOnly")}
              </span>
            )}
            {(serverInfo?.boundToAllInterfaces || binding?.network.enabled) &&
              !auth.authEnabled && (
                <span className="settings-status-badge settings-status-warning">
                  {t("localAccessBadgeNetworkExposed")}
                </span>
              )}
          </div>
        </div>

        {/* Network Configuration */}
        <form
          className="settings-group"
          onSubmit={(e) => {
            e.preventDefault();
            handleApplyChanges();
          }}
        >
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("localAccessListeningPortTitle")}</strong>
              <p>{t("localAccessListeningPortDescription")}</p>
            </div>
            {binding?.localhost.overriddenByCli ? (
              <span className="settings-value-readonly">
                {binding.localhost.port}{" "}
                <span className="settings-hint">
                  {t("localAccessSetViaPort")}
                </span>
              </span>
            ) : (
              <input
                type="number"
                className="settings-input-small"
                value={localhostPort}
                onChange={(e) => {
                  setLocalhostPort(e.target.value);
                  updateHasChanges({ port: e.target.value });
                }}
                min={1}
                max={65535}
                autoComplete="off"
              />
            )}
          </div>

          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("localAccessNetworkTitle")}</strong>
              <p>{t("localAccessNetworkDescription")}</p>
            </div>
            {binding?.network.overriddenByCli ? (
              <span className="settings-value-readonly">
                {binding.network.host}:{binding.network.port}{" "}
                <span className="settings-hint">
                  {t("localAccessSetViaHost")}
                </span>
              </span>
            ) : (
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={networkEnabled}
                  onChange={(e) => {
                    setNetworkEnabled(e.target.checked);
                    updateHasChanges({ networkEnabled: e.target.checked });
                  }}
                />
                <span className="toggle-slider" />
              </label>
            )}
          </div>

          {networkEnabled && !binding?.network.overriddenByCli && binding && (
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("localAccessInterfaceTitle")}</strong>
                <p>{t("localAccessInterfaceDescription")}</p>
              </div>
              <FilterDropdown
                label={t("localAccessInterfaceTitle")}
                placeholder={t("localAccessInterfacePlaceholder")}
                multiSelect={false}
                align="right"
                options={[
                  ...binding.interfaces.map((iface) => ({
                    value: iface.address,
                    label: iface.displayName,
                  })),
                  {
                    value: "0.0.0.0",
                    label: t("localAccessInterfaceAll"),
                  },
                  { value: "custom", label: t("localAccessInterfaceCustom") },
                ]}
                selected={selectedInterface ? [selectedInterface] : []}
                onChange={(values) => {
                  const newInterface = values[0] ?? "";
                  setSelectedInterface(newInterface);
                  updateHasChanges({ iface: newInterface });
                }}
              />
            </div>
          )}

          {networkEnabled &&
            !binding?.network.overriddenByCli &&
            selectedInterface === "custom" && (
              <div className="settings-item settings-item-inline-field">
                <div className="settings-item-info">
                  <strong>{t("localAccessCustomIpTitle")}</strong>
                  <p>{t("localAccessCustomIpDescription")}</p>
                </div>
                <input
                  type="text"
                  className="settings-input"
                  placeholder="192.168.1.100"
                  value={customIp}
                  onChange={(e) => setCustomIp(e.target.value)}
                />
              </div>
            )}

          {/* Allowed Hosts — applies even on localhost (reverse proxy may use different hostname) */}
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("localAccessAllowAllHostsTitle")}</strong>
              <p>{t("localAccessAllowAllHostsDescription")}</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={allowAllHostsToggle}
                onChange={(e) => {
                  setAllowAllHostsToggle(e.target.checked);
                  updateHasChanges({ allowAll: e.target.checked });
                }}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          {!allowAllHostsToggle && (
            <div className="settings-item settings-item-inline-field">
              <div className="settings-item-info">
                <strong>{t("localAccessAllowedHostsTitle")}</strong>
                <p>{t("localAccessAllowedHostsDescription")}</p>
              </div>
              <input
                type="text"
                className="settings-input"
                placeholder={t("localAccessAllowedHostsPlaceholder")}
                value={allowedHostsText}
                onChange={(e) => {
                  setAllowedHostsText(e.target.value);
                  updateHasChanges({ hostsText: e.target.value });
                }}
              />
            </div>
          )}
          <p className="form-hint">{t("localAccessAllowedHostsHint")}</p>

          {renderFileAccessSettings()}

          {/* Require Password toggle */}
          {!auth.authDisabledByEnv && (
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("localAccessRequirePasswordTitle")}</strong>
                <p>{t("localAccessRequirePasswordDescription")}</p>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={requirePassword}
                  onChange={(e) => {
                    setRequirePassword(e.target.checked);
                    updateHasChanges({ requirePw: e.target.checked });
                  }}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          )}

          {/* Password fields - shown when auth is on */}
          {showPasswordFields && (
            <>
              {/* Hidden username field to prevent Chrome from using port as username */}
              <input
                type="text"
                name="username"
                autoComplete="username"
                style={{
                  position: "absolute",
                  visibility: "hidden",
                  pointerEvents: "none",
                }}
                tabIndex={-1}
              />
              <div className="settings-item settings-item-inline-field">
                <div className="settings-item-info">
                  <strong>{t("localAccessPasswordTitle")}</strong>
                  <p>
                    {auth.authEnabled
                      ? t("localAccessPasswordKeepCurrent")
                      : t("localAccessPasswordMinLength")}
                  </p>
                </div>
                <input
                  type="password"
                  className="settings-input"
                  value={authPassword}
                  onChange={(e) => {
                    setAuthPassword(e.target.value);
                    updateHasChanges({ password: e.target.value });
                  }}
                  autoComplete="new-password"
                  placeholder={
                    auth.authEnabled
                      ? t("localAccessPasswordNewPlaceholder")
                      : t("localAccessPasswordPlaceholder")
                  }
                />
              </div>
              {authPassword.length > 0 && (
                <div className="settings-item settings-item-inline-field">
                  <div className="settings-item-info">
                    <strong>{t("localAccessConfirmPasswordTitle")}</strong>
                  </div>
                  <input
                    type="password"
                    className="settings-input"
                    value={authPasswordConfirm}
                    onChange={(e) => setAuthPasswordConfirm(e.target.value)}
                    autoComplete="new-password"
                    placeholder={t("localAccessConfirmPasswordPlaceholder")}
                  />
                </div>
              )}
              {!auth.authEnabled && (
                <p className="form-hint">{t("localAccessPasswordResetHint")}</p>
              )}
            </>
          )}

          {/* Allow Localhost Access - shown in desktop mode when password auth is off */}
          {auth.hasDesktopToken &&
            !requirePassword &&
            !auth.authDisabledByEnv && (
              <div className="settings-item">
                <div className="settings-item-info">
                  <strong>{t("localAccessLocalhostOpenTitle")}</strong>
                  <p>{t("localAccessLocalhostOpenDescription")}</p>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={localhostOpenToggle}
                    onChange={(e) => {
                      setLocalhostOpenToggle(e.target.checked);
                      updateHasChanges({ localhostOpen: e.target.checked });
                    }}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            )}

          {auth.authDisabledByEnv && (
            <p className="form-warning">{t("localAccessAuthDisabled")}</p>
          )}

          {/* Apply button - always visible */}
          <div className="settings-item">
            {formError && <p className="form-error">{formError}</p>}
            <button
              type="submit"
              className="settings-button"
              disabled={!hasChanges || isApplying || applying}
            >
              {isApplying || applying
                ? t("localAccessApplying")
                : t("localAccessApply")}
            </button>
          </div>
        </form>

        {/* Logout - shown when auth is enabled */}
        {auth.authEnabled && auth.isAuthenticated && (
          <div className="settings-group">
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("remoteAccessLogoutTitle")}</strong>
                <p>{t("localAccessLogoutDescription")}</p>
              </div>
              <button
                type="button"
                className="settings-button settings-button-danger"
                onClick={auth.logout}
              >
                {t("remoteAccessLogout")}
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  // Remote mode (SRP auth)
  if (remoteConnection) {
    const remoteFileAccessReady = !!serverSettings && formInitialized;

    return (
      <section className="settings-section">
        <h2>{t("settingsLocalAccessTitle")}</h2>
        <p className="settings-section-description">
          {t("localAccessRemoteDescription")}
        </p>

        {remoteFileAccessReady ? (
          <form
            className="settings-group"
            onSubmit={(e) => {
              e.preventDefault();
              handleApplyRemoteFileAccess();
            }}
          >
            {renderFileAccessSettings()}
            <div className="settings-item">
              {formError && <p className="form-error">{formError}</p>}
              <button
                type="submit"
                className="settings-button"
                disabled={
                  !hasChanges || isApplying || fileAccessInfo?.envPinned
                }
              >
                {isApplying ? t("localAccessApplying") : t("localAccessApply")}
              </button>
            </div>
          </form>
        ) : (
          <div className="settings-group">
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("fileAccessTitle")}</strong>
                <p>{settingsError ?? t("localAccessLoading")}</p>
              </div>
            </div>
          </div>
        )}

        <div className="settings-group">
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("remoteAccessLogoutTitle")}</strong>
              <p>{t("localAccessRemoteLogoutDescription")}</p>
            </div>
            <button
              type="button"
              className="settings-button settings-button-danger"
              onClick={() => remoteConnection.disconnect()}
            >
              {t("remoteAccessLogout")}
            </button>
          </div>
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("localAccessRelayDebugTitle")}</strong>
              <p>{t("localAccessRelayDebugDescription")}</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={relayDebugEnabled}
                onChange={(e) => setRelayDebugEnabled(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </section>
    );
  }

  // No auth context available
  return null;
}
