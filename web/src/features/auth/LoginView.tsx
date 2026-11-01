import { useState } from "react";

import * as oidc from "../../lib/oidc";
import { Spinner } from "../../ui/common";
import { LoginEmblem } from "./LoginEmblem";

/* Экран входа: справа эмблема из частиц (LoginEmblem), слева заголовок и одна
   кнопка. Только белый вариант — в тёмной теме экран входа тоже белый.
   Логин и пароль здесь не спрашиваются: кнопка уводит на страницу входа
   Keycloak, оттуда возвращаются уже с токеном (lib/oidc.ts). */

export function LoginView({ notice }: { notice?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

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
      <LoginEmblem active={hover || focus} leaving={busy} />
      <header className="login-head">SmartGuard</header>
      <main className="login-main">
        <span className="login-tag">Вход</span>
        <h1>Проверка <span className="accent">целей</span><br />по приказам</h1>
        {notice && !error && <div className="alert">{notice}</div>}
        {error && <div className="alert danger" role="alert">{error}</div>}
        <button type="button" className="login-btn" disabled={busy} onClick={() => void start()}
          onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}>
          {busy ? <><Spinner /> Переход ко входу…</> : <>
            Войти
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path className="shaft" d="M3 8h10" /><path className="head" d="M9 4l4 4-4 4" />
            </svg>
          </>}
        </button>
      </main>
      <footer className="login-foot">Версия {__APP_VERSION__}</footer>
    </div>
  );
}
