import { useState } from "react";

import * as oidc from "../../lib/oidc";
import { Spinner } from "../../ui/common";
import { LoginEmblem } from "./LoginEmblem";

/* Экран входа: слева синяя карточка с заголовком, строкой о пользе, тремя чипами
   возможностей и одной кнопкой, справа эмблема
   из частиц (LoginEmblem). Только светлый вариант — в тёмной теме экран входа тоже светлый.
   Логин и пароль здесь не спрашиваются: кнопка уводит на страницу входа
   Keycloak, оттуда возвращаются уже с токеном (lib/oidc.ts). */

// Возможности сервиса — чипы под заголовком: подпись и контур иконки 16×16.
const FEATURES: [string, string][] = [
  ["Пункты приказов", "M4 2h5l3 3v9H4zM6 8h4M6 11h4"],
  ["Понятные замечания", "M8 2a6 6 0 110 12A6 6 0 018 2zM5.5 8.2l1.8 1.8 3.4-3.6"],
  ["Пакетная проверка", "M8 2l6 3-6 3-6-3zM2 8.5l6 3 6-3M2 11.5l6 3 6-3"],
];

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
      <header className="login-head">SmartGuard<small>проверка целей по приказам</small></header>
      <main className="login-main">
        <h1>Проверка целей<br />по приказам</h1>
        <p className="login-lead">Сверяет формулировку цели с правилами из приказов и подсказывает, что исправить</p>
        <ul className="login-chips">
          {FEATURES.map(([label, d]) => (
            <li key={label}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
              {label}
            </li>
          ))}
        </ul>
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
