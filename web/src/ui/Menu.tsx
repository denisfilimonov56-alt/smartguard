import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode,
} from "react";

import { useAuth } from "../state/auth";

/* Все операции над приказом, пунктом, правилом и атрибутом собраны в одно
   выпадающее меню: иначе строка действий шире самого содержимого.
   Открыто не больше одного меню; прокрутка, ресайз, Escape и клик мимо
   закрывают его. С клавиатуры: при открытии фокус на первом пункте, стрелки,
   Home/End ходят по пунктам, Escape и Tab закрывают меню и возвращают фокус
   на кнопку. Клавиши, пока меню открыто, достаются только ему: Escape не
   закрывает заодно панель правила или окно под меню. */

/** Пункт меню, разделитель (null) или произвольная строка (custom) — например, переключатель темы. */
export type MenuItem = { label: string; run: () => unknown; danger?: boolean } | { custom: ReactNode } | null;

interface OpenMenu {
  anchor: DOMRect;
  element: HTMLElement;
  items: MenuItem[];
  /** Вызывается, когда меню закрылось любым способом. */
  onClose?: () => void;
}

const MenuContext = createContext<(anchor: HTMLElement, items: MenuItem[], onClose?: () => void) => void>(() => {});

export function MenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const current = useRef<OpenMenu | null>(null);
  /** refocus — вернуть фокус на кнопку меню (закрыли с клавиатуры или выбрали пункт). */
  const close = useCallback((refocus = false) => {
    const was = current.current;
    was?.onClose?.();
    current.current = null;
    setMenu(null);
    if (refocus && was?.element.isConnected) was.element.focus({ preventScroll: true });
  }, []);
  const open = useCallback((anchor: HTMLElement, items: MenuItem[], onClose?: () => void) => {
    current.current?.onClose?.();
    current.current = { anchor: anchor.getBoundingClientRect(), element: anchor, items, onClose };
    setMenu(current.current);
  }, []);

  useEffect(() => {
    if (!menu) return;
    // Перехват на window в фазе захвата: раньше всех остальных обработчиков клавиш.
    const onKey = (e: KeyboardEvent) => {
      const popup = document.querySelector<HTMLElement>(".popup[role=menu]");
      if (e.key === "Escape" || e.key === "Tab") {
        e.stopImmediatePropagation();
        if (e.key === "Escape") e.preventDefault();
        close(true);   // по Tab фокус уходит дальше от кнопки меню
        return;
      }
      if (!popup) return;
      const items = [...popup.querySelectorAll<HTMLElement>("[role=menuitem], .popup-custom button")];
      if (!items.length) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = { ArrowDown: at + 1, ArrowUp: at < 0 ? items.length - 1 : at - 1, Home: 0, End: items.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      items[(next + items.length) % items.length].focus();
    };
    // Закрываем, только если кнопка действительно уехала: событие прокрутки
    // может прийти с опозданием — от прокрутки, случившейся до открытия меню.
    const onScroll = () => {
      const now = menu.element.getBoundingClientRect();
      if (Math.abs(now.top - menu.anchor.top) > 1 || Math.abs(now.left - menu.anchor.left) > 1) close();
    };
    addEventListener("scroll", onScroll, true);
    const onResize = () => close();
    addEventListener("resize", onResize);
    addEventListener("keydown", onKey, true);
    return () => {
      removeEventListener("scroll", onScroll, true);
      removeEventListener("resize", onResize);
      removeEventListener("keydown", onKey, true);
    };
  }, [menu, close]);

  return (
    <MenuContext.Provider value={open}>
      {children}
      {menu && <Popup menu={menu} close={close} />}
    </MenuContext.Provider>
  );
}

function Popup({ menu, close }: { menu: OpenMenu; close: (refocus?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });

  // Меню прижато к правому краю кнопки и не выходит за экран;
  // если снизу не помещается — открывается вверх.
  useLayoutEffect(() => {
    const el = ref.current!;
    const { anchor } = menu;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const below = anchor.bottom + 6;
    setPos({
      left: Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8)),
      top: below + height > innerHeight - 8 ? Math.max(8, anchor.top - height - 6) : below,
    });
  }, [menu]);

  // Фокус — на первый пункт, когда меню уже встало на место (иначе прокрутка к -9999).
  useEffect(() => {
    if (pos.top < 0) return;
    ref.current?.querySelector<HTMLElement>("[role=menuitem], .popup-custom button")?.focus({ preventScroll: true });
  }, [pos]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    // Щелчок мимо закрывает меню, не трогая фокус: он уйдёт туда, куда щёлкнули.
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [close]);

  return (
    <div className="popup" role="menu" ref={ref} style={pos}>
      {menu.items.map((item, i) => !item ? <div key={"sep" + i} className="sep" />
        : "custom" in item ? <div key={"custom" + i} className="popup-custom">{item.custom}</div> : (
          <button key={item.label} role="menuitem" className={item.danger ? "danger" : ""}
            tabIndex={-1} onClick={() => { close(true); item.run(); }}>
            {item.label}
          </button>
        ))}
    </div>
  );
}

/** Открыть меню у произвольной кнопки: anchor — кнопка, items — пункты. */
export const useMenu = () => useContext(MenuContext);

/** label превращает кнопку «⋯» в плашку с названием объекта: так меню
    получают вложенные объекты, которым не нужна отдельная строка. */
export function MenuButton({ items, label }: { items: () => MenuItem[]; label?: string }) {
  const open = useContext(MenuContext);
  // В меню «⋯» только изменяющие действия — читателю оно не показывается.
  if (!useAuth().canEdit) return label ? <span className="chip">{label}</span> : null;
  return (
    <button className={label ? "chip chip-btn" : "btn sm menu-btn"} aria-haspopup="menu"
      title={label ? undefined : "Действия"} aria-label={label ? undefined : "Действия"}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); open(e.currentTarget, items()); }}>
      {label ?? "⋯"}
    </button>
  );
}
