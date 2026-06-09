mod config;
mod installer;
mod pty;
mod server;
mod tray;
mod windows;

use tauri::Manager;

#[tauri::command]
fn get_config() -> Result<config::AppConfig, String> {
    Ok(config::load_config())
}

#[tauri::command]
fn save_app_config(cfg: config::AppConfig) -> Result<(), String> {
    config::save_config(&cfg)
}

#[tauri::command]
fn get_data_dir() -> String {
    config::data_dir().to_string_lossy().to_string()
}

/// Returns the dev directory path if `YEP_DEV_DIR` is set, or null otherwise.
#[tauri::command]
fn is_dev_mode() -> Option<String> {
    config::dev_dir().map(|p| p.to_string_lossy().to_string())
}

pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init());

    // Desktop-only plugins
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder
        .manage(server::ServerState::new())
        .manage(pty::PtyState::new())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_app_config,
            get_data_dir,
            is_dev_mode,
            server::start_server,
            server::stop_server,
            server::get_server_status,
            server::get_desktop_token,
            server::get_server_port,
            server::get_server_output_buffer,
            installer::install_yep_server,
            installer::install_claude,
            installer::install_codex,
            installer::check_agent_installed,
            installer::check_claude_auth,
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            windows::open_dashboard_window,
            windows::open_server_output_window,
            windows::open_setup_window,
        ])
        .setup(|app| {
            let cfg = config::load_config();

            // Setup system tray
            tray::setup_tray(app.handle())?;

            if !cfg.setup_complete {
                windows::show_main_window(app.handle())?;
                return Ok(());
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = server::start_server(handle).await;
            });

            match cfg.startup_view {
                config::StartupView::Dashboard => {
                    windows::show_dashboard_window(app.handle())?;
                }
                config::StartupView::ServerOutput => {
                    windows::show_server_output_window(app.handle())?;
                }
                config::StartupView::TrayOnly => {}
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                let is_primary_surface =
                    matches!(label, "main" | "dashboard" | "server-output" | "setup");
                if !is_primary_surface {
                    return;
                }

                if config::load_config().run_in_background {
                    // Close to tray instead of quitting.
                    let _ = window.hide();
                    api.prevent_close();
                    return;
                }

                // Fully quit when background mode is disabled.
                api.prevent_close();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = server::stop_server(app.clone()).await;
                    app.exit(0);
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<server::ServerState>();
                state.kill_sync();
            }
        });
}
