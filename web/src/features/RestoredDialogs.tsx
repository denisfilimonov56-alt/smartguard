import { useEffect, useRef } from "react";

import { useCatalog } from "../state/catalog";
import { hasDraft, takeDraft } from "../state/drafts";
import { useDialogs } from "../ui/Dialogs";
import { errorText, useToast } from "../ui/Toasts";
import { ADVICE_DRAFT, AdviceDialog, type AdviceDraft } from "./check/AdviceDialog";
import { PROPERTIES_DRAFT, reopenProperties, type PropertiesDraft } from "./PropertiesDialog";
import { CELL_DRAFT, CellEditor, type CellDraft } from "./rules/CellEditor";

/* Окна, открытые в момент конца сессии: редактор свойств, окно ячейки матрицы
   и советчик. Их черновики кладутся в хранилище вкладки перед повторным входом
   (state/drafts.ts), а после возврата окно открывается снова с тем же вводом.
   Окно за раз одно, значит и черновик такого окна — не больше одного. */

export function RestoredDialogs() {
  const { openCustom } = useDialogs();
  const toast = useToast();
  const { orders, departments, apiState } = useCatalog();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    if (![PROPERTIES_DRAFT, CELL_DRAFT, ADVICE_DRAFT].some(hasDraft)) { done.current = true; return; }
    // Окну ячейки нужны правило и подразделение из каталога: ждём первой загрузки.
    if (apiState !== "online") return;
    done.current = true;

    const props = takeDraft<PropertiesDraft>(PROPERTIES_DRAFT);
    if (props) {
      reopenProperties(props, openCustom).catch((err) => toast("Не удалось открыть свойства узла: " + errorText(err), "err"));
      return;
    }
    const cell = takeDraft<CellDraft>(CELL_DRAFT);
    if (cell) {
      const rule = orders.flatMap((o) => o.clauses.flatMap((c) => c.rules)).find((r) => r.nodeId === cell.ruleNodeId);
      const department = departments.find((d) => d.departmentId === cell.departmentId);
      if (rule && department) {
        openCustom((close) => <CellEditor rule={rule} department={department} initialMode={cell.mode} close={close} />);
      }
      return;
    }
    const advice = takeDraft<AdviceDraft>(ADVICE_DRAFT);
    if (advice) {
      // Граф поправили — ответ проверки устарел; проверку пользователь повторит сам.
      openCustom((close) => <AdviceDialog result={advice.result} departmentId={advice.departmentId}
        attribute={advice.attribute} reason={advice.reason} onApplied={() => undefined} close={close} />);
    }
  }, [apiState, orders, departments, openCustom, toast]);

  return null;
}
