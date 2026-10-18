import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, ApiError, setSessionLostHandler } from "../api/client";
import type { Account, AccountLimits, Role } from "../api/types";
import { LoginView } from "../features/auth/LoginView";
import * as oidc from "../lib/oidc";
import { Spinner } from "../ui/common";
import { Overlay } from "../ui/Dialogs";
import { useToast } from "../ui/Toasts";
import { adoptDrafts, discardDrafts, saveDrafts } from "./drafts";

/* Кто вошёл и что ему можно. Вход — через Keycloak (lib/oidc.ts): пока его
   нет, вместо приложения показывается экран входа: каталог не запрашивается
   и в памяти страницы не лежит. Скрытые кнопки — удобство, а не защита:
   права проверяет API на каждом запросе.

   Сессия посреди работы. Пока пользователь что-то делает во вкладке, токен
   продлевается заранее, за минуту до истечения: Keycloak считает сессию
   живой, и долгий ввод в форму её не роняет. Если сессия всё же кончилась
   (простой дольше таймаута Keycloak, сессию закрыли), приложение не
   размонтируется: поверх него окно «Сессия завершена». Войти снова можно
   только переходом на страницу Keycloak, поэтому перед переходом черновики
   открытых форм кладутся в хранилище вкладки (state/drafts.ts) и после
   возврата подставляются обратно. */

export const ROLE_LABEL: Record<Role, string> = {
  viewer: "читатель", editor: "редактор", admin: "администратор",
};

interface AuthState {
  user: Account;
  /** Редактор и администратор: правка каталога. */
  canEdit: boolean;
  /** Физическое удаление, ремонт идентификаторов, пользователи. */
  isAdmin: boolean;
  /** Обучение по интерфейсу уже пройдено или пропущено. */
  tourSeen: boolean;
  /** Предел длины цели в символах: из /auth/me (настройка goalMaxChars), у старого API — 4000. */
  goalMaxChars: number;
  /** Администратор поменял предел в «Настройках»: интерфейс применяет его сразу, без повторного входа. */
  updateLimits: (patch: Partial<AccountLimits>) => void;
  /** Пройдено или пропущено сейчас: больше не показывать ни здесь, ни на другом компьютере. */
  markTourSeen: () => void;
  logout: () => Promise<void>;
}

const Context = createContext<AuthState | null>(null);

export function useAuth() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useAuth вне AuthProvider");
  return ctx;
}

export const SESSION_ENDED = "Сессия завершена. Войдите снова.";

/** Предел длины цели, если API его не отдал (версии до настройки goalMaxChars). */
const GOAL_MAX_CHARS_FALLBACK = 4000;

/* За сколько до истечения access-токена продлевать его в фоне и как часто это проверять. */
const RENEW_BEFORE_MS = 60_000;
const RENEW_CHECK_MS = 15_000;
/* Общий ответ API на запрос без действующего токена (api/auth.py LOGIN_REQUIRED):
   вместо него — «Сессия завершена», любой другой detail показывается как есть. */
const GENERIC_401 = new Set(["Требуется вход"]);
const sessionNotice = (message: string) =>
  !message || GENERIC_401.has(message) || /^HTTP \d+$/.test(message) ? SESSION_ENDED : message;

type Stage =
  | { kind: "loading" }
  | { kind: "anonymous"; notice?: string }
  /** В Keycloak вошли, но роли в реестре нет или доступ закрыт. */
  | { kind: "denied"; message: string }
  /** Сервис входа или API не ответили; title — заголовок плашки, message — пояснение (detail API как есть). */
  | { kind: "offline"; title?: string; message?: string }
  | { kind: "in"; user: Account };

