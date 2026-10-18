import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { useAuth } from "../state/auth";
import { useCatalog, type Section } from "../state/catalog";
import { allClauses, normalizeQuery } from "../state/tree";

/* Быстрый переход по Ctrl+K (⌘K): разделы, правила, приказы, подразделения
   и атрибуты в одном поле поиска. Стрелки и Enter — выбор, Escape — закрыть.
   Переход к объекту — через goToNode: он сам открывает нужный раздел и
   подсвечивает узел. */

interface Command {
  id: string;
  group: string;
  title: string;
  hint?: string;
  run: () => void;
}

const SECTION_NAMES: Record<Section, string> = {
  check: "Проверка цели", rules: "Правила", orders: "Приказы", departments: "Подразделения", targets: "Атрибуты",
  graph: "Граф", health: "Замечания", monitoring: "Мониторинг", users: "Пользователи", settings: "Настройки",
};
const ADMIN_ONLY: Section[] = ["monitoring", "users", "settings"];
const LIMIT = 12;

export function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { orders, departments, targets, setSection, goToNode } = useCatalog();
  const { isAdmin } = useAuth();
  const setOpen = onOpenChange;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      // По коду клавиши: при русской раскладке e.key — «л», а клавиша та же.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyK" || e.key.toLowerCase() === "k")) {
        e.preventDefault();
        setOpen(!open);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    input.current?.focus();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (section: Section) => () => setSection(section);
    const sections = (Object.keys(SECTION_NAMES) as Section[])
      .filter((s) => isAdmin || !ADMIN_ONLY.includes(s))
      .map((s) => ({ id: "s:" + s, group: "Разделы", title: SECTION_NAMES[s], run: go(s) }));
    const rules = allClauses(orders).flatMap((c) => c.rules.map((r) => ({
      id: r.nodeId, group: "Правила", title: r.description || "(без описания)",
      hint: `п. ${c.code}`, run: () => void goToNode(r.nodeId),
    })));
    const orderItems = orders.map((o) => ({
      id: o.nodeId, group: "Приказы", title: `${o.number || "(без номера)"} · ${o.title ?? ""}`, run: () => void goToNode(o.nodeId),
    }));
    const departmentItems = departments.map((d) => ({
      id: d.nodeId, group: "Подразделения", title: d.name || d.departmentId || "(без названия)", hint: d.departmentId ?? undefined,
      run: () => void goToNode(d.nodeId, "Department"),
    }));
    const targetItems = targets.map((t) => ({
      id: t.nodeId, group: "Атрибуты", title: t.name || "(без названия)", run: () => void goToNode(t.nodeId, "CheckTarget"),
    }));
    return [...sections, ...rules, ...orderItems, ...departmentItems, ...targetItems];
  }, [orders, departments, targets, isAdmin, setSection, goToNode]);

  const q = normalizeQuery(query);
  const shown = useMemo(() => {
    const hit = (c: Command) => !q || c.title.toLowerCase().includes(q) || (c.hint ?? "").toLowerCase().includes(q);
    const found = commands.filter(hit);
    // Без запроса — только разделы: списки объектов могут быть длинными.
    return (q ? found : found.filter((c) => c.group === "Разделы")).slice(0, LIMIT);
  }, [commands, q]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (c: Command) => { setOpen(false); c.run(); };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && shown[active]) { e.preventDefault(); pick(shown[active]); }
  }

  if (!open) return null;
  let lastGroup = "";
  return createPortal(
    <div className="overlay palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="palette" role="dialog" aria-label="Быстрый переход" onKeyDown={onKeyDown}>
        <input ref={input} type="search" className="palette-input" placeholder="Раздел, правило, приказ, подразделение…"
          aria-label="Быстрый переход" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="palette-list" ref={list} role="listbox">
          {shown.map((c, i) => {
            const head = c.group !== lastGroup ? <div className="palette-group">{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head}
                <button type="button" role="option" aria-selected={i === active} data-index={i}
                  className="palette-item" onMouseEnter={() => setActive(i)} onClick={() => pick(c)}>
                  <span className="palette-title">{c.title}</span>
                  {c.hint && <span className="dim">{c.hint}</span>}
                </button>
              </div>
            );
          })}
          {!shown.length && <div className="dim palette-empty">Ничего не найдено</div>}
        </div>
        <div className="palette-foot dim">↑↓ — выбор · Enter — перейти · Esc — закрыть</div>
      </div>
    </div>,
    document.body,
  );
}
