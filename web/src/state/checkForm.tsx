import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";

import { api, isAborted, type BatchItemProgress, type BatchProgress, type CheckProgress } from "../api/client";
import type { BatchCheck, CheckResult } from "../api/types";
import { CHUNK, checkedResults, mergeBatch, runBatch, type WaitReason } from "../features/check/batch";
import { errorText, useToast } from "../ui/Toasts";
import { useAuth } from "./auth";

/* Форма «Проверки цели» и идущие проверки. Отдельно от каталога: ввод в форму
   перерисовывает только её потребителей, а не всё, что читает каталог. Здесь же
   живёт пакет, который идёт: уход со страницы его не теряет и не позволяет
   запустить второй параллельно. */

/** Строка пакетной проверки: цель, её подразделение и идентификатор из внешней системы. */
export interface BatchRow {
  key: string;
  id: string;
  goal: string;
  /** Пусто — берётся подразделение, выбранное на странице. */
  departmentId: string;
  /** Цель ставит студент: проверяются и правила только для студентов. */
  isStudent: boolean;
  /** Значение столбца «Студент» из файла, которое не удалось понять; isStudent тогда false. */
  studentText?: string;
  /** Номер строки листа Excel, из которой цель загружена. */
  line?: number;
}

/** Последняя пакетная проверка: строки, по которым она шла, подразделение по умолчанию и ответ API. */
export interface BatchSnapshot {
  rows: BatchRow[];
  fallback: string;
  result: BatchCheck;
}

/** С какими значениями формы шла проверка одной цели, чей ответ лежит в result. */
export interface CheckedWith {
  /** Формулировка, как она ушла в API (после trim). */
  goal: string;
  departmentId: string;
  isStudent: boolean;
}

/** Ответ относится к тому, что сейчас в форме: та же формулировка, подразделение и признак студента.
    Формулировка сравнивается с отправленной, а не с result.goal: API обрезает пробелы
    по-своему (Python strip не трогает BOM), и ответ не должен из-за этого пропадать. */
export const resultMatches = (form: Pick<CheckForm, "goal" | "departmentId" | "isStudent" | "checked">) =>
  !!form.checked && form.checked.goal === form.goal.trim()
  && form.checked.departmentId === form.departmentId && form.checked.isStudent === form.isStudent;

/** Форма «Проверки цели»: живёт над разделами, чтобы пережить уход на другую страницу. */
export interface CheckForm {
  /** Одна цель или несколько сразу. */
  mode: "single" | "batch";
  goal: string;
  /** Подразделение одной цели; в пакете — для строк, где оно не указано. */
  departmentId: string;
  /** Одну цель ставит студент. */
  isStudent: boolean;
  result: CheckResult | null;
  /** Параметры запроса, на который получен result. */
  checked: CheckedWith | null;
  rows: BatchRow[];
  batch: BatchSnapshot | null;
}

export const EMPTY_CHECK_FORM: CheckForm = {
  mode: "single", goal: "", departmentId: "", isStudent: false, result: null, checked: null, rows: [], batch: null,
};

/** Идущий пакет: сколько проверено и как его остановить. */
export interface BatchRun {
  running: boolean;
  done: number;
  total: number;
  /** API занят другими пакетами (503) или исчерпан лимит проверок (429): через сколько секунд
      повтор части; null — не ждём. */
  waiting: number | null;
  /** Почему ждём: занята очередь пакетов или лимит проверок в минуту. */
  waitReason: WaitReason | null;
  /** Остановить: текущий запрос или ожидание повтора отменяется, проверенное остаётся. */
  stop: () => void;
  /** Запустить пакет; пока идёт другой — ничего не делает. onlyPending — проверить только строки
      без ответа или изменённые после проверки, а прежние ответы остальных строк оставить. */
  start: (rows: BatchRow[], fallback: string, onlyPending?: boolean) => Promise<void>;
  /** Ход идущего или последнего пакета; null — API хода не отдаёт или пакета ещё не было. */
  live: BatchLive | null;
}

/** Ход пакета, собранный из всех его частей (каждая часть — свой запрос со своим ходом). */
export interface BatchLive {
  startedAt: number;
  finished: boolean;
  elapsedSeconds: number;
  /** Сколько целей отправлено (без строк, ответ которых остался с прошлого раза). */
  total: number;
  /** Ход цели по ключу строки таблицы. */
  items: Record<string, BatchItemProgress>;
  tokens: { prompt: number; completion: number };
  tokensPerSecond: number | null;
  stageSeconds: BatchProgress["stageSeconds"];
}

/** Время шагов двух частей вместе. */
function addStages(a: BatchProgress["stageSeconds"], b: BatchProgress["stageSeconds"]): BatchProgress["stageSeconds"] {
  const sum: BatchProgress["stageSeconds"] = { ...a };
  for (const [key, value] of Object.entries(b) as [keyof typeof b, { total: number; count: number }][]) {
    const prev = sum[key];
    sum[key] = prev ? { total: prev.total + value.total, count: prev.count + value.count } : value;
  }
  return sum;
}

