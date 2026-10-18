import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode,
} from "react";

import { registerDraft, takeDraft } from "../state/drafts";
import { Spinner } from "./common";
import { CrashCard, ErrorBoundary } from "./ErrorBoundary";
import { Select } from "./Select";
import { errorText, useToast } from "./Toasts";

/* Одно модальное окно за раз: форма, подтверждение или произвольное
   содержимое (редактор свойств). Escape и клик по фону закрывают форму.
   Новое окно не подменяет форму с несохранённым вводом: сначала она
   переспрашивает (guard). Tab не уходит из окна к странице под затемнением,
   а после закрытия фокус возвращается туда, откуда окно открыли. */

export interface Option {
  value: string;
  label: string;
  description?: string;
}

interface FieldBase {
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
}

export type Field =
  | (FieldBase & { type?: "text" | "date"; value?: string; placeholder?: string })
  | (FieldBase & { type: "textarea"; value?: string; placeholder?: string })
  | (FieldBase & { type: "select"; value?: string; options: Option[] })
  | (FieldBase & { type: "checkbox"; value?: boolean })
  | (FieldBase & { type: "multi"; value?: string[]; options: Option[]; emptyText?: string });

export type Values = Record<string, string | boolean | string[]>;

export interface FormConfig {
  title: string;
  fields: Field[];
  submitLabel?: string;
  wide?: boolean;
  onSubmit: (values: Values) => Promise<unknown>;
}

export interface ConfirmConfig {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

interface DialogApi {
  openForm: (config: FormConfig) => void;
  confirm: (config: ConfirmConfig) => Promise<boolean>;
  openCustom: (render: (close: () => void) => ReactNode) => void;
  close: () => void;
  /** Проверка перед закрытием по Escape: вернуть false, чтобы окно осталось (например, спросить о несохранённом). */
  setGuard: (guard: (() => boolean) | null) => void;
}

const DialogContext = createContext<DialogApi | null>(null);

export function useDialogs() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialogs вне DialogProvider");
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<{ id: number; node: ReactNode } | null>(null);
  const guard = useRef<(() => boolean) | null>(null);
  /** Ответ ждущего подтверждения: окно закрыли или подменили — ответ «нет», а не вечное ожидание. */
  const answer = useRef<((value: boolean) => void) | null>(null);
  /** Элемент, с которого открыли окно: после закрытия фокус возвращается на него. */
  const returnFocus = useRef<HTMLElement | null>(null);
  const opened = useRef(false);
  const counter = useRef(0);

  const settle = () => {
    const resolve = answer.current;
    answer.current = null;
    resolve?.(false);
    guard.current = null;
  };

  const show = useCallback((node: ReactNode) => {
    settle();
    if (!opened.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    opened.current = true;
    setDialog({ id: ++counter.current, node });
  }, []);

  const close = useCallback(() => {
    settle();
    setDialog(null);
    if (!opened.current) return;
    opened.current = false;
    const target = returnFocus.current;
    returnFocus.current = null;
    // Фокус возвращается, когда окно уже ушло из DOM, — если новое не открылось
    // и фокус никто не забрал (он пропал вместе с окном и сейчас на body).
    if (target) requestAnimationFrame(() => {
      const free = !document.activeElement || document.activeElement === document.body;
      if (!opened.current && free && target.isConnected) target.focus();
    });
  }, []);

  /** Можно ли подменить текущее окно: форма с несохранённым вводом сначала переспрашивает. */
  const mayReplace = () => !guard.current || guard.current();

  const api = useMemo<DialogApi>(() => ({
    close,
    setGuard: (next) => { guard.current = next; },
    openForm: (config) => { if (mayReplace()) show(<FormDialog config={config} close={close} />); },
    // Подтверждение тоже не подменяет форму с несохранённым вводом: она переспрашивает,
    // а действие получает «нет» — его можно повторить, закрыв или сохранив форму.
    confirm: (config) => !mayReplace() ? Promise.resolve(false) : new Promise<boolean>((resolve) => {
      show(<ConfirmDialog config={config} done={(value) => { answer.current = null; close(); resolve(value); }} />);
      answer.current = resolve;
    }),
    openCustom: (render) => { if (mayReplace()) show(render(close)); },
  }), [close, show]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !opened.current) return;
      if (guard.current && !guard.current()) return;
      close();   // ждущее подтверждение получает «нет»
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [close]);

