import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  getServerOutputBuffer,
  getServerStatus,
  onServerOutput,
  openDashboardWindow,
  openSetupWindow,
  startServer,
  stopServer,
  type ServerOutputChunk,
} from "../tauri";

function normalizeTerminalText(data: string): string {
  return data.replace(/\r?\n/g, "\r\n");
}

export function ServerOutputView() {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const seenSequencesRef = useRef<Set<number>>(new Set());
  const [serverStatus, setServerStatus] = useState("checking");
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      convertEol: true,
      scrollback: 10000,
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        selectionBackground: "#3b82f655",
      },
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      disableStdin: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();
    terminalRef.current = term;

    const writeChunk = (chunk: ServerOutputChunk) => {
      if (seenSequencesRef.current.has(chunk.sequence)) return;
      seenSequencesRef.current.add(chunk.sequence);
      term.write(normalizeTerminalText(chunk.data));
    };

    const unlistenOutput = onServerOutput(writeChunk);
    getServerOutputBuffer()
      .then((chunks) => {
        for (const chunk of chunks) {
          writeChunk(chunk);
        }
      })
      .catch((error) => {
        term.writeln(`Error loading server output: ${String(error)}`);
      });

    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(termRef.current);

    return () => {
      unlistenOutput.then((fn) => fn());
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
    };
  }, []);

  const restart = async () => {
    setBusy(true);
    try {
      await stopServer();
      await startServer();
      setServerStatus("running");
    } catch (error) {
      terminalRef.current?.writeln(`\r\nError restarting server: ${String(error)}`);
      getServerStatus()
        .then(setServerStatus)
        .catch(() => setServerStatus("error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="server-output-view">
      <div className="desktop-titlebar" data-tauri-drag-region />
      <header className="server-output-toolbar">
        <div>
          <h1>Server Output</h1>
          <div className="server-output-status">{serverStatus}</div>
        </div>
        <div className="server-output-actions">
          <button className="btn-secondary" onClick={openDashboardWindow}>
            Dashboard
          </button>
          <button className="btn-secondary" onClick={openSetupWindow}>
            Setup
          </button>
          <button className="btn-secondary" onClick={restart} disabled={busy}>
            {busy ? "Restarting..." : "Restart"}
          </button>
        </div>
      </header>
      <div ref={termRef} className="server-output-terminal" />
    </div>
  );
}
