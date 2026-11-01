import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import logo from "./assets/logo.png";
import { CheckView } from "./features/check/CheckView";
import { DepartmentsTab } from "./features/departments/DepartmentsTab";
import { GraphTab } from "./features/graph/GraphTab";
import { MonitoringTab } from "./features/monitoring/MonitoringTab";
import { HealthTab } from "./features/health/HealthTab";
import { OrdersView } from "./features/orders/OrdersView";
import { RestoredDialogs } from "./features/RestoredDialogs";
import { RulePanel } from "./features/rules/RulePanel";
import { RulesView } from "./features/rules/RulesView";
import { SettingsTab } from "./features/settings/SettingsTab";
import { TargetsTab } from "./features/targets/TargetsTab";
import { useTour } from "./features/tour/Tour";
import { UsersTab } from "./features/users/UsersTab";
import { ROLE_LABEL, useAuth } from "./state/auth";
import { sectionPath, useCatalog, type Section } from "./state/catalog";
import { useCheckForm, type CheckForm } from "./state/checkForm";
import { useDraft } from "./state/drafts";
import { useDialogs } from "./ui/Dialogs";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { useMenu } from "./ui/Menu";
import { Palette } from "./ui/Palette";
import { readTheme, saveTheme, type Theme } from "./ui/theme";

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">{path}</svg>
);

/** Группы разделов в панели: каждый день — «Работа», справочники — «Каталог», служебное — «Администрирование». */
type Group = "Работа" | "Каталог" | "Администрирование";

const SECTIONS: { id: Section; label: string; icon: ReactNode; view: () => ReactNode; group: Group; adminOnly?: boolean }[] = [
  { id: "check", group: "Работа", view: () => <CheckView />, label: "Проверка цели", icon: icon(<path d="M4 10l4 4 8-9" />) },
  { id: "rules", group: "Каталог", view: () => <RulesView />, label: "Правила", icon: icon(<path d="M3 3h14v14H3zM3 8h14M3 13h14M8 3v14M13 3v14" />) },
  { id: "orders", group: "Каталог", view: () => <OrdersView />, label: "Приказы", icon: icon(<path d="M5 2h8l3 3v13H5zM8 8h6M8 12h6" />) },
  { id: "departments", group: "Каталог", view: () => <DepartmentsTab />, label: "Подразделения", icon: icon(<><circle cx="10" cy="7" r="3" /><path d="M4 17c0-3 3-5 6-5s6 2 6 5" /></>) },
  { id: "targets", group: "Каталог", view: () => <TargetsTab />, label: "Атрибуты", icon: icon(<path d="M3 5h9l5 5-5 5H3zM7 10h.01" />) },
  { id: "graph", group: "Каталог", view: () => <GraphTab />, label: "Граф", icon: icon(<><circle cx="5" cy="5" r="2" /><circle cx="15" cy="7" r="2" /><circle cx="8" cy="15" r="2" /><path d="M7 5.5l6 1M6 7l1.5 6M13.5 8.5L9.5 13.5" /></>) },
  { id: "health", group: "Работа", view: () => <HealthTab />, label: "Замечания", icon: icon(<path d="M10 3l8 14H2zM10 8v4M10 14.5v.5" />) },
  { id: "monitoring", group: "Администрирование", view: () => <MonitoringTab />, label: "Мониторинг", adminOnly: true, icon: icon(<path d="M2 11h3l2-6 4 11 2.5-7 1.5 2h3" />) },
  { id: "users", group: "Администрирование", view: () => <UsersTab />, label: "Пользователи", adminOnly: true,
    icon: icon(<><circle cx="7.5" cy="7" r="2.6" /><path d="M2.5 16c0-2.6 2.2-4.4 5-4.4s5 1.8 5 4.4M13.5 4.6a2.6 2.6 0 010 4.8M15 11.8c1.6.6 2.6 2 2.6 4.2" /></>) },
  { id: "settings", group: "Администрирование", view: () => <SettingsTab />, label: "Настройки", adminOnly: true,
    icon: icon(<><path d="M3 6h7M14 6h3M3 14h3M10 14h7" /><circle cx="12" cy="6" r="2" /><circle cx="8" cy="14" r="2" /></>) },
];

