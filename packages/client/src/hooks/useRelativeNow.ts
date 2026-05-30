import { useEffect, useState } from "react";

export function useRelativeNow(intervalMs = 30 * 1000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);
    return () => window.clearInterval(intervalId);
  }, [intervalMs]);

  return nowMs;
}
