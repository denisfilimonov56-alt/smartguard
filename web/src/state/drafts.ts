import { useEffect, useRef } from "react";

/* Черновики форм на время повторного входа. Вход в Keycloak — только
   переходом на его страницу, и страница при этом выгружается: всё, что было
   в памяти React, пропадает. Поэтому перед уходом на вход формы отдают свои
   несохранённые значения сюда, они кладутся в sessionStorage (та же вкладка,
   как и токены), а после возврата формы забирают их обратно.

   Черновик принадлежит логину: если после входа оказался другой
   пользователь, черновики выбрасываются, не показываясь. Старше часа —
   тоже. Каждый черновик отдаётся один раз. */

const KEY = "gc.drafts";
const TTL_MS = 60 * 60 * 1000;

interface Stored {
  owner: string;
  savedAt: number;
  items: Record<string, unknown>;
}

/** Источник черновика: текущее значение формы или undefined, если сохранять нечего. */
type Source = () => unknown;

const sources = new Map<string, Source>();
let restored: Record<string, unknown> = {};

/** Подписать форму на сохранение перед уходом на вход; вернуть функцию отписки. */
export function registerDraft(key: string, source: Source): () => void {
  sources.set(key, source);
  return () => { if (sources.get(key) === source) sources.delete(key); };
}

/** Собрать черновики всех открытых форм и положить их в хранилище вкладки. */
export function saveDrafts(owner: string) {
  const items: Record<string, unknown> = {};
  for (const [key, source] of sources) {
    try {
      const value = source();
      if (value !== undefined) items[key] = value;
    } catch { /* сломанный источник не мешает остальным */ }
  }
  try {
    if (Object.keys(items).length) sessionStorage.setItem(KEY, JSON.stringify({ owner, savedAt: Date.now(), items } satisfies Stored));
    else sessionStorage.removeItem(KEY);
  } catch { /* хранилище недоступно или переполнено: черновики не переживут вход */ }
}

/** После входа: принять черновики, если они того же пользователя и свежие; хранилище очищается.
    Возвращает, сколько черновиков принято. */
export function adoptDrafts(owner: string): number {
  restored = {};
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    const stored = raw ? (JSON.parse(raw) as Stored) : null;
    if (stored && stored.owner === owner && Date.now() - stored.savedAt < TTL_MS && stored.items) restored = stored.items;
  } catch { /* испорченный черновик просто не восстанавливается */ }
  return Object.keys(restored).length;
}

/** Забыть черновики (выход). */
export function discardDrafts() {
  restored = {};
  try { sessionStorage.removeItem(KEY); } catch { /* нечего очищать */ }
}

/** Есть ли невостребованный черновик (например, чтобы сначала открыть мастер, который его заберёт). */
export const hasDraft = (key: string) => key in restored;

/** Забрать восстановленный черновик; второй вызов вернёт undefined. */
export function takeDraft<T>(key: string): T | undefined {
  if (!(key in restored)) return undefined;
  const value = restored[key] as T;
  delete restored[key];
  return value;
}

/** Черновик формы: сохраняется перед повторным входом и подставляется после него.
    toDraft возвращает undefined, когда сохранять нечего (форма пуста). */
export function useDraft<T, D = T>(key: string, value: T, restore: (draft: D) => void,
  toDraft: (value: T) => D | undefined = (v) => v as unknown as D) {
  const latest = useRef({ value, toDraft });
  latest.current = { value, toDraft };
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useEffect(() => registerDraft(key, () => latest.current.toDraft(latest.current.value)), [key]);
  useEffect(() => {
    const draft = takeDraft<D>(key);
    if (draft !== undefined) restoreRef.current(draft);
  }, [key]);
}
