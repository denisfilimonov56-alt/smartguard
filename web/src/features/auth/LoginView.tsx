import { useState } from "react";

import * as oidc from "../../lib/oidc";
import { Spinner } from "../../ui/common";
import { LoginOrbits } from "./LoginOrbits";

/* Экран входа по макету «Орбиты»: эмблема в центре графа-орбит (LoginOrbits),
   под ним заголовок и одна кнопка. Логин и пароль здесь не спрашиваются:
   кнопка уводит на страницу входа Keycloak, оттуда возвращаются уже с токеном
   (lib/oidc.ts). */

export function LoginView({ notice }: { notice?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setBusy(true);
    setError("");
    try {
      await oidc.login();   // страница уходит в Keycloak; сюда управление не вернётся
    } catch (err) {
      setError(err instanceof Error ? err.message : "Сервис входа недоступен");
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <header className="login-head">Проверка целей<small>каталог требований</small></header>
      <main className="login-main">
        <LoginOrbits />
        <span className="login-tag">Вход</span>
        <h1>Проверка целей по приказам</h1>
        {notice && !error && <div className="alert">{notice}</div>}
        {error && <div className="alert danger" role="alert">{error}</div>}
        <button type="button" className="btn primary login-btn" disabled={busy} onClick={() => void start()}>
          {busy ? <><Spinner /> Переход ко входу…</> : <>
            Войти
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
          </>}
        </button>
      </main>
      <footer className="login-foot">Версия {__APP_VERSION__}</footer>
    </div>
  );
}