/** Идущая проверка одной цели. */
export interface SingleRun {
  busy: boolean;
  /** Проверить; пока идёт прежняя проверка — false без запроса. true — ответ получен и показан. */
  run: (goal: string, departmentId: string, isStudent: boolean) => Promise<boolean>;
  /** Ход идущей или последней проверки (шаги и время); null — API хода не отдаёт. */
  progress: CheckProgress | null;
}

/** Как часто спрашивать ход проверки, мс. */
const PROGRESS_POLL_MS = 400;
/** Номер проверки для X-Check-Id: randomUUID есть только в защищённом контексте (https, localhost). */
const newCheckId = () => globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

type Patch = Partial<CheckForm> | ((prev: CheckForm) => Partial<CheckForm>);

interface CheckFormState {
  checkForm: CheckForm;
  setCheckForm: (patch: Patch) => void;
  batchRun: BatchRun;
  single: SingleRun;
}

const Context = createContext<CheckFormState | null>(null);

/** Доступ к форме без подписки на её изменения: прочитать текущее значение в момент
    действия и поменять. Не меняется между рендерами — тем, кто берёт только его
    (обучение), ввод в форму перерисовок не стоит. */
export interface CheckFormControl {
  get: () => CheckForm;
  set: (patch: Patch) => void;
}
const ControlContext = createContext<CheckFormControl | null>(null);

export function useCheckForm() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useCheckForm вне CheckFormProvider");
  return ctx;
}

export function useCheckFormControl() {
  const ctx = useContext(ControlContext);
  if (!ctx) throw new Error("useCheckFormControl вне CheckFormProvider");
  return ctx;
}

