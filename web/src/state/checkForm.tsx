import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";

import { api, isAborted } from "../api/client";
import type { BatchCheck, CheckResult } from "../api/types";
import { CHUNK, runBatch } from "../features/check/batch";
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
  /** API занят другими пакетами (503): через сколько секунд повтор части; null — не ждём. */
  waiting: number | null;
  /** Остановить: текущий запрос или ожидание повтора отменяется, проверенное остаётся. */
  stop: () => void;
  /** Запустить пакет; пока идёт другой — ничего не делает. */
  start: (rows: BatchRow[], fallback: string) => Promise<void>;
}

/** Идущая проверка одной цели. */
export interface SingleRun {
  busy: boolean;
  /** Проверить; пока идёт прежняя проверка — false без запроса. true — ответ получен и показан. */
  run: (goal: string, departmentId: string, isStudent: boolean) => Promise<boolean>;
}

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

  const [progress, setProgress] = useState<{ done: number; total: number; waiting: number | null } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    // Выход размонтирует форму: идущий пакет останавливается вместе с ней.
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);

  const stop = useCallback(() => controller.current?.abort(), []);

  const start = useCallback(async (rows: BatchRow[], fallback: string) => {
    if (controller.current || !rows.length) return;
    const ctrl = new AbortController();
    controller.current = ctrl;
    setProgress({ done: 0, total: rows.length, waiting: null });
    setCheckForm({ batch: null });
    let partial: BatchCheck | null = null;
    try {
      const result = await runBatch(rows, fallback, chunk, (part) => {
        partial = part;
        setProgress({ done: part.results.length, total: rows.length, waiting: null });
      }, ctrl.signal, (waiting) => setProgress((p) => (p ? { ...p, waiting } : p)));
      setCheckForm({ batch: { rows, fallback, result } });
    } catch (err) {
      // Что успели проверить, не теряется: ответ показывается по проверенным строкам.
      const done = partial as BatchCheck | null;
      if (done) setCheckForm({ batch: { rows: rows.slice(0, done.results.length), fallback, result: done } });
      const checked = done ? `. Проверено ${done.results.length} из ${rows.length}` : "";
      if (!mounted.current) return;
      if (isAborted(err)) toast(`Проверка остановлена${checked}`, "ok");
      else toast(`Проверка прервана: ${errorText(err)}${checked}`, "err");
    } finally {
      controller.current = null;
      setProgress(null);
    }
  }, [chunk, setCheckForm, toast]);

  const batchRun = useMemo<BatchRun>(() => ({
    running: progress !== null, done: progress?.done ?? 0, total: progress?.total ?? 0,
    waiting: progress?.waiting ?? null, stop, start,
  }), [progress, stop, start]);

  // Одна цель: пока идёт проверка, повторный запуск (кнопка, Ctrl+Enter, советчик) не шлёт второй запрос.
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const run = useCallback(async (goal: string, departmentId: string, isStudent: boolean) => {
    const text = goal.trim();
    if (!text) { toast("Введите формулировку цели", "err"); return false; }
    if (text.length > goalMaxChars) { toast(`Цель длиннее ${goalMaxChars} символов: сократите формулировку`, "err"); return false; }
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setCheckForm({ result: null, checked: null });
    try {
      const result = await api.checkGoal(text, departmentId || null, isStudent);
      // Ответ хранится вместе с тем, о чём спрашивали: если за время проверки поменяли
      // подразделение или признак студента, он не покажется под новыми значениями.
      setCheckForm({ result, checked: { goal: text, departmentId, isStudent } });
      return true;
    } catch (err) {
      if (mounted.current) toast(errorText(err), "err");
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [goalMaxChars, setCheckForm, toast]);

  const single = useMemo<SingleRun>(() => ({ busy, run }), [busy, run]);

  const value = useMemo<CheckFormState>(() => ({ checkForm, setCheckForm, batchRun, single }),
    [checkForm, setCheckForm, batchRun, single]);
  return (
    <ControlContext.Provider value={control}>
      <Context.Provider value={value}>{children}</Context.Provider>
    </ControlContext.Provider>
  );
}

