import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";

import { api } from "../api/client";
import type {
  CheckResult, CheckTarget, Department, Diagnostics, FlatClause, NodeKind, Order,
} from "../api/types";
import { errorText, useToast } from "../ui/Toasts";
import { CheckFormProvider } from "./checkForm";
import { hasDraft } from "./drafts";
import { findOrderOf, findRuleRef } from "./tree";

export type Section = "check" | "rules" | "orders" | "departments" | "targets" | "graph" | "health"
  | "monitoring" | "users" | "settings";
export const SECTION_IDS: Section[] = ["check", "rules", "orders", "departments", "targets", "graph", "health",
  "monitoring", "users", "settings"];
/** Пауза после правок, через которую перечитываются счётчики замечаний. */
const HEALTH_DEBOUNCE_MS = 3000;

export type ApiState = "connecting" | "online" | "offline";

interface Data {
  orders: Order[];
  targets: CheckTarget[];
  clauses: FlatClause[];
  departments: Department[];
}

interface Flags {
  showArchived: boolean;
  showArchivedTargets: boolean;
  showArchivedDepartments: boolean;
}

/** Раздел — это адрес страницы: /rules, /monitoring… Корень сайта — «Проверка цели». */
export const sectionPath = (section: Section) => "/" + section;
const sectionOf = (pathname: string): Section | null => {
  const id = pathname.replace(/^\/+|\/+$/g, "");
  if (!id) return "check";
  return SECTION_IDS.find((s) => s === id) ?? null;
};

/** С чего начать мастер нового правила. */
export interface WizardPreset {
  orderNodeId?: string;
  clauseNodeId?: string;
}

interface CatalogState extends Data, Flags {
  apiState: ApiState;
  health: Diagnostics["counts"] | null;
  section: Section;
  /** Перейти в раздел. Открыт мастер правила с несохранённым вводом — сначала вопрос;
      false — пользователь остался в мастере, раздел не сменился. */
  setSection: (section: Section) => Promise<boolean>;
  /** Перечитать данные; флаги архива можно поменять тем же вызовом. */
  reload: (flags?: Partial<Flags>) => Promise<Data | null>;
  /** Выполнить изменение, показать сообщение и перечитать данные. */
  mutate: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  /** Перечитать счётчики замечаний сейчас. */
  refreshHealth: () => Promise<void>;
  /** Счётчики уже известны (раздел «Замечания» загрузил отчёт): без повторного запроса. */
  setHealth: (counts: Diagnostics["counts"] | null) => void;
  /** Приказ, открытый в разделе «Приказы». */
  selectedOrder: string | null;
  selectOrder: (nodeId: string) => void;
  /** Правило, открытое в боковой панели. */
  panelRule: string | null;
  openRule: (nodeId: string) => void;
  closeRule: () => void;
  wizard: WizardPreset | null;
  openWizard: (preset?: WizardPreset) => void;
  /** Закрыть мастер: при несохранённом вводе он сначала спросит (force — без вопроса, например после создания). */
  closeWizard: (force?: boolean) => void;
  /** Закрыть мастер перед другим действием (обучение, переход): true — закрыт или не был открыт. */
  leaveWizard: () => Promise<boolean>;
  /** Мастер регистрирует вопрос перед закрытием: true — можно закрывать. */
  setWizardGuard: (guard: (() => Promise<boolean>) | null) => void;
  /** Правило, изменение которого сейчас сохраняется из панели: его «Изменить» и ячейки матрицы
      недоступны, иначе они строились бы от снимка до сохранения. */
  savingRule: string | null;
  setSavingRule: (nodeId: string | null) => void;
  goToNode: (nodeId: string, kind?: NodeKind) => Promise<void>;
  /** Результат проверки, путь которой показан на графе. */
  trace: CheckResult | null;
  setTrace: (result: CheckResult | null) => void;
}

const Context = createContext<CatalogState | null>(null);

export function useCatalog() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useCatalog вне CatalogProvider");
  return ctx;
}

