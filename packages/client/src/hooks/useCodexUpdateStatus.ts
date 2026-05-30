import { useCallback, useEffect, useRef, useState } from "react";
import { type CodexUpdateStatus, api } from "../api/client";

interface UseCodexUpdateStatusResult {
  status: CodexUpdateStatus | null;
  isChecking: boolean;
  isInstalling: boolean;
  error: string | null;
  installOutput: string | null;
  refresh: (force?: boolean) => Promise<void>;
  install: () => Promise<boolean>;
}

export function useCodexUpdateStatus(): UseCodexUpdateStatusResult {
  const [status, setStatus] = useState<CodexUpdateStatus | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installOutput, setInstallOutput] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async (force?: boolean) => {
    try {
      setIsChecking(true);
      setError(null);
      const response = await api.getCodexUpdateStatus(force);
      if (mounted.current) setStatus(response.status);
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : "Failed to check");
      }
    } finally {
      if (mounted.current) setIsChecking(false);
    }
  }, []);

  const install = useCallback(async (): Promise<boolean> => {
    try {
      setIsInstalling(true);
      setError(null);
      setInstallOutput(null);
      const result = await api.installCodexUpdate();
      if (mounted.current) {
        setStatus(result.status);
        setInstallOutput(result.output || null);
        if (!result.success) {
          setError(result.error ?? "Install failed");
        }
      }
      return result.success;
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : "Install request failed");
      }
      return false;
    } finally {
      if (mounted.current) setIsInstalling(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const onFocus = () => {
      refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return {
    status,
    isChecking,
    isInstalling,
    error,
    installOutput,
    refresh,
    install,
  };
}