const GROUPS: Group[] = ["Работа", "Каталог", "Администрирование"];

/** Закреплена ли панель: выбор хранится в localStorage; пока не выбирали — закреплена, чтобы подписи были видны сразу. */
const DOCK_KEY = "gc.sidebar";
function readDocked() {
  try { return localStorage.getItem(DOCK_KEY) !== "folded"; } catch { return true; }
}
function saveDocked(docked: boolean) {
  try { localStorage.setItem(DOCK_KEY, docked ? "docked" : "folded"); } catch { /* приватный режим */ }
}

/** Окно от 1440px — места хватает и раскрытой панели, и разделу. */
function useWide() {
  const query = "(min-width: 1440px)";
  const [wide, setWide] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const on = () => setWide(list.matches);
    list.addEventListener("change", on);
    return () => list.removeEventListener("change", on);
  }, []);
  return wide;
}

/** Инициалы для аватара: первые буквы двух первых слов имени или логина. */
const initials = (name: string) =>
  name.trim().split(/[\s._-]+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

/** Выбор темы в меню пользователя: две иконки, солнце и луна; меню при этом не закрывается. */
function ThemeRow({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const [value, setValue] = useState(theme);
  const pick = (next: Theme) => { setValue(next); onChange(next); };
  return (
    <div className="theme-row" role="group" aria-label="Тема">
      <span className="dim">Тема</span>
      <button type="button" className="theme-opt" aria-label="Светлая тема" title="Светлая тема"
        aria-pressed={value === "light"} onClick={() => pick("light")}>
        {icon(<><circle cx="10" cy="10" r="3.6" /><path d="M10 1.5v2.2M10 16.3v2.2M1.5 10h2.2M16.3 10h2.2M4 4l1.55 1.55M14.45 14.45L16 16M4 16l1.55-1.55M14.45 5.55L16 4" /></>)}
      </button>
      <button type="button" className="theme-opt" aria-label="Тёмная тема" title="Тёмная тема"
        aria-pressed={value === "dark"} onClick={() => pick("dark")}>
        {icon(<path d="M17.3 11.3A7.4 7.4 0 1 1 8.7 2.7a5.8 5.8 0 0 0 8.6 8.6z" />)}
      </button>
    </div>
  );
}

/** Что из формы проверки переживает повторный вход: ввод, но не ответы модели. */
type CheckDraft = Pick<CheckForm, "mode" | "goal" | "departmentId" | "isStudent" | "rows">;
const checkDraft = (f: CheckForm): CheckDraft | undefined =>
  f.goal.trim() || f.rows.length
    ? { mode: f.mode, goal: f.goal, departmentId: f.departmentId, isStudent: f.isStudent, rows: f.rows } : undefined;

/** Ввод в «Проверке цели» сохраняется перед повторным входом и возвращается после (state/drafts.ts).
    Отдельный компонент без разметки: на форму подписан только он, и нажатие клавиши в поле цели
    не перерисовывает App со всей боковой панелью. */
function CheckDraftKeeper() {
  const { checkForm, setCheckForm } = useCheckForm();
  useDraft("check", checkForm, (draft: CheckDraft) => setCheckForm(draft), checkDraft);
  return null;
}

const API_STATE = {
  connecting: { cls: "archived", text: "подключение…" },
  refreshing: { cls: "archived", text: "обновляем…" },
  online: { cls: "ok", text: "API на связи" },
  offline: { cls: "warn", text: "API недоступен" },
};

export function App() {
  const { section: requested, setSection, apiState, health, reload, panelRule, wizard, closeRule } = useCatalog();
  const { user, isAdmin, logout } = useAuth();
  const openMenu = useMenu();
  const { confirm } = useDialogs();
  const tour = useTour();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const chooseTheme = (next: Theme) => { setTheme(next); saveTheme(next); };
  const logoutConfirmed = async () => {
    if (await confirm({ title: "Выйти из учётной записи?", confirmLabel: "Выйти",
      message: "Несохранённые изменения в открытых формах будут потеряны." })) void logout();
  };
  // Раздел администратора по прямому адресу остальным не показывается.
  const allowed = SECTIONS.filter((s) => isAdmin || !s.adminOnly)
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
  const current = allowed.find((s) => s.id === requested) ?? allowed[0];
  const section = current.id;
  // У каждого раздела своё название вкладки: несколько открытых вкладок различимы.
  useEffect(() => { document.title = `${current.label} — Проверка целей`; }, [current.label]);
  useEffect(() => {
    if (section === requested) return;
    history.replaceState(null, "", sectionPath(section));
    setSection(section);
  }, [section, requested, setSection]);
  // Обычный щелчок переключает раздел без перезагрузки; с Ctrl/⌘ ссылка открывается в новой вкладке.
  const open = (event: MouseEvent, id: Section) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setSection(id);
    setFolded(true);
  };
  // После выбора раздела панель складывается до иконок, хотя курсор ещё над ней,
  // и не заслоняет открытый раздел; снова раскрывается, когда курсор вернётся.
  const [folded, setFolded] = useState(false);
  // Пока открыто меню пользователя (оно рендерится вне панели), панель остаётся раскрытой.
  const [pinned, setPinned] = useState(false);
  // Панель можно закрепить раскрытой (кнопка-булавка): тогда она стоит рядом с разделом, а не поверх.
  // На окне уже 1440px закреплённая панель всё равно сворачивается до иконок.
  const [dockPref, setDockPref] = useState(readDocked);
  const wide = useWide();
  const docked = dockPref && wide;
  const toggleDock = () => { setDockPref(!dockPref); saveDocked(!dockPref); };
  // Поиск по каталогу (ui/Palette.tsx): открывается кнопкой в панели и по Ctrl+K.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // «Обновить» показывает ожидание не меньше секунды: иначе мгновенный ответ выглядит как «ничего не произошло».
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([reload(), new Promise((r) => setTimeout(r, 1000))]);
    } finally {
      setRefreshing(false);
    }
  };
  const pill = refreshing ? API_STATE.refreshing : API_STATE[apiState];
  // На значке — число ошибок, а если их нет, то предупреждений.
  const badge = health?.error || health?.warning || 0;
  const withPanel = !!panelRule && !wizard && (section === "rules" || section === "orders");

  // Подложка активного пункта меню: встаёт под выбранную кнопку и переезжает к новой.
  const nav = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const active = nav.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    setIndicator(active ? { top: active.offsetTop, height: active.offsetHeight } : null);
  }, [section, isAdmin]);

  return (
    <div className={`shell ${withPanel ? "with-panel" : ""} ${docked ? "docked" : ""}`}>
      <CheckDraftKeeper />
      <RestoredDialogs />
      {/* На шагах обучения про панель она раскрыта, как при наведении. */}
      <aside className={`side ${folded && !tour.pinSide && !docked ? "folded" : ""} ${pinned || tour.pinSide || docked ? "pinned" : ""} ${docked ? "docked" : ""}`}
        onMouseLeave={() => setFolded(false)} onKeyDown={() => setFolded(false)}>
        <div className="brand">
          <img src={logo} alt="" />
          <div>Проверка целей<small>каталог требований</small></div>
          {wide && (
            <button type="button" className="pin-btn label" aria-pressed={dockPref} onClick={toggleDock}
              title={dockPref ? "Открепить панель: сворачивать до иконок" : "Закрепить панель раскрытой"}
              aria-label={dockPref ? "Открепить панель" : "Закрепить панель"}>
              {icon(<path d="M12 2l6 6-3 1-3 3 .5 4L11 17.5 7.5 14 3 18.5M7.5 14L2.5 9l1.5-1.5 4 .5 3-3 1-3z" />)}
            </button>
          )}
        </div>
        {/* Поиск по каталогу: та же палитра, что по Ctrl+K, но с видимой кнопкой. */}
        <button type="button" className="nav-item search-btn" title={folded ? "Поиск" : undefined}
          onClick={() => setPaletteOpen(true)}>
          {icon(<><circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5L17 17" /></>)}
          <span className="label">Поиск</span>
          <kbd className="label">{navigator.platform.includes("Mac") ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
        <nav role="tablist" aria-orientation="vertical" ref={nav}>
          {indicator && (
            <div className="nav-ind" aria-hidden="true"
              style={{ transform: `translateY(${indicator.top}px)`, height: indicator.height }} />
          )}
          {allowed.map((s, i) => (
            <Fragment key={s.id}>
            {s.group !== allowed[i - 1]?.group && <div className="nav-group label" aria-hidden="true">{s.group}</div>}
            <a role="tab" className="nav-item" aria-selected={section === s.id} href={sectionPath(s.id)}
              title={folded ? s.label : undefined} onClick={(event) => open(event, s.id)}>
              {s.icon}<span className="label">{s.label}</span>
              {s.id === "health" && badge > 0 && <span className={`n ${health?.error ? "err" : "warn"}`}>{badge}</span>}
            </a>
            </Fragment>
          ))}
        </nav>
        <div className="spacer" />
        <div className="side-foot">
          {/* Вся строка пользователя — кнопка меню: в свёрнутой панели от неё виден только аватар. */}
          <button className="who" aria-label="Меню пользователя" title="Меню пользователя"
            onClick={(e) => {
              setPinned(true);
              openMenu(e.currentTarget, [
                { label: "Обновить", run: () => void refresh() },
                { label: "Обучение", run: tour.start },
                null,
                { custom: <ThemeRow theme={theme} onChange={chooseTheme} /> },
                null,
                { label: "Выйти", run: () => void logoutConfirmed() },
              ], () => setPinned(false));
            }}>
            <span className={`avatar ${pill.cls}`} aria-hidden="true">{initials(user.displayName || user.login)}<i className="status" /></span>
            <span className="who-text label">
              <span className="mid">{user.displayName || user.login}</span>
              <span className="small dim">{ROLE_LABEL[user.role]}</span>
              <span className={`small api ${pill.cls}`}><span className="dot" />{pill.text}</span>
            </span>
            <span className="user-menu label" aria-hidden="true">⋯</span>
          </button>
        </div>
      </aside>

      {/* Отрисован только открытый раздел: у каждого свой адрес. Ошибка рендера
          в разделе заменяет только его, а не всё приложение (ui/ErrorBoundary.tsx). */}
      <main className="main">
        <ErrorBoundary key={section} label={`раздел «${current.label}»`}>{current.view()}</ErrorBoundary>
      </main>

      {/* Под листом правила страница затемняется; щелчок по затемнению закрывает лист. */}
      {withPanel && <div className="sheet-scrim" onMouseDown={closeRule} />}
      {withPanel && (
        <ErrorBoundary key={panelRule} fallback={(error, reset) => (
          <aside className="rule-panel crash-panel">
            <div className="crash-panel-body">
              <b>Не удалось показать правило</b>
              <span className="muted">{error.message}</span>
              <span className="row">
                <button type="button" className="btn primary" onClick={reset}>Попробовать снова</button>
                <button type="button" className="btn" onClick={closeRule}>Закрыть</button>
              </span>
            </div>
          </aside>
        )}>
          <RulePanel />
        </ErrorBoundary>
      )}
      <ErrorBoundary key={String(paletteOpen)} fallback={() => null}>
        <Palette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </ErrorBoundary>

      {/* Интерфейс рассчитан на настольный экран: уже 960px он не перестраивается, а просит увеличить окно.
          От 960 до 1200px (ноутбук с масштабом 125%) проверка цели идёт в одну колонку (styles.css). */}
      <div className="too-narrow" role="alert">
        <div>
          <b>Увеличьте окно браузера</b>
          <span>Интерфейс рассчитан на ширину от 960 пикселей.</span>
        </div>
      </div>
    </div>
  );
}
