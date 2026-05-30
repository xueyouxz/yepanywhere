import { useCallback, useState } from "react";
import { generateUUID } from "../lib/uuid";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: "error" | "success" | "info";
  action?: ToastAction;
}

const TOAST_TIMEOUT_MS = 3000;
const ACTION_TOAST_TIMEOUT_MS = 7000;

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback(
    (message: string, type: Toast["type"] = "info", action?: ToastAction) => {
      const id = generateUUID();
      setToasts((prev) => [...prev, { id, message, type, action }]);

      // Action toasts stay readable long enough to use the action.
      const timeout = action ? ACTION_TOAST_TIMEOUT_MS : TOAST_TIMEOUT_MS;
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, timeout);
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, showToast, dismissToast };
}