export function AuthProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  /** Сессия кончилась посреди работы: приложение остаётся на месте, поверх — окно входа.
      Строка — detail отказа API, если он не общий «Требуется вход». */
  const [lost, setLost] = useState<string | null>(null);
  /** Окно «Сессия завершена» отложено кнопкой «Не сейчас»: вместо него плашка сверху,
      и новые отказы фоновых опросов окно не поднимают — его открывает только сам пользователь. */
  const [lostDeferred, setLostDeferred] = useState(false);

  const restore = useCallback(async () => {
    setStage({ kind: "loading" });
    setLost(null);
    setLostDeferred(false);
    try {
      if (!(await oidc.restore())) { setStage({ kind: "anonymous" }); return; }
      const user = await api.me();
      // Черновики форм, сохранённые перед повторным входом, — только тому же пользователю.
      if (adoptDrafts(user.login)) toast("Несохранённый ввод восстановлен после входа", "ok");
      setStage({ kind: "in", user });
    } catch (err) {
      if (err instanceof oidc.OidcError) {
        setStage(err.offline ? { kind: "offline", title: "Сервис входа недоступен", message: err.message }
          : { kind: "anonymous", notice: err.message });
      } else if (err instanceof ApiError && err.status === 401) {
        // Токен есть, но API его не принял: истёк или выдан не этому серверу.
        oidc.clear();
        setStage({ kind: "anonymous", notice: sessionNotice(err.message) });
      } else if (err instanceof ApiError && err.status === 403) {
        // Подлинный токен, но пустить нельзя (чужой клиент, логин, блокировка): detail API как есть.
        setStage({ kind: "denied", message: err.message });
      } else if (err instanceof ApiError && err.status > 0) {
        // API ответил ошибкой (например, 503 «Настройки сервиса не прочитаны»): его текст как есть.
        setStage({ kind: "offline", title: "Сервис недоступен", message: err.message });
      } else {
        setStage({ kind: "offline" });
      }
    }
  }, [toast]);

  useEffect(() => { void restore(); }, [restore]);

  const signedIn = stage.kind === "in";
  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;
  const sessionLost = useCallback((detail = "", userAction = false) => {
    if (!signedInRef.current) return;   // при входе 401 разбирает restore()
    oidc.clear();
    const notice = sessionNotice(detail);
    setLost(notice === SESSION_ENDED ? "" : notice);
    // Отложенное окно снова открывает только действие пользователя (изменяющий запрос),
    // фоновые опросы оставляют плашку.
    if (userAction) setLostDeferred(false);
  }, []);

  useEffect(() => {
    setSessionLostHandler(sessionLost);
    return () => setSessionLostHandler(null);
  }, [sessionLost]);

  // Продление в фоне: только пока вкладка видна и пользователь с ней работает
  // (клавиатура, мышь) с прошлого продления. Брошенная вкладка не держит сессию
  // вечно — она истечёт по таймауту простоя Keycloak, как и задумано.
  useEffect(() => {
    if (!signedIn) return;
    let activity = 0;
    let renewed = Date.now();
    let busy = false;
    const touch = () => { activity = Date.now(); };
    const events = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const name of events) addEventListener(name, touch, { capture: true, passive: true });
    const check = async () => {
      if (busy || document.visibilityState === "hidden") return;
      const expires = oidc.expiresAt();
      if (expires === null || expires - Date.now() > RENEW_BEFORE_MS || activity <= renewed) return;
      busy = true;
      renewed = Date.now();
      try {
        if (!(await oidc.extend())) sessionLost("", false);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void check(), RENEW_CHECK_MS);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      for (const name of events) removeEventListener(name, touch, { capture: true });
    };
  }, [signedIn, sessionLost]);

  // Отметка выхода в журнале API, затем выход из Keycloak: он вернёт на экран входа.
  const logout = useCallback(async () => {
    discardDrafts();
    try { await api.logout(); } catch { /* журнал — не повод не выйти */ }
    await oidc.logout();
  }, []);

  // Отметка ставится сразу и на сервере; если сервер не ответил, обучение
  // просто покажется ещё раз при следующем входе.
  const markTourSeen = useCallback(() => {
    setStage((current) => current.kind === "in" && !current.user.tourSeenAt
      ? { kind: "in", user: { ...current.user, tourSeenAt: new Date().toISOString() } } : current);
    api.markTourSeen().catch(() => undefined);
  }, []);

  const updateLimits = useCallback((patch: Partial<AccountLimits>) => {
    setStage((current) => current.kind === "in" && current.user.limits
      ? { kind: "in", user: { ...current.user, limits: { ...current.user.limits, ...patch } } } : current);
  }, []);

  const value = useMemo<AuthState | null>(() => stage.kind !== "in" ? null : {
    user: stage.user,
    canEdit: stage.user.role !== "viewer",
    isAdmin: stage.user.role === "admin",
    tourSeen: !!stage.user.tourSeenAt,
    goalMaxChars: stage.user.limits?.goalMaxChars || GOAL_MAX_CHARS_FALLBACK,
    updateLimits,
    markTourSeen,
    logout,
  }, [stage, logout, markTourSeen, updateLimits]);

  if (stage.kind === "loading") return <div className="login-page"><Spinner /></div>;
  if (stage.kind === "offline") {
    return (
      <div className="login-page">
        <div className="card login-card">
          <span className="badge warn">{stage.title ?? "API недоступен"}</span>
          <p className="muted" style={{ margin: "12px 0 16px" }}>{stage.message ?? "Не удалось связаться с сервером."}</p>
          <button className="btn primary" onClick={() => void restore()}>Повторить</button>
        </div>
      </div>
    );
  }
  if (stage.kind === "denied") {
    return (
      <div className="login-page">
        <div className="card login-card" role="alert">
          <span className="badge warn">Нет доступа</span>
          <p className="muted" style={{ margin: "12px 0 16px" }}>{stage.message}</p>
          <button className="btn primary" onClick={() => void oidc.logout()}>Войти другой учётной записью</button>
        </div>
      </div>
    );
  }
  if (!value) return <LoginView notice={stage.kind === "anonymous" ? stage.notice : undefined} />;
  return (
    <Context.Provider value={value}>
      {children}
      {lost !== null && (lostDeferred
        ? <SessionLostBar onOpen={() => setLostDeferred(false)} />
        : <SessionLost login={value.user.login} detail={lost} onDismiss={() => setLostDeferred(true)} />)}
    </Context.Provider>
  );
}

