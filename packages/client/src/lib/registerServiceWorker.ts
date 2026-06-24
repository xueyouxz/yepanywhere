/**
 * Register Service Worker at startup to enable PWA capabilities (install, etc.)
 * out of the box, without requiring the user to visit notification settings first.
 *
 * Decoupled from push subscription: SW registration is PWA infrastructure
 * needed by all users; push subscription is opt-in.
 */
import { api } from "../api/client";

/** Service Worker file path, compatible with Vite base URL (local "/" and remote "/remote/") */
const SW_PATH = `${import.meta.env.BASE_URL}sw.js`;

/** Whether the browser supports Service Worker */
const hasBrowserSupport =
  typeof window !== "undefined" &&
  "serviceWorker" in navigator;

/**
 * Register Service Worker at application startup.
 * Only registers the SW itself, does not subscribe to push notifications.
 */
export async function registerServiceWorkerAtStartup(): Promise<void> {
  if (!hasBrowserSupport) return;

  // In dev mode, check server setting (allows runtime toggle via settings UI)
  if (import.meta.env.DEV) {
    try {
      const response = await api.getServerSettings();
      if (!response.settings.serviceWorkerEnabled) {
        console.log(
          "[registerServiceWorker] Service worker disabled by server setting",
        );
        return;
      }
    } catch {
      // If settings fetch fails, proceed with SW enabled (fail open)
      console.warn(
        "[registerServiceWorker] Failed to fetch server settings, proceeding with SW enabled",
      );
    }
  }

  try {
    // Calling register() on an already-registered SW returns the existing registration
    const reg = await navigator.serviceWorker.register(SW_PATH);
    console.log(
      "[registerServiceWorker] Service worker registered:",
      reg.scope,
    );
  } catch (err) {
    console.error("[registerServiceWorker] Failed to register:", err);
  }
}