  // Черновик формы, сохранённый перед повторным входом (state/drafts.ts): показать, что ввод не пропал.
  useEffect(() => {
    const draft = takeDraft<FormDraft>("form");
    if (!draft) return;
    restoredForm = draft;
    show(<RestoredFormDialog draft={draft} close={close} />);
  }, [show, close]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      <div id="modalRoot">
        {/* Ошибка в окне закрывает только окно, а не всё приложение. */}
        {dialog && (
          <ErrorBoundary key={dialog.id} fallback={(error) => (
            <Overlay onClose={close}>
              <CrashCard title="Окно не удалось показать" error={error}
                hint="Окно закрыто без сохранения. Если ошибка повторяется, сообщите администратору текст ниже.">
                <button type="button" className="btn" onClick={close}>Закрыть</button>
              </CrashCard>
            </Overlay>
          )}>
            {dialog.node}
          </ErrorBoundary>
        )}
      </div>
    </DialogContext.Provider>
  );
}

/* Всплывающие списки, календарь, меню и поиск открываются в портале у body,
   но принадлежат окну: Tab по ним ловушка не перехватывает. */
const POPUPS = ".select-pop, .dt-pop, .popup, .palette-overlay";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Фон модального окна; клик мимо окна закрывает его. Tab и Shift+Tab ходят по кругу внутри окна. */
export function Overlay({ onClose, clear, children }: {
  onClose?: () => void;
  /** Без затемнения — для всплывающего окна, привязанного к элементу. */
  clear?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Окно без autoFocus: фокус переносится в него, иначе он остаётся на странице под затемнением.
    if (!root.contains(document.activeElement)) {
      const first = root.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? root).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(POPUPS)) return;
      // Вложенное окно (например, сессия завершена поверх формы) ловит Tab само.
      const overlays = document.querySelectorAll(".overlay:not(.palette-overlay)");
      if (overlays[overlays.length - 1] !== root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (!target || !root.contains(target)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && target === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && target === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div ref={ref} tabIndex={-1} className={`overlay ${clear ? "clear" : ""}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      {children}
    </div>
  );
}

/** Несохранённая форма, отложенная на время повторного входа. */
interface FormDraft {
  title: string;
  /** Исходные значения формы: по ним узнаётся та же форма того же объекта. */
  initial: string;
  fields: { name: string; label: string }[];
  values: Values;
}

/** Черновик ждёт, пока ту же форму откроют снова: тогда значения подставятся. */
let restoredForm: FormDraft | null = null;

function takeRestored(title: string, initial: string): Values | null {
  const draft = restoredForm;
  if (!draft || draft.title !== title || draft.initial !== initial) return null;
  restoredForm = null;
  return draft.values;
}

const shown = (value: Values[string]) =>
  Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "да" : "нет") : value;

/** После повторного входа: какая форма была открыта и что в неё было введено. */
function RestoredFormDialog({ draft, close }: { draft: FormDraft; close: () => void }) {
  return (
    <Overlay onClose={close}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="Восстановленный ввод">
        <h3>Ввод сохранён на время входа</h3>
        <div className="content">
          <p className="muted" style={{ marginTop: 0 }}>
            Перед повторным входом была открыта форма «{draft.title}». Откройте её снова тем же
            действием — введённые значения подставятся сами. На всякий случай они ниже.
          </p>
          {draft.fields.map((f) => (
            <div className="field" key={f.name}>
              <label htmlFor={"restored_" + f.name}>{f.label}</label>
              <textarea id={"restored_" + f.name} readOnly rows={2} value={shown(draft.values[f.name] ?? "")} />
            </div>
          ))}
        </div>
        <div className="foot">
          <button type="button" className="btn primary" autoFocus onClick={close}>Понятно</button>
        </div>
      </div>
    </Overlay>
  );
}

const initialValue = (f: Field): string | boolean | string[] =>
  f.type === "checkbox" ? !!f.value : f.type === "multi" ? [...(f.value ?? [])] : (f.value ?? "");

function FormDialog({ config, close }: { config: FormConfig; close: () => void }) {
  const toast = useToast();
  const { title, fields, submitLabel = "Сохранить", wide = false, onSubmit } = config;
  // Несохранённые изменения: Escape и клик мимо окна сначала переспрашивают; «Отмена» закрывает сразу.
  const initial = useMemo(() => JSON.stringify(Object.fromEntries(fields.map((f) => [f.name, initialValue(f)]))), [fields]);
  // Та же форма, открытая после повторного входа, получает введённое до него (state/drafts.ts).
  const [values, setValues] = useState<Values>(() => takeRestored(title, initial)
    ?? Object.fromEntries(fields.map((f) => [f.name, initialValue(f)])));
  const [busy, setBusy] = useState(false);
  const set = (name: string, value: Values[string]) => setValues((v) => ({ ...v, [name]: value }));
  const dirty = JSON.stringify(values) !== initial;
  const latest = useRef({ values, dirty });
  latest.current = { values, dirty };
  useEffect(() => registerDraft("form", () => latest.current.dirty ? {
    title, initial, fields: fields.map((f) => ({ name: f.name, label: f.label })), values: latest.current.values,
  } satisfies FormDraft : undefined), [title, initial, fields]);
  const [closing, setClosing] = useState(false);
  const { setGuard } = useDialogs();
  useEffect(() => {
    setGuard(() => { if (!dirty) return true; setClosing(true); return false; });
    return () => setGuard(null);
  }, [dirty, setGuard]);
  const requestClose = () => (dirty ? setClosing(true) : close());

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cleaned: Values = {};
    for (const f of fields) {
      const raw = values[f.name];
      cleaned[f.name] = typeof raw === "string" ? raw.trim() : raw;
      if (f.required && !cleaned[f.name]) { toast(`Заполните поле «${f.label}»`, "err"); return; }
    }
    setBusy(true);
    try {
      await onSubmit(cleaned);
      close();
    } catch (err) {
      toast(errorText(err), "err");
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={requestClose}>
      <form className={`modal ${wide ? "wide" : ""}`} onSubmit={submit} noValidate
        role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}{dirty && <span className="badge warn unsaved">не сохранено</span>}</h3>
        <div className="content">
          {fields.map((f, i) => (
            <FieldControl key={f.name} field={f} value={values[f.name]} autoFocus={i === 0}
              onChange={(v) => set(f.name, v)} />
          ))}
        </div>
        {closing && (
          <div className="unsaved-bar" role="alert">
            <span>Есть несохранённые изменения.</span>
            <button type="button" className="btn sm danger" onClick={close}>Закрыть без сохранения</button>
            <button type="button" className="btn sm" onClick={() => setClosing(false)}>Продолжить</button>
          </div>
        )}
        <div className="foot">
          <button type="button" className="btn" onClick={close}>Отмена</button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? <><Spinner /> Сохранение…</> : submitLabel}
          </button>
        </div>
      </form>
    </Overlay>
  );
}

function FieldControl({ field: f, value, onChange, autoFocus }: {
  field: Field; value: Values[string]; onChange: (v: Values[string]) => void; autoFocus: boolean;
}) {
  const id = "f_" + f.name;
  const hint = f.hint ? <div className="hint">{f.hint}</div> : null;

  if (f.type === "checkbox") {
    return (
      <div className="field">
        <label className="check">
          <input type="checkbox" id={id} checked={!!value} autoFocus={autoFocus}
            onChange={(e) => onChange(e.target.checked)} /> {f.label}
        </label>
        {hint}
      </div>
    );
  }

  let control: ReactNode;
  if (f.type === "textarea") {
    control = <textarea id={id} value={value as string} placeholder={f.placeholder} autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)} />;
  } else if (f.type === "select") {
    control = (
      <Select id={id} value={value as string} autoFocus={autoFocus} onChange={onChange} options={f.options} />
    );
  } else if (f.type === "multi") {
    const selected = value as string[];
    control = (
      <div className="optlist" id={id}>
        {f.options.length ? f.options.map((o, i) => (
          <label key={o.value}>
            <input type="checkbox" value={o.value} checked={selected.includes(o.value)}
              autoFocus={autoFocus && i === 0}
              onChange={(e) => onChange(e.target.checked
                ? [...selected, o.value] : selected.filter((v) => v !== o.value))} />
            <span>
              <span className="mono">{o.label || o.value}</span>
              {o.description ? <><br /><span className="d">{o.description}</span></> : null}
            </span>
          </label>
        )) : <div className="d" style={{ padding: 10 }}>{f.emptyText || "Список пуст."}</div>}
      </div>
    );
  } else {
    control = <input type={f.type || "text"} id={id} value={value as string} placeholder={f.placeholder}
      autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />;
  }

  return (
    <div className="field">
      <label htmlFor={id}>{f.label}</label>
      {control}
      {hint}
    </div>
  );
}

function ConfirmDialog({ config, done }: { config: ConfirmConfig; done: (answer: boolean) => void }) {
  const { title, message, confirmLabel = "Подтвердить", danger = false } = config;
  return (
    <Overlay>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <div className="content">{message}</div>
        <div className="foot">
          <button className="btn" onClick={() => done(false)}>Отмена</button>
          <button className={`btn ${danger ? "danger" : "primary"}`} autoFocus onClick={() => done(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
