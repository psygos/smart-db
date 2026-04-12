import { useCallback, useEffect, useRef, useState } from "react";

export type ToastType = "success" | "error" | "info";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

const AUTO_DISMISS_MS: Record<ToastType, number | null> = {
  success: 3500,
  info: 4500,
  error: null,  // sticky until dismissed
};

const MAX_VISIBLE = 3;

let nextId = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastType = "info") => {
      const id = `toast-${++nextId}`;
      let dedupedId: string | null = null;
      setToasts((current) => {
        const existing = current.find(
          (toast) => toast.message === message && toast.type === type,
        );
        if (existing) {
          dedupedId = existing.id;
          return current;
        }

        // Cap visible toasts; drop oldest of same type
        const next = [...current, { id, message, type }];
        if (next.length > MAX_VISIBLE) {
          const dropped = next.shift();
          if (dropped) {
            const timer = timersRef.current.get(dropped.id);
            if (timer !== undefined) {
              clearTimeout(timer);
              timersRef.current.delete(dropped.id);
            }
          }
        }
        return next;
      });

      if (dedupedId) {
        return dedupedId;
      }

      const dismissAfter = AUTO_DISMISS_MS[type];
      if (dismissAfter !== null) {
        const timer = setTimeout(() => {
          dismissToast(id);
        }, dismissAfter);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [dismissToast],
  );

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  return { toasts, addToast, dismissToast };
}
