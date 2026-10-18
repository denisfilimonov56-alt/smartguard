import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import logo from "./assets/logo.png";
import { CheckView } from "./features/check/CheckView";
import { DepartmentsTab } from "./features/departments/DepartmentsTab";
import { GraphTab } from "./features/graph/GraphTab";
import { MonitoringTab } from "./features/monitoring/MonitoringTab";
import { HealthTab } from "./features/health/HealthTab";
import { OrdersView } from "./features/orders/OrdersView";
import { RulePanel } from "./features/rules/RulePanel";
import { RulesView } from "./features/rules/RulesView";
import { SettingsTab } from "./features/settings/SettingsTab";
import { TargetsTab } from "./features/targets/TargetsTab";
import { UsersTab } from "./features/users/UsersTab";
import { ROLE_LABEL, useAuth } from "./state/auth";
import { useMenu } from "./ui/Menu";
import { sectionPath, useCatalog, type Section } from "./state/catalog";

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">{path}</svg>
);

const SECTIONS: { id: Section; label: string; icon: ReactNode; view: () => ReactNode; adminOnly?: boolean }[] = [
  { id: "check", view: () => <CheckView />, label: "Проверка цели", icon: icon(<path d="M4 10l4 4 8-9" />) },
  { id: "rules", view: () => <RulesView />, label: "Правила", icon: icon(<path d="M3 3h14v14H3zM3 8h14M3 13h14M8 3v14M13 3v14" />) },
  { id: "orders", view: () => <OrdersView />, label: "Приказы", icon: icon(<path d="M5 2h8l3 3v13H5zM8 8h6M8 12h6" />) },
  { id: "departments", view: () => <DepartmentsTab />, label: "Подразделения", icon: icon(<><circle cx="10" cy="7" r="3" /><path d="M4 17c0-3 3-5 6-5s6 2 6 5" /></>) },
  { id: "targets", view: () => <TargetsTab />, label: "Атрибуты", icon: icon(<path d="M3 5h9l5 5-5 5H3zM7 10h.01" />) },
  { id: "graph", view: () => <GraphTab />, label: "Граф", icon: icon(<><circle cx="5" cy="5" r="2" /><circle cx="15" cy="7" r="2" /><circle cx="8" cy="15" r="2" /><path d="M7 5.5l6 1M6 7l1.5 6M13.5 8.5L9.5 13.5" /></>) },
  { id: "health", view: () => <HealthTab />, label: "Замечания", icon: icon(<path d="M10 3l8 14H2zM10 8v4M10 14.5v.5" />) },
  { id: "monitoring", view: () => <MonitoringTab />, label: "Мониторинг", adminOnly: true, icon: icon(<path d="M2 11h3l2-6 4 11 2.5-7 1.5 2h3" />) },
  { id: "users", view: () => <UsersTab />, label: "Пользователи", adminOnly: true,
    icon: icon(<><circle cx="7.5" cy="7" r="2.6" /><path d="M2.5 16c0-2.6 2.2-4.4 5-4.4s5 1.8 5 4.4M13.5 4.6a2.6 2.6 0 010 4.8M15 11.8c1.6.6 2.6 2 2.6 4.2" /></>) },
  { id: "settings", view: () => <SettingsTab />, label: "Настройки", adminOnly: true,
    icon: icon(<><path d="M3 6h7M14 6h3M3 14h3M10 14h7" /><circle cx="12" cy="6" r="2" /><circle cx="8" cy="14" r="2" /></>) },
];

/** Инициалы для аватара: первые буквы двух первых слов имени или логина. */
const initials = (name: string) =>
  name.trim().split(/[\s._-]+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

const API_STATE = {
  connecting: { cls: "archived", text: "подключение…" },
  online: { cls: "ok", text: "API на связи" },
  offline: { cls: "warn", text: "API недоступен" },
};

export function App() {
  const { section: requested, setSection, apiState, health, reload, panelRule, wizard } = useCatalog();
  const { user, isAdmin, logout } = useAuth();
  const openMenu = useMenu();
  // Раздел администратора по прямому адресу остальным не показывается.
  const allowed = SECTIONS.filter((s) => isAdmin || !s.adminOnly);
  const current = allowed.find((s) => s.id === requested) ?? allowed[0];
  const section = current.id;
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
  const pill = API_STATE[apiState];
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
    <div className={`shell ${withPanel ? "with-panel" : ""}`}>
      <aside className={`side ${folded ? "folded" : ""} ${pinned ? "pinned" : ""}`} onMouseLeave={() => setFolded(false)} onKeyDown={() => setFolded(false)}>
        <div className="brand">
          <img src={logo} alt="" />
          <div>Проверка целей<small>каталог требований</small></div>
        </div>
        <nav role="tablist" aria-orientation="vertical" ref={nav}>
          {indicator && (
            <div className="nav-ind" aria-hidden="true"
              style={{ transform: `translateY(${indicator.top}px)`, height: indicator.height }} />
          )}
          {allowed.map((s) => (
            <a key={s.id} role="tab" className="nav-item" aria-selected={section === s.id} href={sectionPath(s.id)}
              onClick={(event) => open(event, s.id)}>
              {s.icon}<span className="label">{s.label}</span>
              {s.id === "health" && badge > 0 && <span className={`n ${health?.error ? "err" : "warn"}`}>{badge}</span>}
            </a>
          ))}
        </nav>
        <div className="spacer" />
        <div className="side-foot">
          {/* Вся строка пользователя — кнопка меню: в свёрнутой панели от неё виден только аватар. */}
          <button className="who" aria-label="Меню пользователя" title="Меню пользователя"
            onClick={(e) => {
              setPinned(true);
              openMenu(e.currentTarget, [
                { label: "Обновить", run: () => void reload() },
                { label: "Выйти", run: () => void logout() },
              ], () => setPinned(false));
            }}>
            <span className={`avatar ${pill.cls}`} aria-hidden="true">{initials(user.displayName || user.login)}<i className="status" /></span>
            <span className="who-text label">
              <span className="mid">{user.displayName || user.login}</span>
              <span className="small dim">{user.displayName ? `${user.login} · ` : ""}{ROLE_LABEL[user.role]}</span>
              <span className={`small api ${pill.cls}`}><span className="dot" />{pill.text}</span>
            </span>
            <span className="user-menu label" aria-hidden="true">⋯</span>
          </button>
        </div>
      </aside>

      {/* Отрисован только открытый раздел: у каждого свой адрес. */}
      <main className="main">{current.view()}</main>

      {withPanel && <RulePanel />}
    </div>
  );
}
