import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode,
} from "react";

import { Spinner } from "./common";
import { Select } from "./Select";
import { errorText, useToast } from "./Toasts";

/* Одно модальное окно за раз: форма, подтверждение или произвольное
   содержимое (редактор свойств). Escape и клик по фону закрывают форму. */

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
}

const DialogContext = createContext<DialogApi | null>(null);

export function useDialogs() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialogs вне DialogProvider");
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<ReactNode>(null);
  const close = useCallback(() => setDialog(null), []);

  const api = useMemo<DialogApi>(() => ({
    close,
    openForm: (config) => setDialog(<FormDialog key={Math.random()} config={config} close={close} />),
    confirm: (config) => new Promise<boolean>((resolve) => {
      const done = (answer: boolean) => { setDialog(null); resolve(answer); };
      setDialog(<ConfirmDialog key={Math.random()} config={config} done={done} />);
    }),
    openCustom: (render) => setDialog(render(close)),
  }), [close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      <div id="modalRoot">{dialog}</div>
    </DialogContext.Provider>
  );
}

/** Фон модального окна; клик мимо окна закрывает его. */
export function Overlay({ onClose, clear, children }: {
  onClose?: () => void;
  /** Без затемнения — для всплывающего окна, привязанного к элементу. */
  clear?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`overlay ${clear ? "clear" : ""}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      {children}
    </div>
  );
}

const initialValue = (f: Field): string | boolean | string[] =>
  f.type === "checkbox" ? !!f.value : f.type === "multi" ? [...(f.value ?? [])] : (f.value ?? "");

function FormDialog({ config, close }: { config: FormConfig; close: () => void }) {
  const toast = useToast();
  const { title, fields, submitLabel = "Сохранить", wide = false, onSubmit } = config;
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries(fields.map((f) => [f.name, initialValue(f)])));
  const [busy, setBusy] = useState(false);
  const set = (name: string, value: Values[string]) => setValues((v) => ({ ...v, [name]: value }));

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
    <Overlay onClose={close}>
      <form className={`modal ${wide ? "wide" : ""}`} onSubmit={submit} noValidate>
        <h3>{title}</h3>
        <div className="content">
          {fields.map((f, i) => (
            <FieldControl key={f.name} field={f} value={values[f.name]} autoFocus={i === 0}
              onChange={(v) => set(f.name, v)} />
          ))}
        </div>
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
      <div className="modal" role="dialog" aria-label={title}>
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
