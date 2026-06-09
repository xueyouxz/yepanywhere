import {
  openDashboardWindow,
  openServerOutputWindow,
  openSetupWindow,
} from "../tauri";

export function LauncherView() {
  return (
    <div className="launcher-view">
      <div className="desktop-titlebar" data-tauri-drag-region />
      <main className="launcher-content">
        <h1>Yep Anywhere</h1>
        <div className="launcher-actions">
          <button className="btn-primary" onClick={openDashboardWindow}>
            Open Dashboard
          </button>
          <button className="btn-secondary" onClick={openServerOutputWindow}>
            Server Output
          </button>
          <button className="btn-secondary" onClick={openSetupWindow}>
            Setup / Repair
          </button>
        </div>
      </main>
    </div>
  );
}
