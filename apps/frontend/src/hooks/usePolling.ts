import { useEffect, useRef } from "react";

export function usePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled: boolean,
): void {
  const callbackRef = useRef(callback);
  const inFlightRef = useRef<Promise<void> | null>(null);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    const interval = setInterval(() => {
      if (
        disposed ||
        document.visibilityState !== "visible" ||
        inFlightRef.current
      ) {
        return;
      }

      const pending = Promise.resolve()
        .then(() => callbackRef.current())
        .finally(() => {
          if (inFlightRef.current === pending) {
            inFlightRef.current = null;
          }
        });

      inFlightRef.current = pending;
    }, intervalMs);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [intervalMs, enabled]);
}
