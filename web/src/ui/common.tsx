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
