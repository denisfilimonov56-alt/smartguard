import { useCallback, useEffect, useState } from "react";

import { api } from "../../api/client";
import type { Role, User } from "../../api/types";
import { ROLE_LABEL, useAuth } from "../../state/auth";
import { PageHead, Skeleton } from "../../ui/common";
import { useDialogs, type Option } from "../../ui/Dialogs";
import { MenuButton, type MenuItem } from "../../ui/Menu";
import { errorText, useToast } from "../../ui/Toasts";

/* Кому можно в интерфейс и с какой ролью. Пароли здесь не заводятся:
   кто пользователь, подтверждает Keycloak, реестр хранит только логин и роль. */

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
        hint: "Тот же, что в Keycloak (в домене — без домена): с ним пользователь входит." },
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
        // Записи без роли (доступ не назначен) роль назначается здесь же.
        { name: "role", label: "Роль", type: "select" as const, value: u.role ?? "viewer", options: ROLE_OPTIONS },
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

  // Учётную запись в Keycloak пересоздали (новый sub) у того же человека — без снятия
  // привязки он получит отказ; следующий вход привяжет запись заново.
  const unbind = (u: User) => run(async () => {
    const ok = await confirm({
      title: "Снять привязку к учётной записи?", confirmLabel: "Снять привязку",
      message: <>
        <p>Запись <b>{u.login}</b> привязана к учётной записи Keycloak, с которой входили первый раз.
          После снятия привязки её займёт тот, кто следующим войдёт с этим логином.</p>
        <p className="muted">Нужно, когда учётную запись в Keycloak пересоздали у того же человека.</p>
      </>,
    });
    if (ok) await change(() => api.unbindUser(u.login), "Привязка снята");
  });

  const menu = (u: User): MenuItem[] => [
    // Администратор из настроек сервера здесь не меняется — только привязка.
    ...(u.builtin ? [] : [{ label: "Изменить", run: edit(u) }]),
    ...(u.bound ? [{ label: "Снять привязку к учётной записи", run: unbind(u) }] : []),
    ...(u.login === me.login || u.builtin ? [] : [
      null,
      ...(u.role === null ? [] : [u.status === "blocked"
        ? { label: "Разблокировать", run: run(() => change(() => api.patchUser(u.login, { status: "active" }), "Доступ возвращён")) }
        : { label: "Заблокировать", run: run(() => change(() => api.patchUser(u.login, { status: "blocked" }), "Доступ закрыт")) }]),
      { label: "Удалить", run: remove(u), danger: true },
    ]),
  ];

  return (
    <section id="tab-users">
      <PageHead title="Пользователи" sub="Кому можно в интерфейс и с какой ролью. Пароль проверяет Keycloak — здесь только логин и роль.">
        <button className="btn primary" onClick={add}>+ Пользователь</button>
      </PageHead>
      {state.kind === "loading" && <Skeleton rows={3} />}
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
                  {u.role ? ROLE_LABEL[u.role] : <span className="dim">доступ не назначен</span>}
                  {u.builtin && <div className="small dim">задан в настройках сервера</div>}
                  {u.bound && <div className="small dim" title="Вход принимается только с этой учётной записью Keycloak">
                    привязан к учётной записи</div>}
                </td>
                <td className="dim">{when(u.lastLoginAt)}</td>
                <td><div className="actions">{(!u.builtin || u.bound) && <MenuButton items={() => menu(u)} />}</div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
