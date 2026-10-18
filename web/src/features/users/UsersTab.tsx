import { useCallback, useEffect, useState } from "react";

import { api } from "../../api/client";
import type { Role, User } from "../../api/types";
import { ROLE_LABEL, useAuth } from "../../state/auth";
import { Spinner } from "../../ui/common";
import { useDialogs, type Option } from "../../ui/Dialogs";
import { MenuButton, type MenuItem } from "../../ui/Menu";
import { errorText, useToast } from "../../ui/Toasts";

/* Кому можно в интерфейс и с какой ролью. Пароли здесь не заводятся:
   их проверяет каталог (LDAP/AD), реестр хранит только логин и роль. */

const ROLE_OPTIONS: Option[] = [
  { value: "viewer", label: "Читатель", description: "просмотр каталога и проверка целей" },
  { value: "editor", label: "Редактор", description: "плюс правка приказов, правил, атрибутов и подразделений" },
  { value: "admin", label: "Администратор", description: "плюс удаление навсегда, ремонт данных и пользователи" },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU") : "—");

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; users: User[] };

export function UsersTab() {
  const { user: me } = useAuth();
  const { openForm, confirm } = useDialogs();
  const toast = useToast();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      setState({ kind: "ready", users: (await api.users()).users });
    } catch (err) {
      setState({ kind: "error", message: errorText(err) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const change = async (fn: () => Promise<unknown>, success: string) => {
    await fn();
    toast(success, "ok");
    await load();
  };
  const run = (fn: () => Promise<unknown>) => () => { fn().catch((err) => toast(errorText(err), "err")); };

  const add = () => openForm({
    title: "Новый пользователь", submitLabel: "Добавить",
    fields: [
      { name: "login", label: "Логин", required: true, placeholder: "i.ivanov",
        hint: "Тот же, что в домене, без домена: с ним пользователь входит." },
      { name: "displayName", label: "Имя", placeholder: "Иванов Иван" },
      { name: "role", label: "Роль", type: "select", value: "viewer", options: ROLE_OPTIONS },
    ],
    onSubmit: (v) => change(() => api.createUser({
      login: String(v.login), role: v.role as Role, displayName: String(v.displayName) || null,
    }), "Пользователь добавлен"),
  });

  const edit = (u: User) => () => openForm({
    title: "Пользователь " + u.login,
    fields: [
      { name: "displayName", label: "Имя", value: u.displayName ?? "" },
      // Свою роль менять нельзя: иначе администратор может остаться без доступа.
      ...(u.login === me.login ? [] : [
        { name: "role", label: "Роль", type: "select" as const, value: u.role, options: ROLE_OPTIONS },
      ]),
    ],
    onSubmit: (v) => change(() => api.patchUser(u.login, {
      displayName: String(v.displayName) || null, ...(v.role ? { role: v.role as Role } : {}),
    }), "Пользователь обновлён"),
  });

  const remove = (u: User) => run(async () => {
    const ok = await confirm({
      title: "Удалить пользователя?", danger: true, confirmLabel: "Удалить",
      message: <p><b>{u.login}</b> потеряет доступ к интерфейсу сразу. Учётная запись в домене не затрагивается.</p>,
    });
    if (ok) await change(() => api.deleteUser(u.login), "Пользователь удалён");
  });

  const menu = (u: User): MenuItem[] => [
    { label: "Изменить", run: edit(u) },
    ...(u.login === me.login ? [] : [
      null,
      u.status === "blocked"
        ? { label: "Разблокировать", run: run(() => change(() => api.patchUser(u.login, { status: "active" }), "Доступ возвращён")) }
        : { label: "Заблокировать", run: run(() => change(() => api.patchUser(u.login, { status: "blocked" }), "Доступ закрыт")) },
      { label: "Удалить", run: remove(u), danger: true },
    ]),
  ];

  return (
    <section id="tab-users">
      <div className="page-head">
        <div>
          <h1>Пользователи</h1>
          <div className="sub">Кому можно в интерфейс и с какой ролью. Пароль проверяет домен — здесь только логин и роль.</div>
        </div>
        <button className="btn primary" onClick={add}>+ Пользователь</button>
      </div>
      {state.kind === "loading" && <div className="card pad"><Spinner /> Загрузка…</div>}
      {state.kind === "error" && <div className="card pad"><span className="badge warn">{state.message}</span></div>}
      {state.kind === "ready" && (
        <div className="card"><table>
          <thead>
            <tr>
              <th style={{ width: "22%" }}>Логин</th><th>Имя</th><th style={{ width: "18%" }}>Роль</th>
              <th style={{ width: "20%" }}>Последний вход</th><th style={{ width: 70 }} />
            </tr>
          </thead>
          <tbody>
            {state.users.map((u) => (
              <tr key={u.login} className={u.status === "blocked" ? "is-archived" : ""} data-user={u.login}>
                <td>
                  <span className="mono">{u.login}</span>{" "}
                  {u.login === me.login && <span className="badge requirement">это вы</span>}
                  {u.status === "blocked" && <span className="badge archived">заблокирован</span>}
                </td>
                <td>{u.displayName || <span className="dim">—</span>}</td>
                <td>
                  {ROLE_LABEL[u.role]}
                  {u.builtin && <div className="small dim">задан в настройках сервера</div>}
                </td>
                <td className="dim">{when(u.lastLoginAt)}</td>
                <td><div className="actions">{!u.builtin && <MenuButton items={() => menu(u)} />}</div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
