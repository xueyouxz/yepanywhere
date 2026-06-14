import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

const subscribers = new Set<() => void>();

function canUseLocalStorage(): boolean {
  return (
    typeof globalThis.localStorage !== "undefined" &&
    typeof globalThis.localStorage.getItem === "function" &&
    typeof globalThis.localStorage.setItem === "function" &&
    typeof globalThis.localStorage.removeItem === "function"
  );
}

export function getSpeechKeepMicWarmSetting(): boolean {
  if (!canUseLocalStorage()) return false;
  return globalThis.localStorage.getItem(UI_KEYS.speechKeepMicWarm) === "true";
}

export function getSpeechMicDeviceIdSetting(): string | null {
  if (!canUseLocalStorage()) return null;
  const deviceId = globalThis.localStorage.getItem(UI_KEYS.speechMicDeviceId);
  return deviceId && deviceId.length > 0 ? deviceId : null;
}

export function setSpeechKeepMicWarmSetting(enabled: boolean): void {
  if (canUseLocalStorage()) {
    globalThis.localStorage.setItem(
      UI_KEYS.speechKeepMicWarm,
      enabled ? "true" : "false",
    );
  }
  for (const subscriber of subscribers) subscriber();
}

export function setSpeechMicDeviceIdSetting(deviceId: string | null): void {
  if (canUseLocalStorage()) {
    if (deviceId && deviceId.length > 0) {
      globalThis.localStorage.setItem(UI_KEYS.speechMicDeviceId, deviceId);
    } else {
      globalThis.localStorage.removeItem(UI_KEYS.speechMicDeviceId);
    }
  }
  for (const subscriber of subscribers) subscriber();
}

export function useSpeechCaptureSettings() {
  const [keepMicWarm, setKeepMicWarmState] = useState(
    getSpeechKeepMicWarmSetting,
  );
  const [micDeviceId, setMicDeviceIdState] = useState(
    getSpeechMicDeviceIdSetting,
  );

  useEffect(() => {
    const update = () => {
      setKeepMicWarmState(getSpeechKeepMicWarmSetting());
      setMicDeviceIdState(getSpeechMicDeviceIdSetting());
    };
    subscribers.add(update);
    globalThis.addEventListener?.("storage", update);
    return () => {
      subscribers.delete(update);
      globalThis.removeEventListener?.("storage", update);
    };
  }, []);

  const setKeepMicWarm = useCallback((enabled: boolean) => {
    setSpeechKeepMicWarmSetting(enabled);
  }, []);

  const setMicDeviceId = useCallback((deviceId: string | null) => {
    setSpeechMicDeviceIdSetting(deviceId);
  }, []);

  return { keepMicWarm, setKeepMicWarm, micDeviceId, setMicDeviceId };
}
