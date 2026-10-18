import { useState, type FormEvent } from "react";

import { api } from "../../api/client";
import type { Account } from "../../api/types";
import logo from "../../assets/logo.png";
import { Spinner } from "../../ui/common";
import { errorText } from "../../ui/Toasts";

/* Вход доменной учётной записью. Пароль уходит только в API и нигде
   в интерфейсе не сохраняется; после отправки поле очищается. */

export function LoginView({ notice, onLogin }: { notice?: string; onLogin: (user: Account) => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!login.trim() || !password) { setError("Введите логин и пароль"); return; }
    setBusy(true);
    setError("");
    try {
      onLogin(await api.login(login.trim(), password));
    } catch (err) {
      setError(errorText(err));
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit} noValidate>
        <div className="brand" style={{ padding: "0 0 18px" }}>
          <img src={logo} alt="" />
          <div>Проверка целей<small>каталог требований</small></div>
        </div>
        <h2>Вход</h2>
        <p className="muted" style={{ margin: "6px 0 16px" }}>Доменная учётная запись. Доступ назначает администратор.</p>
        {notice && !error && <div className="alert" style={{ marginBottom: 14 }}>{notice}</div>}
        <div className="field">
          <label htmlFor="loginInput">Логин</label>
          <input type="text" id="loginInput" autoComplete="username" autoCapitalize="none" spellCheck={false}
            autoFocus value={login} onChange={(e) => setLogin(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="passwordInput">Пароль</label>
          <input type="password" id="passwordInput" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <div className="alert danger" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
        <button type="submit" className="btn primary" style={{ width: "100%" }} disabled={busy}>
          {busy ? <><Spinner /> Вход…</> : "Войти"}
        </button>
      </form>
    </div>
  );
}
