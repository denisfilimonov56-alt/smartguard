import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

/* Выбор даты и времени в стиле интерфейса вместо системного календаря:
   системный <input type="date"> не даёт выбрать время, а datetime-local
   в каждом браузере выглядит по-своему. Значение — местное время строкой
   «ГГГГ-ММ-ДДTЧЧ:ММ»: такие строки сравниваются как текст. Окно рендерится
   в body, как и меню Select; управляется мышью и клавиатурой. */

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Границы выбора в том же формате; дни вне их недоступны. */
  min?: string;
  max?: string;
  id?: string;
  ariaLabel?: string;
  style?: CSSProperties;
}

const GAP = 6;
const WIDTH = 292;
const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь",
  "Ноябрь", "Декабрь"];

const pad = (n: number) => String(n).padStart(2, "0");
/** Местное время строкой «ГГГГ-ММ-ДДTЧЧ:ММ». */
export const localDateTime = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayKey = (d: Date) => localDateTime(d).slice(0, 10);
const monthStart = (key: string) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
const human = (value: string) =>
  `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)} ${value.slice(11, 16)}`;

/** Часы или минуты: ввод цифрами, стрелки вверх и вниз меняют на единицу по кругу. */
function TimePart({ label, value, max, onChange }: {
  label: string; value: number; max: number; onChange: (value: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(pad(value));
  // Пока в поле печатают, оно не переписывается: «1» не должно превращаться в «01» до второй цифры.
  useEffect(() => { if (document.activeElement !== input.current) setDraft(pad(value)); }, [value]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const next = (value + (e.key === "ArrowUp" ? 1 : max)) % (max + 1);
    setDraft(pad(next));
    onChange(next);
  }

  return (
    <input ref={input} type="text" inputMode="numeric" maxLength={2} aria-label={label} value={draft}
      onFocus={(e) => e.target.select()} onBlur={() => setDraft(pad(value))} onKeyDown={onKeyDown}
      onChange={(e) => {
        const text = e.target.value.replace(/\D/g, "");
        setDraft(text);
        if (text && Number(text) <= max) onChange(Number(text));
      }} />
  );
}

export function DateTime({ value, onChange, min, max, id, ariaLabel, style }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => monthStart(value));
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  /** День, на который нужно перевести фокус после перерисовки сетки. */
  const [focusDay, setFocusDay] = useState<string | null>(null);

  const selected = value.slice(0, 10);
  const today = dayKey(new Date());
  const allowed = (key: string) => !(min && key < min.slice(0, 10)) && !(max && key > max.slice(0, 10));

  // Сетка всегда из шести недель с понедельника: высота окна не прыгает от месяца к месяцу.
  const offset = (view.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, i) => new Date(view.getFullYear(), view.getMonth(), 1 - offset + i));

  // Tab попадает на один день сетки: выбранный, а если он в другом месяце — на первое число.
  const tabStop = days.some((d) => dayKey(d) === selected) ? selected : dayKey(view);

  function show() {
    setView(monthStart(value));
    setOpen(true);
  }

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  const pickDay = (key: string) => onChange(`${key}T${value.slice(11, 16)}`);
  const setTime = (hours: number, minutes: number) => onChange(`${selected}T${pad(hours)}:${pad(minutes)}`);
  const shift = (months: number) => setView((v) => new Date(v.getFullYear(), v.getMonth() + months, 1));

  // Окно — под полем; если снизу тесно, а сверху места больше, открывается вверх.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !pop.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const height = pop.current.offsetHeight;
    const up = innerHeight - rect.bottom - GAP < height && rect.top > innerHeight - rect.bottom;
    setPos({
      left: Math.max(8, Math.min(rect.left, innerWidth - WIDTH - 8)),
      top: up ? Math.max(8, rect.top - GAP - height) : rect.bottom + GAP,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const anchor = trigger.current!.getBoundingClientRect();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!trigger.current?.contains(target) && !pop.current?.contains(target)) setOpen(false);
    };
    const onScroll = () => {
      const now = trigger.current?.getBoundingClientRect();
      if (!now || Math.abs(now.top - anchor.top) > 1 || Math.abs(now.left - anchor.left) > 1) setOpen(false);
    };
    const hide = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mousedown", onDown);
      removeEventListener("scroll", onScroll, true);
      removeEventListener("resize", hide);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !focusDay) return;
    pop.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)?.focus();
    setFocusDay(null);
  }, [open, focusDay, view]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      // Escape закрывает только календарь, а не диалог, в котором он открыт.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  /** Стрелки ходят по дням и неделям, перелистывая месяц на его границе. */
  function onGridKeyDown(e: KeyboardEvent) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    const from = (e.target as HTMLElement).dataset.day;
    if (!step || !from) return;
    e.preventDefault();
    const next = new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)) + step);
    if (!allowed(dayKey(next))) return;
    if (next.getMonth() !== view.getMonth()) setView(new Date(next.getFullYear(), next.getMonth(), 1));
    setFocusDay(dayKey(next));
  }

  return (
    <>
      <button ref={trigger} type="button" id={id} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel}
        data-value={value} className={`select dt ${open ? "open" : ""}`} style={style}
        onClick={() => (open ? setOpen(false) : show())} onKeyDown={open ? onKeyDown : undefined}>
        <span className="select-value">{human(value)}</span>
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <rect x="1.5" y="2.5" width="11" height="10" rx="2" /><path d="M1.5 5.5h11M4.5 1v3M9.5 1v3" />
        </svg>
      </button>
      {open && createPortal(
        <div ref={pop} role="dialog" aria-label={ariaLabel} className="dt-pop" onKeyDown={onKeyDown}
          style={{ width: WIDTH, ...(pos ?? { left: -9999, top: -9999 }) }}>
          <div className="dt-head">
            <button type="button" className="dt-nav" aria-label="Предыдущий месяц" onClick={() => shift(-1)}>
              <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5L4 6l3.5 3.5" /></svg>
            </button>
            <span className="dt-month" aria-live="polite">{MONTHS[view.getMonth()]} {view.getFullYear()}</span>
            <button type="button" className="dt-nav" aria-label="Следующий месяц" onClick={() => shift(1)}>
              <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5L8 6 4.5 9.5" /></svg>
            </button>
          </div>
          <div className="dt-grid" onKeyDown={onGridKeyDown}>
            {WEEKDAYS.map((name) => <span key={name} className="dt-weekday">{name}</span>)}
            {days.map((d) => {
              const key = dayKey(d);
              const outside = d.getMonth() !== view.getMonth();
              return (
                <button key={key} type="button" data-day={key} disabled={!allowed(key)}
                  className={`dt-day ${outside ? "outside" : ""} ${key === today ? "today" : ""}`}
                  aria-pressed={key === selected} tabIndex={key === tabStop ? 0 : -1}
                  onClick={() => { pickDay(key); if (outside) setView(new Date(d.getFullYear(), d.getMonth(), 1)); }}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="dt-foot">
            <span className="dt-time">
              <span className="dim">Время</span>
              <TimePart label="Часы" value={Number(value.slice(11, 13))} max={23}
                onChange={(h) => setTime(h, Number(value.slice(14, 16)))} />
              <b>:</b>
              <TimePart label="Минуты" value={Number(value.slice(14, 16))} max={59}
                onChange={(m) => setTime(Number(value.slice(11, 13)), m)} />
            </span>
            <button type="button" className="btn sm primary" onClick={close}>Готово</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
