import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export type ToastKind = "" | "ok" | "err";
type ToastFn = (message: string, kind?: ToastKind) => void;

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  leaving: boolean;
}

const ToastContext = createContext<ToastFn>(() => {});

export const useToast = () => useContext(ToastContext);

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback<ToastFn>((message, kind = "") => {
    const id = ++nextId;
    setToasts((list) => [...list, { id, message, kind, leaving: false }]);
    setTimeout(() => setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t))), 4200);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4600);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div id="toasts">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`toast ${t.kind}`}
            style={t.leaving ? { opacity: 0, transition: ".3s" } : undefined}>
            <span className="toast-ico" aria-hidden="true">{t.kind === "ok" ? "✓" : t.kind === "err" ? "✕" : "i"}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Сообщение ошибки для показа пользователю. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