export function CatalogProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [data, setData] = useState<Data>({ orders: [], targets: [], clauses: [], departments: [] });
  const [flags, setFlags] = useState<Flags>({
    showArchived: false, showArchivedTargets: false, showArchivedDepartments: false,
  });
  const flagsRef = useRef(flags);
  const [apiState, setApiState] = useState<ApiState>("connecting");
  const [health, setHealth] = useState<Diagnostics["counts"] | null>(null);
  const [section, setSectionState] = useState<Section>(() => sectionOf(location.pathname) ?? "check");
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [panelRule, setPanelRule] = useState<string | null>(null);
  const [wizard, setWizardState] = useState<WizardPreset | null>(null);
  // Открыт ли мастер — синхронно, без ожидания перерисовки: переходы решают по нему, спрашивать ли.
  const wizardRef = useRef<WizardPreset | null>(null);
  const setWizard = useCallback((next: WizardPreset | null) => { wizardRef.current = next; setWizardState(next); }, []);
  const wizardGuard = useRef<(() => Promise<boolean>) | null>(null);
  /** Вопрос мастера уже задан (например, обучение и переход одновременно): второй ждёт тот же ответ. */
  const leaving = useRef<Promise<boolean> | null>(null);
  const [savingRule, setSavingRule] = useState<string | null>(null);
  const [trace, setTrace] = useState<CheckResult | null>(null);
  const [flashTarget, setFlashTarget] = useState<{ id: string; seq: number } | null>(null);

  // Диагностика графа — около двадцати запросов Cypher: после правок она
  // перечитывается не на каждую, а одна на серию правок подряд.
  const healthTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshHealth = useCallback(async () => {
    if (healthTimer.current) { clearTimeout(healthTimer.current); healthTimer.current = null; }
    try { setHealth((await api.diagnostics()).counts); } catch { /* значок необязателен */ }
  }, []);
  const scheduleHealth = useCallback(() => {
    if (healthTimer.current) clearTimeout(healthTimer.current);
    healthTimer.current = setTimeout(() => void refreshHealth(), HEALTH_DEBOUNCE_MS);
  }, [refreshHealth]);
  useEffect(() => () => { if (healthTimer.current) clearTimeout(healthTimer.current); }, []);

  // Ответ на устаревший запрос не затирает данные более нового; флаги архива
  // при сбое возвращаются к тем, с которыми данные на экране загружены.
  const reloadSeq = useRef(0);
  const loadedFlags = useRef(flags);
  const healthLoaded = useRef(false);
  /** Последняя начатая перечитка: обогнанная (null) может дождаться её данных. */
  const lastReload = useRef<Promise<Data | null>>(Promise.resolve(null));
  const load = useCallback(async (override?: Partial<Flags>): Promise<Data | null> => {
    const next = { ...flagsRef.current, ...override };
    flagsRef.current = next;
    setFlags(next);
    const seq = ++reloadSeq.current;
    let loaded: Data | null = null;
    try {
      const [tree, targets, clauses, departments] = await Promise.all([
        api.tree(next.showArchived), api.checkTargets(next.showArchivedTargets), api.clauses(),
        api.departments(next.showArchivedDepartments),
      ]);
      if (seq !== reloadSeq.current) return null;
      loaded = {
        orders: tree.orders, targets: targets.targets, clauses: clauses.clauses,
        departments: departments.departments,
      };
      loadedFlags.current = next;
      setData(loaded);
      setApiState("online");
    } catch (err) {
      if (seq !== reloadSeq.current) return null;
      flagsRef.current = loadedFlags.current;
      setFlags(loadedFlags.current);
      setApiState("offline");
      toast("Не удалось получить данные: " + errorText(err), "err");
    }
    // Первая загрузка — значок сразу; дальше — после паузы в правках.
    if (healthLoaded.current) scheduleHealth();
    else { healthLoaded.current = true; void refreshHealth(); }
    return loaded;
  }, [toast, refreshHealth, scheduleHealth]);
  const reload = useCallback((override?: Partial<Flags>) => {
    const promise = load(override);
    lastReload.current = promise;
    return promise;
  }, [load]);

  const mutate = useCallback(async (fn: () => Promise<unknown>, success?: string) => {
    await fn();
    if (success) toast(success, "ok");
    await reload();
  }, [toast, reload]);

  useEffect(() => { void reload(); }, [reload]);

  /** Закрыть мастер, если он не против: с несохранённым вводом он спрашивает (и предлагает убрать
      созданное прошлой попыткой). Пока вопрос открыт, повторный вызов ждёт тот же ответ. */
  const leaveWizard = useCallback(async (): Promise<boolean> => {
    if (!wizardRef.current) return true;
    if (!leaving.current) {
      const guard = wizardGuard.current;
      leaving.current = (guard ? guard() : Promise.resolve(true)).catch(() => false)
        .finally(() => { leaving.current = null; });
    }
    if (!(await leaving.current)) return false;
    setWizard(null);
    return true;
  }, [setWizard]);

  // Раздел, показанный сейчас: «Назад» браузера, от которого мастер отказался, возвращает его адрес.
  const shownSection = useRef(section);
  // Панель правила и мастер живут только в «Правилах» и «Приказах». Мастер — в «Правилах»:
  // переход в тот же раздел его не закрывает, в другой — только после вопроса о несохранённом.
  // Без открытого мастера раздел меняется сразу, в том же вызове.
  const showSection = useCallback(async (next: Section) => {
    if (wizardRef.current && next !== "rules" && !(await leaveWizard())) return false;
    shownSection.current = next;
    setSectionState(next);
    if (next !== "rules") setWizard(null);
    if (next !== "rules" && next !== "orders") setPanelRule(null);
    return true;
  }, [leaveWizard, setWizard]);

  const setSection = useCallback(async (next: Section) => {
    if (wizardRef.current && next !== "rules" && !(await leaveWizard())) return false;
    if (location.pathname !== sectionPath(next)) history.pushState(null, "", sectionPath(next));
    return showSection(next);
  }, [leaveWizard, showSection]);

  // Адрес — источник правды: «Назад» и «Вперёд» браузера переключают раздел,
  // а неизвестный адрес заменяется адресом показанного раздела.
  useEffect(() => {
    if (sectionOf(location.pathname) === null) history.replaceState(null, "", sectionPath("check"));
    const onPop = async () => {
      // Остались в мастере — адрес возвращается к показанному разделу.
      if (!(await showSection(sectionOf(location.pathname) ?? "check")))
        history.pushState(null, "", sectionPath(shownSection.current));
    };
    const listener = () => void onPop();
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, [showSection]);

  const goToNode = useCallback(async (nodeId: string, kind?: NodeKind) => {
    const flash = () => setFlashTarget({ id: nodeId, seq: Date.now() });

    if (kind === "CheckTarget" || kind === "Department") {
      const [list, flag]: [{ nodeId: string }[], keyof Flags] = kind === "CheckTarget"
        ? [data.targets, "showArchivedTargets"] : [data.departments, "showArchivedDepartments"];
      if (!(await setSection(kind === "CheckTarget" ? "targets" : "departments"))) return;
      if (!list.some((n) => n.nodeId === nodeId) && !flagsRef.current[flag]) await reload({ [flag]: true });
      flash();
      return;
    }

    let orders = data.orders;
    if (!findOrderOf(orders, nodeId) && !flagsRef.current.showArchived) {
      let pending = reload({ showArchived: true });
      let loaded = await pending;
      // Перечитку обогнала более новая (null): её данные свежее и уже с архивом (флаг в flagsRef) —
      // дождаться её, а не искать узел в старых orders без архива.
      while (!loaded && lastReload.current !== pending) {
        pending = lastReload.current;
        loaded = await pending;
      }
      orders = loaded?.orders ?? orders;
    }
    const found = findOrderOf(orders, nodeId);
    if (!(await setSection("orders"))) return;
    if (found) setSelectedOrder(found.order.nodeId);
    // Правило и его примеры открываются в панели — там видно всё сразу.
    const rule = findRuleRef(orders, nodeId);
    setPanelRule(rule ? rule.rule.nodeId : null);
    flash();
  }, [data, reload, setSection]);

  // Черновик мастера правила, сохранённый перед повторным входом, забирает сам
  // мастер — поэтому после входа он открывается сразу.
  useEffect(() => {
    if (hasDraft("wizard")) { void setSection("rules"); setWizard({}); }
  }, [setSection, setWizard]);

  // Подсветка — после того как React отрисовал нужный раздел.
  useEffect(() => {
    if (!flashTarget) return;
    const el = [...document.querySelectorAll<HTMLElement>(`[data-node="${CSS.escape(flashTarget.id)}"]`)]
      .find((node) => node.offsetParent !== null);
    setFlashTarget(null);
    if (!el) { toast("Объект не найден в текущем представлении", "err"); return; }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }, [flashTarget, toast]);

  const value = useMemo<CatalogState>(() => ({
    ...data, ...flags, apiState, health, section, setSection,
    reload, mutate, refreshHealth, setHealth,
    selectedOrder, selectOrder: setSelectedOrder,
    panelRule, openRule: setPanelRule, closeRule: () => setPanelRule(null),
    wizard,
    openWizard: (preset) => {
      // Мастер уже открыт — второй поверх не открывается: его ввод не должен пропасть молча.
      if (wizardRef.current) return;
      void setSection("rules"); setPanelRule(null); setWizard(preset ?? {});
    },
    closeWizard: (force) => { if (force) setWizard(null); else void leaveWizard(); },
    leaveWizard,
    setWizardGuard: (guard) => { wizardGuard.current = guard; },
    savingRule, setSavingRule,
    goToNode, trace, setTrace,
  }), [trace, data, flags, apiState, health, section, setSection,
    reload, mutate, refreshHealth, selectedOrder, panelRule, wizard, goToNode, leaveWizard, setWizard, savingRule]);

  // Форма проверки — свой контекст: ввод в неё не перерисовывает потребителей каталога.
  return <Context.Provider value={value}><CheckFormProvider>{children}</CheckFormProvider></Context.Provider>;
}
