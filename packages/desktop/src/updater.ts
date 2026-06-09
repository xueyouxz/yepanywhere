import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

const STARTUP_CHECK_DELAY_MS = 5_000;
const PERIODIC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

type CheckReason = "startup" | "periodic" | "manual";

let initialized = false;
let checkInFlight = false;

export function initUpdater(): void {
  if (initialized) return;
  initialized = true;

  listen("check-for-updates", () => {
    void checkForUpdates("manual");
  });

  window.setTimeout(() => {
    void checkForUpdates("startup");
  }, STARTUP_CHECK_DELAY_MS);

  window.setInterval(() => {
    void checkForUpdates("periodic");
  }, PERIODIC_CHECK_INTERVAL_MS);
}

async function checkForUpdates(reason: CheckReason): Promise<void> {
  if (checkInFlight || document.getElementById("desktop-updater-overlay")) {
    return;
  }

  checkInFlight = true;
  try {
    const update = await check({
      headers: { "X-Check-Reason": reason },
    });
    if (update) {
      showUpdateDialog(update);
    } else if (reason === "manual") {
      showInfoDialog("You are running the latest version.");
    }
  } catch (error) {
    console.error("Update check failed:", error);
    if (reason === "manual") {
      showInfoDialog(`Failed to check for updates: ${String(error)}`);
    }
  } finally {
    checkInFlight = false;
  }
}

function showInfoDialog(message: string): void {
  const overlay = createOverlay();
  const dialog = getDialog(overlay);
  dialog.innerHTML = `
    <h2>Updates</h2>
    <p>${escapeHtml(message)}</p>
    <div class="desktop-updater-actions">
      <button class="desktop-updater-btn" data-action="close">OK</button>
    </div>
  `;
  dialog.querySelector('[data-action="close"]')?.addEventListener("click", () => {
    overlay.remove();
  });
}

function showUpdateDialog(update: Update): void {
  const overlay = createOverlay();
  const dialog = getDialog(overlay);
  dialog.innerHTML = `
    <h2>Update Available</h2>
    <p>Version <strong>${escapeHtml(update.version)}</strong> is available.</p>
    ${
      update.body
        ? `<div class="desktop-updater-notes">${escapeHtml(update.body)}</div>`
        : ""
    }
    <div class="desktop-updater-progress" style="display:none">
      <div class="desktop-updater-progress-bar">
        <div class="desktop-updater-progress-fill"></div>
      </div>
      <p class="desktop-updater-status">Downloading...</p>
    </div>
    <div class="desktop-updater-actions">
      <button class="desktop-updater-btn primary" data-action="install">Install and Restart</button>
      <button class="desktop-updater-btn" data-action="later">Later</button>
    </div>
  `;

  dialog.querySelector('[data-action="later"]')?.addEventListener("click", () => {
    overlay.remove();
  });

  dialog
    .querySelector('[data-action="install"]')
    ?.addEventListener("click", () => {
      void installUpdate(update, dialog);
    });
}

async function installUpdate(update: Update, dialog: Element): Promise<void> {
  const actions = dialog.querySelector(".desktop-updater-actions") as HTMLElement;
  const progress = dialog.querySelector(
    ".desktop-updater-progress",
  ) as HTMLElement;
  const fill = dialog.querySelector(
    ".desktop-updater-progress-fill",
  ) as HTMLElement;
  const status = dialog.querySelector(".desktop-updater-status") as HTMLElement;

  actions.style.display = "none";
  progress.style.display = "block";

  let downloaded = 0;
  let contentLength = 0;

  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started" && event.data.contentLength) {
        contentLength = event.data.contentLength;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (contentLength > 0) {
          const pct = Math.min(100, (downloaded / contentLength) * 100);
          fill.style.width = `${pct}%`;
        }
      } else if (event.event === "Finished") {
        fill.style.width = "100%";
        status.textContent = "Installing...";
      }
    });
    await relaunch();
  } catch (error) {
    console.error("Update install failed:", error);
    status.textContent = `Update failed: ${String(error)}`;
    actions.style.display = "";
    actions.innerHTML = `
      <button class="desktop-updater-btn" data-action="close">Close</button>
    `;
    actions.querySelector('[data-action="close"]')?.addEventListener("click", () => {
      document.getElementById("desktop-updater-overlay")?.remove();
    });
  }
}

function createOverlay(): HTMLElement {
  document.getElementById("desktop-updater-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "desktop-updater-overlay";
  overlay.innerHTML = `<div class="desktop-updater-dialog"></div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function getDialog(overlay: HTMLElement): HTMLElement {
  return overlay.querySelector(".desktop-updater-dialog") as HTMLElement;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
