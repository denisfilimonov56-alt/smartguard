import { useEffect, useState, useSyncExternalStore } from "react";
import type { JobDescriptionNode } from "../../api/client";
import { Overlay } from "../../ui/Dialogs";

/* Окно хода выписки обязанностей: открывается сразу после загрузки инструкции
   и показывает, что делает модель, пока выписка идёт в фоне. Опрос ведёт
   followDuties (actions.tsx) и кладёт свежее состояние в DutiesWatch; когда
   модель закончит, окно сменяется формой сверки списка. */

export interface DutiesWatch {
  get: () => JobDescriptionNode;
  set: (node: JobDescriptionNode) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createDutiesWatch(initial: JobDescriptionNode): DutiesWatch {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (node) => { current = node; listeners.forEach((l) => l()); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

function stageText(node: JobDescriptionNode): string {
  const p = node.dutiesProgress;
  if (!p) return "Ждёт очереди к модели";
  const part = p.parts > 1 ? ` — часть ${p.part} из ${p.parts}` : "";
  return (p.stage === "reading" ? "Модель читает инструкцию" : "Модель выписывает обязанности") + part;
}

/** id окна: по нему followDuties узнаёт, что окно хода ещё на экране (его не закрыли и не подменили). */
export const DUTIES_PROGRESS_ID = "dutiesProgress";
export const dutiesProgressShown = () => !!document.getElementById(DUTIES_PROGRESS_ID);

export function DutiesProgressDialog({ watch, title, close }: {
  watch: DutiesWatch; title: string; close: () => void;
}) {
  const node = useSyncExternalStore(watch.subscribe, watch.get);
  // Пока задача в очереди, сервер времени не отдаёт — считаем от открытия окна.
  const [opened] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const progress = node.dutiesProgress;
  const seconds = Math.round(progress?.elapsedSeconds ?? (Date.now() - opened) / 1000);
  const duties = progress?.duties ?? [];
  const partial = progress?.partial ?? "";

  return (
    <Overlay onClose={close}>
      <div className="modal wide" id={DUTIES_PROGRESS_ID} role="dialog" aria-modal="true"
        aria-label={"Выписка обязанностей — " + title}>
        <h3>Обязанности — {title}</h3>
        <div className="content">
          <div className="duties-stage" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>{stageText(node)}…</span>
            <span className="dim">{seconds} с</span>
          </div>
          {duties.length || partial ? (
            <ol className="duties-live">
              {duties.map((duty, i) => <li key={i}>{duty}</li>)}
              {partial ? <li className="typing">{partial}<span className="caret" aria-hidden="true" /></li> : null}
            </ol>
          ) : (
            <p className="muted">Обязанности появятся здесь по мере того, как модель их выписывает.</p>
          )}
          <p className="dim">
            Когда модель закончит, список откроется для сверки. Окно можно скрыть — выписка продолжится,
            а список будет в меню инструкции.
          </p>
        </div>
        <div className="foot">
          <button type="button" className="btn" onClick={close}>Скрыть</button>
        </div>
      </div>
    </Overlay>
  );
}
