import type { ReactNode } from "react";

import type { Status } from "../api/types";

export const Spinner = () => <span className="spinner" />;

export const ArchivedBadge = ({ status }: { status?: Status }) =>
  status === "archived" ? <span className="badge archived">в архиве</span> : null;

/** Плашка «нет ключа»: без бизнес-ключа узел не попадёт в выгрузку seed.cypher. */
export const IdBadge = ({ value, name }: { value: unknown; name: string }) =>
  value ? null : (
    <span className="badge warn" title={`Без ${name} узел не попадёт в выгрузку`}>нет {name}</span>
  );

export const Chip = ({ children }: { children: React.ReactNode }) => <span className="chip">{children}</span>;

export const archivedClass = (status?: Status) => (status === "archived" ? "is-archived" : "");

/** Шапка раздела: заголовок, пояснение и действия справа — одинаковые отступы во всех разделах. */
export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-title">
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children && <div className="row page-actions">{children}</div>}
    </div>
  );
}

const EMPTY_ICONS = {
  list: <path d="M4 6h12M4 10h12M4 14h8" />,
  search: <><circle cx="9" cy="9" r="5" /><path d="M13 13l4 4" /></>,
  check: <><circle cx="10" cy="10" r="7" /><path d="M7 10l2 2 4-4" /></>,
  chart: <path d="M3 16h14M5 13V8M9 13V5M13 13v-4" />,
  key: <><circle cx="7" cy="12" r="3" /><path d="M9.5 10L17 3M14 6l2 2M12 8l2 2" /></>,
};
export type EmptyIcon = keyof typeof EMPTY_ICONS;

/** Пустое состояние: значок, заголовок, пояснение и первое действие. */
export function Empty({ icon = "list", title, children, action }: {
  icon?: EmptyIcon; title: ReactNode; children?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-ico" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {EMPTY_ICONS[icon]}
        </svg>
      </span>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** Заглушка на время загрузки: серые полосы той же формы, что и будущая карточка. */
export function Skeleton({ rows = 3, card = true, label = "Загрузка…" }: { rows?: number; card?: boolean; label?: string }) {
  return (
    <div className={`skeleton ${card ? "card pad" : ""}`} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="sk-line" style={{ width: `${Math.max(30, 92 - i * 21)}%` }} />
      ))}
    </div>
  );
}
