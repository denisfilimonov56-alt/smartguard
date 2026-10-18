import { useLayoutEffect, useRef, useState } from "react";

import { api } from "../../api/client";
import type { Department, Rule } from "../../api/types";
import { useCatalog } from "../../state/catalog";
import { cellState, scopeOf, withApplies, withOff, type CellState } from "../../state/scope";
import { Spinner } from "../../ui/common";
import { Overlay, useDialogs } from "../../ui/Dialogs";
import { errorText, useToast } from "../../ui/Toasts";

/* Решение по одной ячейке матрицы: как правило относится к подразделению.
   Два состояния: действует или не распространяется. */

interface Props {
  rule: Rule;
  department: Department;
  /** Ячейка, у которой открыть окно; без неё окно по центру. */
  anchor?: DOMRect;
  close: () => void;
}

export function useCellEditor() {
  const { openCustom } = useDialogs();
  return (props: Omit<Props, "close">) => openCustom((close) => <CellEditor {...props} close={close} />);
}

function CellEditor({ rule, department, anchor, close }: Props) {
  const toast = useToast();
  const { departments, mutate } = useCatalog();
  const known = departments.filter((d) => d.departmentId);
  const departmentId = department.departmentId ?? "";
  const [mode, setMode] = useState<CellState>(cellState(rule, departmentId));
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Окно — под ячейкой; если не помещается, поднимается, чтобы остаться на экране.
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    setPos({
      left: Math.max(12, Math.min(anchor.left + anchor.width / 2 - w / 2, innerWidth - w - 12)),
      top: Math.max(12, Math.min(anchor.bottom + 8, innerHeight - h - 12)),
    });
  }, [anchor]);

  async function save() {
    const scope = scopeOf(rule);
    const next = mode === "applies" ? withApplies(scope, departmentId)
      : withOff(scope, departmentId, known.map((d) => d.departmentId!));
    if (!next) {
      toast("Правило должно действовать хотя бы в одном подразделении. Если оно больше не нужно — отправьте его в архив.", "err");
      return;
    }
    setBusy(true);
    try {
      await mutate(() => api.setRuleScope(rule.nodeId, next), "Область действия обновлена");
      close();
    } catch (err) {
      toast(errorText(err), "err");
      setBusy(false);
    }
  }

  const option = (value: CellState, title: string, detail?: string) => (
    <button type="button" role="radio" aria-checked={mode === value} className="opt" onClick={() => setMode(value)}>
      <i /><span className="t">{title}</span>
      {detail && <span className="d">{detail}</span>}
    </button>
  );

  const body = (
    <div ref={ref} role="dialog" aria-label="Решение по ячейке"
      className={anchor ? "pop" : "modal"} style={anchor ? pos ?? { left: -9999, top: -9999 } : { padding: "18px 20px", width: 420 }}>
      <div className="small dim">{rule.description}</div>
      <h2 style={{ fontSize: 17, marginTop: 2 }}>{department.name || department.departmentId}</h2>

      <div role="radiogroup">
        {option("applies", "Правило действует")}
        {option("off", "Не действует", "Приказ не распространяет правило на это подразделение")}
      </div>

      <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
        <button className="btn sm ghost" onClick={close}>Отмена</button>
        <button className="btn sm primary" disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner /> : "Сохранить"}
        </button>
      </div>
    </div>
  );

  return <Overlay clear={!!anchor} onClose={close}>{body}</Overlay>;
}
