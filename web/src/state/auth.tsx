import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api, ApiError, setSessionLostHandler } from "../api/client";
import type { Account, Role } from "../api/types";
import { LoginView } from "../features/auth/LoginView";
import { Spinner } from "../ui/common";

/* Кто вошёл и что ему можно. Пока входа нет, вместо приложения показывается
   форма: каталог не запрашивается и в памяти страницы не лежит. Скрытые
   кнопки — удобство, а не защита: права проверяет API на каждом запросе. */

export const ROLE_LABEL: Record<Role, string> = {
  viewer: "читатель", editor: "редактор", admin: "администратор",
};

interface AuthState {
  user: Account;
  /** Редактор и администратор: правка каталога. */
  canEdit: boolean;
  /** Физическое удаление, ремонт идентификаторов, пользователи. */
  isAdmin: boolean;
  logout: () => Promise<void>;
}

const Context = createContext<AuthState | null>(null);

export function useAuth() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useAuth вне AuthProvider");
  return ctx;
}

type Stage =
  | { kind: "loading" }
  | { kind: "anonymous"; notice?: string }
  | { kind: "offline" }
  | { kind: "in"; user: Account };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });

  const restore = useCallback(async () => {
    setStage({ kind: "loading" });
    try {
      setStage({ kind: "in", user: await api.me() });
    } catch (err) {
      setStage(err instanceof ApiError && err.status === 401 ? { kind: "anonymous" } : { kind: "offline" });
    }
  }, []);

  useEffect(() => { void restore(); }, [restore]);

  useEffect(() => {
    setSessionLostHandler(() => setStage((current) =>
      current.kind === "in" ? { kind: "anonymous", notice: "Сессия завершена. Войдите снова." } : current));
    return () => setSessionLostHandler(null);
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* сессия на сервере истечёт сама */ }
    setStage({ kind: "anonymous" });
  }, []);

  const value = useMemo<AuthState | null>(() => stage.kind !== "in" ? null : {
    user: stage.user,
    canEdit: stage.user.role !== "viewer",
    isAdmin: stage.user.role === "admin",
    logout,
  }, [stage, logout]);

  if (stage.kind === "loading") return <div className="login-page"><Spinner /></div>;
  if (stage.kind === "offline") {
    return (
      <div className="login-page">
        <div className="card login-card">
          <span className="badge warn">API недоступен</span>
          <p className="muted" style={{ margin: "12px 0 16px" }}>Не удалось связаться с сервером.</p>
          <button className="btn primary" onClick={() => void restore()}>Повторить</button>
        </div>
      </div>
    );
  }
  if (!value) {
    return <LoginView notice={stage.kind === "anonymous" ? stage.notice : undefined}
      onLogin={(user) => setStage({ kind: "in", user })} />;
  }
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
