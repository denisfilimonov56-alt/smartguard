import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { api } from "../api/client";
import type { NodeProps } from "../api/types";
import { useCatalog } from "../state/catalog";
import { registerDraft } from "../state/drafts";
import { Spinner } from "../ui/common";
import { Overlay, useDialogs } from "../ui/Dialogs";
import { Select } from "../ui/Select";
import { errorText, useToast } from "../ui/Toasts";

/* Редактор произвольных свойств узла: добавить поле, сменить тип,
   удалить свойство. status сюда не попадает — у него своя логика. */

type PropType = "string" | "number" | "boolean" | "date";

const PROP_TYPES: { value: PropType; label: string }[] = [
  { value: "string", label: "строка" },
  { value: "number", label: "число" },
  { value: "boolean", label: "да/нет" },
  { value: "date", label: "дата" },
];

const SKIP = new Set(["nodeId", "labels", "status"]);

interface Row {
  id: number;
  key: string;
  type: PropType;
  value: string;
  isNew: boolean;
  removed: boolean;
  /** Тип и значение при открытии: сохраняются только изменённые свойства. */
  initial: { type: PropType; value: string };
}

function guessType(value: unknown): PropType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  return "string";
}

let rowId = 0;
function toRow(key: string, value: unknown, isNew = false): Row {
  const type = guessType(value);
  const text = value === null || value === undefined ? "" : String(value);
  return { id: ++rowId, key, type, isNew, removed: false, value: text, initial: { type, value: text } };
}

/* Свойство, которого не касались, не отправляется: иначе снимок на момент
   открытия затёр бы правки, сделанные за это время в другом окне, а строки
   с пробелами по краям обрезались бы без ведома редактора. */
const touched = (row: Row) =>
  row.isNew || row.removed || row.type !== row.initial.type || row.value !== row.initial.value;

/** Черновик редактора свойств на время повторного входа (state/drafts.ts): узел и строки. */
export interface PropertiesDraft {
  nodeId: string;
  rows: Omit<Row, "id">[];
}
export const PROPERTIES_DRAFT = "properties";

/** Открыть редактор свойств с черновиком после повторного входа (features/RestoredDialogs.tsx). */
export async function reopenProperties(draft: PropertiesDraft,
  openCustom: (render: (close: () => void) => ReactNode) => void) {
  const node = await api.node(draft.nodeId);
  const rows = draft.rows.map((r) => ({ ...r, id: ++rowId }));
  openCustom((close) => <PropertiesDialog node={node} restored={rows} close={close} />);
}

export function usePropertiesEditor() {
  const { openCustom } = useDialogs();
  const toast = useToast();
  return async (nodeId: string) => {
    let node: NodeProps;
    try { node = await api.node(nodeId); } catch (err) { toast(errorText(err), "err"); return; }
    openCustom((close) => <PropertiesDialog node={node} close={close} />);
  };
}

function PropertiesDialog({ node, restored, close }: { node: NodeProps; restored?: Row[]; close: () => void }) {
  const toast = useToast();
  const { reload } = useCatalog();
  const [rows, setRows] = useState<Row[]>(() => restored
    ?? Object.entries(node).filter(([k]) => !SKIP.has(k)).map(([k, v]) => toRow(k, v)));
  // Сессия кончилась посреди правки — после повторного входа окно откроется с тем же вводом.
  const latest = useRef(rows);
  latest.current = rows;
  useEffect(() => registerDraft(PROPERTIES_DRAFT, () => latest.current.some(touched)
    ? { nodeId: node.nodeId, rows: latest.current.map(({ id: _id, ...rest }) => rest) } satisfies PropertiesDraft
    : undefined), [node.nodeId]);
  const [busy, setBusy] = useState(false);
  const update = (id: number, patch: Partial<Row>) =>
    setRows((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const properties: Record<string, unknown> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key || !touched(row)) continue;
      if (row.isNew && row.removed) continue;
      if (row.removed) { properties[key] = null; continue; }
      const raw = row.value.trim();
      if (row.type === "number") {
        const n = Number(raw);
        if (raw !== "" && Number.isNaN(n)) { toast(`«${key}»: не число`, "err"); return; }
        properties[key] = raw === "" ? null : n;
      } else if (row.type === "boolean") {
        properties[key] = /^(да|true|1|yes)$/i.test(raw);
      } else {
        properties[key] = raw;
      }
    }
    if (!Object.keys(properties).length) { close(); return; }
    setBusy(true);
    try {
      await api.patch(node.nodeId, properties);
      close();
      toast("Свойства сохранены", "ok");
      await reload();
    } catch (err) {
      toast(errorText(err), "err");
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={close}>
      <form className="modal wide" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="propsTitle">
        <h3 id="propsTitle">Свойства узла :{node.labels.join(":")}</h3>
        <div className="content">
          <div className="dim" style={{ marginBottom: 12 }}>
            Здесь можно править любое свойство, включая ключевые. Ключ проверяется
            на уникальность: выгрузка в seed.cypher строит по нему MERGE.
            Статус меняется кнопками «В архив» / «Вернуть».
          </div>
          <div id="propRows">
            {rows.map((row) => (
              <div key={row.id} className={`prop-row ${row.removed ? "removed" : ""}`} data-prop={row.key}>
                <input type="text" aria-label="Имя свойства" value={row.key} placeholder="имя свойства"
                  readOnly={!row.isNew} onChange={(e) => update(row.id, { key: e.target.value })} />
                <Select ariaLabel="Тип свойства" value={row.type} options={PROP_TYPES}
                  onChange={(type) => update(row.id, { type: type as PropType })} />
                <input type="text" aria-label="Значение свойства" value={row.value} placeholder="значение"
                  onChange={(e) => update(row.id, { value: e.target.value })} />
                <button type="button" className="btn sm ghost" title="Удалить свойство"
                  onClick={() => update(row.id, { removed: !row.removed })}>✕</button>
              </div>
            ))}
          </div>
          <button type="button" className="btn sm" onClick={() => setRows((l) => [...l, toRow("", "", true)])}>
            + Свойство
          </button>
          <div className="hint" style={{ marginTop: 12 }}>
            <span className="mono">{node.nodeId}</span> — внутренний идентификатор узла Neo4j.
          </div>
        </div>
        <div className="foot">
          <button type="button" className="btn" onClick={close}>Отмена</button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? <><Spinner /> Сохранение…</> : "Сохранить"}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