export function CheckFormProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const { user, goalMaxChars } = useAuth();
  const [checkForm, setCheckFormState] = useState<CheckForm>(EMPTY_CHECK_FORM);
  // Последнее значение формы — и то, что ещё не отрисовано: control.get() после set() видит правку.
  const latest = useRef(checkForm);
  latest.current = checkForm;
  const setCheckForm = useCallback((patch: Patch) => {
    const next = { ...latest.current, ...(typeof patch === "function" ? patch(latest.current) : patch) };
    latest.current = next;
    setCheckFormState(next);
  }, []);
  const control = useMemo<CheckFormControl>(() => ({ get: () => latest.current, set: setCheckForm }), [setCheckForm]);

  // Размер части — не больше предела API (MAX_GOALS_PER_REQUEST из /auth/me).
  const limit = user.limits?.maxGoalsPerRequest;
  const chunk = limit && limit > 0 ? Math.min(CHUNK, limit) : CHUNK;

  const [progress, setProgress] = useState<{
    done: number; total: number; waiting: number | null; waitReason: WaitReason | null;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    // Выход размонтирует форму: идущий пакет останавливается вместе с ней.
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);

  const stop = useCallback(() => controller.current?.abort(), []);
  const [live, setLive] = useState<BatchLive | null>(null);

  const start = useCallback(async (rows: BatchRow[], fallback: string, onlyPending = false) => {
    if (controller.current || !rows.length) return;
    // Продолжение: строки с действующим ответом не отправляются снова и не тратят лимит проверок.
    const kept = onlyPending ? checkedResults(rows, fallback, latest.current.batch) : rows.map(() => undefined);
    const todo = rows.filter((_, i) => !kept[i]);
    if (!todo.length) return;
    const keptCount = rows.length - todo.length;
    const ctrl = new AbortController();
    controller.current = ctrl;
    setProgress({ done: keptCount, total: rows.length, waiting: null, waitReason: null });
    if (!keptCount) setCheckForm({ batch: null });
    let partial: BatchCheck | null = null;
    // Ход частей складывается в один: готовые части — в base, идущая — поверх неё.
    const keys = todo.map((r) => r.key);
    const startedAt = Date.now();
    let base: Pick<BatchLive, "items" | "tokens" | "stageSeconds"> =
      { items: {}, tokens: { prompt: 0, completion: 0 }, stageSeconds: {} };
    setLive(null);
    const onLive = (offset: number, part: BatchProgress, final: boolean) => {
      const items = { ...base.items };
      for (const item of part.items) if (keys[offset + item.index]) items[keys[offset + item.index]] = item;
      const tokens = { prompt: base.tokens.prompt + part.tokens.prompt,
        completion: base.tokens.completion + part.tokens.completion };
      const stageSeconds = addStages(base.stageSeconds, part.stageSeconds);
      if (final) base = { items, tokens, stageSeconds };
      const elapsed = (Date.now() - startedAt) / 1000;
      if (mounted.current) setLive({ startedAt, finished: false, elapsedSeconds: elapsed, total: todo.length, items, tokens,
        stageSeconds, tokensPerSecond: elapsed > 0.5 ? Math.round(tokens.completion / elapsed) : null });
    };
    try {
      const result = await runBatch(todo, fallback, chunk, (part) => {
        partial = part;
        setProgress({ done: keptCount + part.results.length, total: rows.length, waiting: null, waitReason: null });
      }, ctrl.signal, (waiting, reason) => setProgress((p) => (p ? { ...p, waiting, waitReason: waiting === null ? null : reason } : p)),
      onLive);
      setCheckForm({ batch: mergeBatch(rows, fallback, kept, result.results) });
      // Пакет на сервере остановили по сроку: часть целей не проверена, их надо отправить снова.
      const unchecked = result.results.filter((r) => r.unchecked).length;
      if (unchecked && mounted.current)
        toast(`Не проверено целей: ${unchecked} — пакет не уложился в отведённое время. `
          + "Нажмите «Проверить оставшиеся»", "err");
    } catch (err) {
      // Что успели проверить, не теряется: ответ показывается по проверенным строкам,
      // а «Проверить оставшиеся» продолжит с первой непроверенной.
      const done = partial as BatchCheck | null;
      if (done || keptCount) setCheckForm({ batch: mergeBatch(rows, fallback, kept, done?.results ?? []) });
      const count = keptCount + (done?.results.length ?? 0);
      const checked = count ? `. Проверено ${count} из ${rows.length}` : "";
      if (!mounted.current) return;
      if (isAborted(err)) toast(`Проверка остановлена${checked}`, "ok");
      else toast(`Проверка прервана: ${errorText(err)}${checked}`, "err");
    } finally {
      controller.current = null;
      setProgress(null);
      // Пакет закончился (или его остановили): ход остаётся с итоговым временем.
      if (mounted.current) setLive((l) => l && { ...l, finished: true, elapsedSeconds: (Date.now() - startedAt) / 1000 });
    }
  }, [chunk, setCheckForm, toast]);

  const batchRun = useMemo<BatchRun>(() => ({
    running: progress !== null, done: progress?.done ?? 0, total: progress?.total ?? 0,
    waiting: progress?.waiting ?? null, waitReason: progress?.waitReason ?? null, stop, start, live,
  }), [progress, stop, start, live]);

  // Одна цель: пока идёт проверка, повторный запуск (кнопка, Ctrl+Enter, советчик) не шлёт второй запрос.
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [checkProgress, setCheckProgress] = useState<CheckProgress | null>(null);
  const run = useCallback(async (goal: string, departmentId: string, isStudent: boolean) => {
    const text = goal.trim();
    if (!text) { toast("Введите формулировку цели", "err"); return false; }
    if (text.length > goalMaxChars) { toast(`Цель длиннее ${goalMaxChars} символов: сократите формулировку`, "err"); return false; }
    if (!departmentId) { toast("Выберите подразделение: без него проверка не запускается", "err"); return false; }
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setCheckForm({ result: null, checked: null });
    setCheckProgress(null);
    // Ход проверки опрашивается, пока ждём ответ; последний снимок остаётся с временем шагов.
    // API, который хода не отдаёт (404 и прочие ошибки), опрашивать дальше незачем.
    const checkId = newCheckId();
    let polling = true;
    const poll = async () => {
      while (polling) {
        await new Promise((resolve) => setTimeout(resolve, PROGRESS_POLL_MS));
        if (!polling) return;
        try {
          const next = await api.checkProgress(checkId);
          if (mounted.current) setCheckProgress(next);
        } catch {
          return;
        }
      }
    };
    void poll();
    try {
      const result = await api.checkGoal(text, departmentId, isStudent, undefined, checkId);
      polling = false;
      // Финальный снимок: все шаги завершены, видно время каждого.
      try {
        const last = await api.checkProgress(checkId);
        if (mounted.current) setCheckProgress(last);
      } catch { /* хода нет — показываем только ответ */ }
      // Ответ хранится вместе с тем, о чём спрашивали: если за время проверки поменяли
      // подразделение или признак студента, он не покажется под новыми значениями.
      setCheckForm({ result, checked: { goal: text, departmentId, isStudent } });
      return true;
    } catch (err) {
      if (mounted.current) toast(errorText(err), "err");
      return false;
    } finally {
      polling = false;
      busyRef.current = false;
      setBusy(false);
    }
  }, [goalMaxChars, setCheckForm, toast]);

  const single = useMemo<SingleRun>(() => ({ busy, run, progress: checkProgress }), [busy, run, checkProgress]);

  const value = useMemo<CheckFormState>(() => ({ checkForm, setCheckForm, batchRun, single }),
    [checkForm, setCheckForm, batchRun, single]);
  return (
    <ControlContext.Provider value={control}>
      <Context.Provider value={value}>{children}</Context.Provider>
    </ControlContext.Provider>
  );
}

