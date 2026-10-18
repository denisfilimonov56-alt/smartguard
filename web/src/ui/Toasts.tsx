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
/** Больше пяти уведомлений разом не показывается: самое старое уступает место новому. */
const MAX_TOASTS = 5;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 300);
  }, []);

  const toast = useCallback<ToastFn>((message, kind = "") => {
    const id = ++nextId;
    setToasts((list) => [...list.filter((t) => !t.leaving).slice(-(MAX_TOASTS - 1)), { id, message, kind, leaving: false }]);
    setTimeout(() => dismiss(id), 4200);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div id="toasts">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`toast ${t.kind}`} title="Скрыть" onClick={() => dismiss(t.id)}
            style={t.leaving ? { opacity: 0, transform: "translateY(6px)", transition: ".3s", pointerEvents: "none" } : undefined}>
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
