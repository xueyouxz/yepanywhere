use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};
use tauri_plugin_autostart::ManagerExt as _;

use crate::config::{self, StartupView};

fn sync_startup_view_items(
    view: StartupView,
    dashboard_item: &CheckMenuItem<tauri::Wry>,
    server_output_item: &CheckMenuItem<tauri::Wry>,
    tray_only_item: &CheckMenuItem<tauri::Wry>,
) {
    let _ = dashboard_item.set_checked(view == StartupView::Dashboard);
    let _ = server_output_item.set_checked(view == StartupView::ServerOutput);
    let _ = tray_only_item.set_checked(view == StartupView::TrayOnly);
}

fn save_startup_view(
    view: StartupView,
    dashboard_item: &CheckMenuItem<tauri::Wry>,
    server_output_item: &CheckMenuItem<tauri::Wry>,
    tray_only_item: &CheckMenuItem<tauri::Wry>,
    run_in_background_item: &CheckMenuItem<tauri::Wry>,
) {
    let mut cfg = config::load_config();
    let previous = cfg.startup_view;
    let previous_run_in_background = cfg.run_in_background;
    cfg.startup_view = view;
    cfg.start_minimized = view == StartupView::TrayOnly;
    if view == StartupView::TrayOnly {
        cfg.run_in_background = true;
    }
    match config::save_config(&cfg) {
        Ok(()) => {
            sync_startup_view_items(view, dashboard_item, server_output_item, tray_only_item);
            let _ = run_in_background_item.set_checked(cfg.run_in_background);
        }
        Err(err) => {
            eprintln!("Failed to save startup view setting: {err}");
            sync_startup_view_items(previous, dashboard_item, server_output_item, tray_only_item);
            let _ = run_in_background_item.set_checked(previous_run_in_background);
        }
    }
}

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let cfg = config::load_config();

    let open = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
    let server_output = MenuItem::with_id(
        app,
        "server-output",
        "Open Server Output",
        true,
        None::<&str>,
    )?;
    let setup = MenuItem::with_id(app, "setup", "Setup / Repair", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart Server", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at Login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let run_in_background = CheckMenuItem::with_id(
        app,
        "run-in-background",
        "Run in Background",
        true,
        cfg.run_in_background,
        None::<&str>,
    )?;
    let startup_dashboard = CheckMenuItem::with_id(
        app,
        "startup-dashboard",
        "Dashboard",
        true,
        cfg.startup_view == StartupView::Dashboard,
        None::<&str>,
    )?;
    let startup_server_output = CheckMenuItem::with_id(
        app,
        "startup-server-output",
        "Server Output",
        true,
        cfg.startup_view == StartupView::ServerOutput,
        None::<&str>,
    )?;
    let startup_tray_only = CheckMenuItem::with_id(
        app,
        "startup-tray-only",
        "Tray Only",
        true,
        cfg.startup_view == StartupView::TrayOnly,
        None::<&str>,
    )?;
    let startup_view = SubmenuBuilder::new(app, "Startup View")
        .item(&startup_dashboard)
        .item(&startup_server_output)
        .item(&startup_tray_only)
        .build()?;
    let settings = SubmenuBuilder::new(app, "Settings")
        .item(&autostart)
        .item(&run_in_background)
        .item(&startup_view)
        .build()?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &server_output,
            &setup,
            &restart,
            &sep1,
            &settings,
            &sep2,
            &quit,
        ],
    )?;

    let autostart_item = autostart.clone();
    let run_in_background_item = run_in_background.clone();
    let startup_dashboard_item = startup_dashboard.clone();
    let startup_server_output_item = startup_server_output.clone();
    let startup_tray_only_item = startup_tray_only.clone();

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("Yep Anywhere")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => {
                let _ = crate::windows::show_dashboard_window(app);
            }
            "server-output" => {
                let _ = crate::windows::show_server_output_window(app);
            }
            "setup" => {
                let _ = crate::windows::show_setup_window(app);
            }
            "autostart" => {
                let was_enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let should_enable = !was_enabled;
                let result = if should_enable {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                };
                match result {
                    Ok(()) => {
                        let _ = autostart_item.set_checked(should_enable);
                    }
                    Err(err) => {
                        eprintln!("Failed to update autostart: {err}");
                        let _ = autostart_item.set_checked(was_enabled);
                    }
                }
            }
            "run-in-background" => {
                let mut cfg = config::load_config();
                cfg.run_in_background = !cfg.run_in_background;
                if !cfg.run_in_background && cfg.startup_view == StartupView::TrayOnly {
                    cfg.startup_view = StartupView::Dashboard;
                    cfg.start_minimized = false;
                }
                match config::save_config(&cfg) {
                    Ok(()) => {
                        let _ = run_in_background_item.set_checked(cfg.run_in_background);
                        sync_startup_view_items(
                            cfg.startup_view,
                            &startup_dashboard_item,
                            &startup_server_output_item,
                            &startup_tray_only_item,
                        );
                    }
                    Err(err) => {
                        eprintln!("Failed to save run-in-background setting: {err}");
                        let _ = run_in_background_item.set_checked(!cfg.run_in_background);
                    }
                }
            }
            "startup-dashboard" => {
                save_startup_view(
                    StartupView::Dashboard,
                    &startup_dashboard_item,
                    &startup_server_output_item,
                    &startup_tray_only_item,
                    &run_in_background_item,
                );
            }
            "startup-server-output" => {
                save_startup_view(
                    StartupView::ServerOutput,
                    &startup_dashboard_item,
                    &startup_server_output_item,
                    &startup_tray_only_item,
                    &run_in_background_item,
                );
            }
            "startup-tray-only" => {
                save_startup_view(
                    StartupView::TrayOnly,
                    &startup_dashboard_item,
                    &startup_server_output_item,
                    &startup_tray_only_item,
                    &run_in_background_item,
                );
            }
            "restart" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::server::stop_server(app.clone()).await;
                    let _ = crate::server::start_server(app).await;
                });
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::server::stop_server(app.clone()).await;
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let _ = crate::windows::show_dashboard_window(app);
            }
        })
        .build(app)?;

    Ok(())
}
