import type { CheckMode, StatsStep } from "../api/types";

/* Настройки раздела «Мониторинг» — в localStorage этого браузера, отдельно для
   каждого логина: период, периодичность, вид проверок и строк на странице.
   Быстрый период хранится числом дней, а не датами: «7 дней» через неделю —
   снова последние семь суток. Хранилище может быть недоступно (приватный
   режим) — тогда раздел открывается с настройками по умолчанию. */

export interface MonitoringPrefs {
  /** Быстрый период в днях; null — свой период из from и to. */
  preset: number | null;
  /** Свой период, местное время до минуты: 2026-11-02T09:30. */
  from: string;
  to: string;
  step: StatsStep;
  mode: CheckMode | "";
  bucketSize: number;
  historySize: number;
}

const key = (login: string) => "gc.monitoring:" + login;
const STEPS: StatsStep[] = ["minute", "hour", "day", "week", "month"];
const MODES: (CheckMode | "")[] = ["", "single", "bulk"];
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Сохранённые настройки; поле, которое не прочиталось, не возвращается — для него берётся значение по умолчанию. */
export function readMonitoringPrefs(login: string, presets: number[], sizes: number[]): Partial<MonitoringPrefs> {
  try {
    const raw = JSON.parse(localStorage.getItem(key(login)) ?? "null");
    if (!raw || typeof raw !== "object") return {};
    const prefs: Partial<MonitoringPrefs> = {};
    if (raw.preset === null && DATE_TIME.test(raw.from) && DATE_TIME.test(raw.to) && raw.from <= raw.to)
      Object.assign(prefs, { preset: null, from: raw.from, to: raw.to });
    else if (presets.includes(raw.preset)) prefs.preset = raw.preset;
    if (STEPS.includes(raw.step)) prefs.step = raw.step;
    if (MODES.includes(raw.mode)) prefs.mode = raw.mode;
    if (sizes.includes(raw.bucketSize)) prefs.bucketSize = raw.bucketSize;
    if (sizes.includes(raw.historySize)) prefs.historySize = raw.historySize;
    return prefs;
  } catch {
    return {};
  }
}

export function saveMonitoringPrefs(login: string, prefs: MonitoringPrefs) {
  try {
    localStorage.setItem(key(login), JSON.stringify(prefs));
  } catch { /* приватный режим: настройки живут до перезагрузки */ }
}