/** Плашка вместо отложенного окна «Сессия завершена»: не мешает читать и копировать,
    «Войти» открывает окно снова. */
function SessionLostBar({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="session-bar" role="status">
      <span>Сессия завершена</span>
      <button type="button" className="btn primary sm" onClick={onOpen}>Войти</button>
    </div>
  );
}

/** Окно «Сессия завершена» поверх приложения: ничего не размонтировано, ввод на месте.
    «Войти снова» сохраняет черновики форм и уходит в Keycloak; «Не сейчас» оставляет
    на странице (например, скопировать текст) с плашкой «Сессия завершена — Войти»:
    фоновые опросы окно больше не поднимают, его открывает кнопка на плашке или
    следующее изменяющее действие пользователя (сохранение, проверка), отклонённое API. */
function SessionLost({ login, detail, onDismiss }: { login: string; detail: string; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Escape здесь — «Не сейчас», и только: окна и меню под ним его не получают.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onDismiss();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [onDismiss]);

  async function relogin() {
    setBusy(true);
    setError("");
    saveDrafts(login);
    try {
      await oidc.login();   // страница уходит в Keycloak; сюда управление не вернётся
    } catch (err) {
      setError(err instanceof Error ? err.message : "Сервис входа недоступен");
      setBusy(false);
    }
  }

  return (
    <div className="session-lost">
      <Overlay>
        <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="sessionLostTitle">
          <h3 id="sessionLostTitle">Сессия завершена</h3>
          <div className="content">
            <p style={{ margin: 0 }}>
              Вход истёк или закрыт в сервисе входа. Войдите снова — несохранённый ввод в открытых
              формах сохранится и вернётся на место после входа. Последнее действие, на котором
              закончилась сессия, повторите после входа.
            </p>
            {detail && <div className="alert" style={{ marginTop: 12 }}>{detail}</div>}
            {error && <div className="alert danger" role="alert" style={{ marginTop: 12 }}>{error}</div>}
          </div>
          <div className="foot">
            <button type="button" className="btn" onClick={onDismiss}>Не сейчас</button>
            <button type="button" className="btn primary" autoFocus disabled={busy} onClick={() => void relogin()}>
              {busy ? <><Spinner /> Переход ко входу…</> : "Войти снова"}
            </button>
          </div>
        </div>
      </Overlay>
    </div>
  );
}
