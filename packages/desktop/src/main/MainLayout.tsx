import { useEffect, useState } from "react";
import {
  getDesktopToken,
  getServerPort,
  getServerStatus,
} from "../tauri";

export function MainLayout() {
  const [serverStatus, setServerStatus] = useState<string>("checking");
  const [port, setPort] = useState<number | null>(null);

  useEffect(() => {
    const check = () => {
      getServerStatus()
        .then(setServerStatus)
        .catch(() => setServerStatus("error"));
    };
    check();
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, []);

  // Fetch the active port from server state once it's running
  useEffect(() => {
    if (serverStatus !== "running") {
      setPort(null);
      return;
    }
    if (port != null) return;

    const poll = async () => {
      for (let i = 0; i < 50; i++) {
        const p = await getServerPort();
        if (p != null) {
          setPort(p);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    poll();
  }, [serverStatus, port]);

  // Poll /health, then navigate webview to server URL
  useEffect(() => {
    if (serverStatus !== "running" || port == null) return;

    let cancelled = false;
    const serverUrl = `http://localhost:${port}`;
    const poll = async () => {
      // Wait for HTTP server to be ready. The Tauri webview starts on
      // tauri://localhost, so reading the response would require server CORS.
      // We only need to know that localhost accepted the request before
      // navigating into the same-origin app.
      while (!cancelled) {
        try {
          await fetch(`${serverUrl}/health`, { mode: "no-cors" });
          break;
        } catch {
          // Server not ready yet
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (cancelled) return;

      // Fetch desktop auth token and navigate
      try {
        const token = await getDesktopToken();
        const url = token
          ? `${serverUrl}/?desktop_token=${token}`
          : serverUrl;
        window.location.href = url;
      } catch {
        window.location.href = serverUrl;
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [serverStatus, port]);

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-secondary)",
      }}
    >
      {serverStatus === "error"
        ? "Server error. Use tray menu to restart."
        : serverStatus === "stopped"
          ? "Server stopped. Use tray menu to restart."
        : "Starting server..."}
    </div>
  );
}
