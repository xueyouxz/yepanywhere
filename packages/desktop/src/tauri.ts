import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type StartupView = "dashboard" | "server_output" | "tray_only";

export interface AppConfig {
  setup_complete: boolean;
  agents: string[];
  /** User-specified port override. Undefined/null = auto-pick a free port on each launch. */
  port?: number | null;
  /** Backwards-compatible field for configs saved before startup_view. */
  start_minimized: boolean;
  startup_view: StartupView;
  run_in_background: boolean;
}

export interface ServerOutputChunk {
  sequence: number;
  stream: "stdout" | "stderr" | "system";
  data: string;
}

export async function getConfig(): Promise<AppConfig> {
  return invoke("get_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke("save_app_config", { cfg: config });
}

export async function getDataDir(): Promise<string> {
  return invoke("get_data_dir");
}

/** Returns the dev directory path if YEP_DEV_DIR is set, or null otherwise. */
export async function isDevMode(): Promise<string | null> {
  return invoke("is_dev_mode");
}

export async function startServer(): Promise<void> {
  return invoke("start_server");
}

export async function stopServer(): Promise<void> {
  return invoke("stop_server");
}

export async function getServerStatus(): Promise<string> {
  return invoke("get_server_status");
}

export async function getDesktopToken(): Promise<string | null> {
  return invoke("get_desktop_token");
}

export async function getServerPort(): Promise<number | null> {
  return invoke("get_server_port");
}

export async function getServerOutputBuffer(): Promise<ServerOutputChunk[]> {
  return invoke("get_server_output_buffer");
}

export async function openDashboardWindow(): Promise<void> {
  return invoke("open_dashboard_window");
}

export async function openServerOutputWindow(): Promise<void> {
  return invoke("open_server_output_window");
}

export async function openSetupWindow(): Promise<void> {
  return invoke("open_setup_window");
}

export async function installYepServer(): Promise<void> {
  return invoke("install_yep_server");
}

export async function installClaude(): Promise<void> {
  return invoke("install_claude");
}

export async function installCodex(): Promise<void> {
  return invoke("install_codex");
}

export async function checkAgentInstalled(agent: string): Promise<boolean> {
  return invoke("check_agent_installed", { agent });
}

export async function checkClaudeAuth(): Promise<boolean> {
  return invoke("check_claude_auth");
}

export async function spawnPty(
  command: string,
  args: string[],
): Promise<void> {
  return invoke("spawn_pty", { command, args });
}

export async function writePty(data: string): Promise<void> {
  return invoke("write_pty", { data });
}

export async function resizePty(cols: number, rows: number): Promise<void> {
  return invoke("resize_pty", { cols, rows });
}

export async function killPty(): Promise<void> {
  return invoke("kill_pty");
}

export interface InstallProgress {
  agent: string;
  status: string;
  message: string;
}

export function onInstallProgress(
  callback: (progress: InstallProgress) => void,
) {
  return listen<InstallProgress>("install-progress", (event) =>
    callback(event.payload),
  );
}

export function onPtyOutput(callback: (data: string) => void) {
  return listen<{ data: string }>("pty-output", (event) =>
    callback(event.payload.data),
  );
}

export function onPtyExit(callback: () => void) {
  return listen("pty-exit", () => callback());
}

export function onServerOutput(callback: (chunk: ServerOutputChunk) => void) {
  return listen<ServerOutputChunk>("server-output", (event) =>
    callback(event.payload),
  );
}
