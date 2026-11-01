import type { CheckStatus } from "../api/types";

/* Недавние проверки одной цели — в localStorage этого браузера, отдельно для
   каждого логина. Нужны, чтобы повторить проверку щелчком и подставить
   подразделение прошлой проверки. История на сервере (monitoring/history)
   доступна только администратору, поэтому список ведёт сам интерфейс.
   Хранилище может быть недоступно (приватный режим) — тогда списка просто нет. */

export interface RecentCheck {
  goal: string;
  departmentId: string;
  isStudent: boolean;
  status: CheckStatus;
  /** Время проверки, ISO. */
  at: string;
}

/** Сколько проверок помнится; на экране сразу видно три (CheckView). */
const LIMIT = 20;
const key = (login: string) => "gc.recent:" + login;

export function readRecent(login: string): RecentCheck[] {
  try {
    const raw = localStorage.getItem(key(login));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((r) => r && typeof r.goal === "string").slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

/** Добавить проверку в начало списка; та же цель с теми же параметрами не повторяется. */
export function pushRecent(login: string, entry: RecentCheck): RecentCheck[] {
  const same = (r: RecentCheck) =>
    r.goal === entry.goal && r.departmentId === entry.departmentId && r.isStudent === entry.isStudent;
  const next = [entry, ...readRecent(login).filter((r) => !same(r))].slice(0, LIMIT);
  try {
    localStorage.setItem(key(login), JSON.stringify(next));
  } catch { /* приватный режим: список живёт до перезагрузки */ }
  return next;
}
