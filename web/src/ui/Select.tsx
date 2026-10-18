import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

/* Выпадающий список в стиле интерфейса вместо системного <select>:
   у системного стрелка и само меню рисуются браузером и выбиваются из
   дизайна. Меню рендерится в body, поэтому его не обрезают ни диалоги,
   ни прокручиваемые панели; управляется мышью и клавиатурой. */

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  id?: string;
  ariaLabel?: string;
  /** "pill" — скруглённый вариант для панелей фильтров. */
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  autoFocus?: boolean;
}

interface Position {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

const GAP = 6;

export function Select({ value, options, onChange, id, ariaLabel, className = "", style, placeholder, autoFocus }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<Position | null>(null);
  const selected = options.find((o) => o.value === value);

  function show() {
    if (!options.length) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  function choose(option: SelectOption) {
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  }

  // Меню — под полем; если снизу тесно, а сверху места больше, открывается вверх.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const below = innerHeight - rect.bottom - GAP - 12;
    const above = rect.top - GAP - 12;
    const height = Math.min(list.current?.scrollHeight ?? 0, 320);
    const up = below < Math.min(height, 160) && above > below;
    const maxHeight = Math.max(120, Math.min(320, up ? above : below));
    setPos({
      left: Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8)),
      top: up ? rect.top - GAP - Math.min(height, maxHeight) : rect.bottom + GAP,
      width: rect.width,
      maxHeight,
    });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const anchor = trigger.current!.getBoundingClientRect();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!trigger.current?.contains(target) && !list.current?.contains(target)) setOpen(false);
    };
    // Прокрутка самого меню поле не двигает — закрываем, только если поле уехало.
    const onScroll = () => {
      const now = trigger.current?.getBoundingClientRect();
      if (!now || Math.abs(now.top - anchor.top) > 1 || Math.abs(now.left - anchor.left) > 1) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      removeEventListener("scroll", onScroll, true);
      removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function onKeyDown(e: KeyboardEvent) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); show(); }
      return;
    }
    if (e.key === "Escape") {
      // Escape закрывает только меню, а не диалог, в котором оно открыто.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <>
      <button ref={trigger} type="button" id={id} role="combobox" aria-haspopup="listbox" aria-expanded={open}
        aria-label={ariaLabel} data-value={value} autoFocus={autoFocus}
        className={`select ${open ? "open" : ""} ${className}`} style={style}
        onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKeyDown}>
        <span className={`select-value ${selected ? "" : "dim"}`}>{selected?.label ?? placeholder ?? ""}</span>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5" /></svg>
      </button>
      {open && createPortal(
        <div ref={list} role="listbox" className="select-pop"
          style={pos ?? { left: -9999, top: -9999, width: 0, maxHeight: 320 }}>
          {options.map((o, i) => (
            <div key={o.value} role="option" aria-selected={o.value === value} data-value={o.value}
              data-active={i === active} onMouseEnter={() => setActive(i)}
              // Фокус остаётся на поле: иначе клавиатура перестаёт управлять меню.
              onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)}>
              <span>{o.label}</span>
              {o.value === value && <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5l2.5 2.5 4.5-5" /></svg>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
