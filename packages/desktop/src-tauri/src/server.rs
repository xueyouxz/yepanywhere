use rand::Rng;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tokio::process::{Child, Command};

use crate::config;

pub struct ServerState {
    pub child: Mutex<Option<Child>>,
    pub desktop_token: Mutex<Option<String>>,
    /// The port the server is actually running on (auto-picked or user-specified).
    pub port: Mutex<Option<u16>>,
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            desktop_token: Mutex::new(None),
            port: Mutex::new(None),
        }
    }

    /// Synchronously kill the server process and its entire process group.
    /// Called during app exit when the async runtime may not be available.
    pub fn kill_sync(&self) {
        if let Ok(mut lock) = self.child.lock() {
            if let Some(ref mut child) = *lock {
                if let Some(pid) = child.id() {
                    #[cfg(unix)]
                    unsafe {
                        // Kill the entire process group (negative PID = PGID).
                        // Works because we set process_group(0) on spawn.
                        libc::kill(-(pid as i32), libc::SIGTERM);
                    }
                    #[cfg(not(unix))]
                    {
                        let _ = child.start_kill();
                    }
                }
            }
            *lock = None;
        }
    }
}

/// Generate a 32-byte random hex token for desktop auth.
fn generate_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Resolve the bundled Bun sidecar binary path.
/// Tauri places externalBin sidecars next to the main executable (Contents/MacOS/).
fn bun_path(_app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Could not resolve executable: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "Could not resolve executable directory".to_string())?;
    let bin_name = if cfg!(windows) { "bun.exe" } else { "bun" };
    let path = exe_dir.join(bin_name);
    if path.exists() {
        return Ok(path);
    }
    Err(format!("Bun sidecar not found at {}", path.display()))
}

/// Find the yep server entry point.
fn server_entry() -> Result<std::path::PathBuf, String> {
    let installed = config::data_dir()
        .join("node_modules")
        .join("yepanywhere")
        .join("dist")
        .join("index.js");
    if installed.exists() {
        return Ok(installed);
    }

    Err("Yep Anywhere server not found. Run setup first.".to_string())
}

/// Resolve the Codex CLI installed by the desktop setup flow, if present.
fn desktop_codex_path() -> Option<std::path::PathBuf> {
    let bin_name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let path = config::bin_dir().join(bin_name);
    path.exists().then_some(path)
}

/// Mark the child server as desktop-launched and pass desktop-owned tool paths.
fn apply_desktop_server_env(cmd: &mut Command) {
    cmd.env("YEP_DESKTOP", "1");
    if let Some(path) = desktop_codex_path() {
        cmd.env(
            "YEP_DESKTOP_CODEX_CLI_PATH",
            path.to_string_lossy().as_ref(),
        );
    }
}

/// Set up child process for clean shutdown: kill-on-drop and own process group.
fn setup_child_process(cmd: &mut Command) {
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
}

#[tauri::command]
pub async fn start_server(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ServerState>();

    {
        let child_lock = state.child.lock().map_err(|e| e.to_string())?;
        if child_lock.is_some() {
            return Err("Server is already running".to_string());
        }
    }

    let cfg = config::load_config();
    let data_dir = config::data_dir();
    let token = generate_token();

    // Resolve port: use user override or auto-pick a free port.
    let port = match cfg.port {
        Some(p) => p,
        None => {
            let listener = std::net::TcpListener::bind("127.0.0.1:0")
                .map_err(|e| format!("Failed to find free port: {e}"))?;
            let addr = listener.local_addr().map_err(|e| e.to_string())?;
            addr.port()
            // listener is dropped here, freeing the port for the server
        }
    };

    let child = if let Some(dev_dir) = config::dev_dir() {
        // Dev mode: run `pnpm dev` from local source.
        // Use a login shell so pnpm/node are on PATH (GUI apps have minimal PATH).
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = Command::new(&shell);
        cmd.args(["--login", "-c", "exec pnpm dev"])
            .current_dir(&dev_dir)
            .env("PORT", port.to_string())
            .env("YEP_ANYWHERE_DATA_DIR", data_dir.to_string_lossy().as_ref())
            .env("DESKTOP_AUTH_TOKEN", &token);
        apply_desktop_server_env(&mut cmd);
        setup_child_process(&mut cmd);
        cmd.spawn()
            .map_err(|e| format!("Failed to start dev server in {}: {e}", dev_dir.display()))?
    } else {
        // Production mode: use bundled bun + installed npm package.
        let bun = bun_path(&app)?;
        let entry = server_entry()?;
        let mut cmd = Command::new(&bun);
        cmd.arg("run")
            .arg(&entry)
            .env("NODE_ENV", "production")
            .env("PORT", port.to_string())
            .env("YEP_ANYWHERE_DATA_DIR", data_dir.to_string_lossy().as_ref())
            .env("DESKTOP_AUTH_TOKEN", &token);
        apply_desktop_server_env(&mut cmd);
        setup_child_process(&mut cmd);
        cmd.spawn()
            .map_err(|e| format!("Failed to start server: {e}"))?
    };

    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;
    *child_lock = Some(child);

    let mut token_lock = state.desktop_token.lock().map_err(|e| e.to_string())?;
    *token_lock = Some(token);

    let mut port_lock = state.port.lock().map_err(|e| e.to_string())?;
    *port_lock = Some(port);

    Ok(())
}

#[tauri::command]
pub async fn stop_server(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ServerState>();

    // Take the child out of the mutex so we don't hold the lock across .await
    let child = {
        let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;
        child_lock.take()
    };

    // Clear the desktop token and port
    {
        let mut token_lock = state.desktop_token.lock().map_err(|e| e.to_string())?;
        *token_lock = None;
    }
    {
        let mut port_lock = state.port.lock().map_err(|e| e.to_string())?;
        *port_lock = None;
    }

    if let Some(mut child) = child {
        child.kill().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_server_status(app: AppHandle) -> Result<String, String> {
    let state = app.state::<ServerState>();
    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;

    match child_lock.as_mut() {
        None => Ok("stopped".to_string()),
        Some(child) => match child.try_wait() {
            Ok(Some(_status)) => {
                *child_lock = None;
                Ok("stopped".to_string())
            }
            Ok(None) => Ok("running".to_string()),
            Err(e) => Err(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn get_desktop_token(app: AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<ServerState>();
    let token_lock = state.desktop_token.lock().map_err(|e| e.to_string())?;
    Ok(token_lock.clone())
}

#[tauri::command]
pub async fn get_server_port(app: AppHandle) -> Result<Option<u16>, String> {
    let state = app.state::<ServerState>();
    let port_lock = state.port.lock().map_err(|e| e.to_string())?;
    Ok(*port_lock)
}
