use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn show_existing(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn show_app_window(
    app: &AppHandle,
    label: &str,
    title: &str,
    url: &str,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(label) {
        show_existing(&window);
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;
    show_existing(&window);
    Ok(())
}

pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    show_app_window(app, "main", "Yep Anywhere", "index.html", 1100.0, 750.0)
}

pub fn show_dashboard_window(app: &AppHandle) -> Result<(), String> {
    show_app_window(
        app,
        "dashboard",
        "Yep Anywhere Dashboard",
        "index.html?view=dashboard",
        1100.0,
        750.0,
    )
}

pub fn show_server_output_window(app: &AppHandle) -> Result<(), String> {
    show_app_window(
        app,
        "server-output",
        "Yep Anywhere Server Output",
        "index.html?view=server-output",
        900.0,
        620.0,
    )
}

pub fn show_setup_window(app: &AppHandle) -> Result<(), String> {
    show_app_window(
        app,
        "setup",
        "Yep Anywhere Setup",
        "index.html?view=setup",
        900.0,
        720.0,
    )
}

#[tauri::command]
pub fn open_dashboard_window(app: AppHandle) -> Result<(), String> {
    show_dashboard_window(&app)
}

#[tauri::command]
pub fn open_server_output_window(app: AppHandle) -> Result<(), String> {
    show_server_output_window(&app)
}

#[tauri::command]
pub fn open_setup_window(app: AppHandle) -> Result<(), String> {
    show_setup_window(&app)
}
