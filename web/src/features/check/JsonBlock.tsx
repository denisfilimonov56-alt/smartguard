import { useMemo } from "react";

import { Overlay } from "../../ui/Dialogs";

/* Ответ API целиком — по пункту меню «⋯» в шапке ответа одиночной и пакетной
   проверки: он нужен разработчикам, а не тем, кто проверяет цели, и не должен
   стоять в конце страницы. Ответ пакета — мегабайты текста: сериализуется,
   только когда окно открыто. */

export function JsonDialog({ id, value, close }: { id: string; value: unknown; close: () => void }) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  return (
    <Overlay onClose={close}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="Ответ API (JSON)" id={id}>
        <h3>Ответ API (JSON)</h3>
        <div className="content"><pre className="mono json">{text}</pre></div>
        <div className="foot"><button type="button" className="btn" onClick={close}>Закрыть</button></div>
      </div>
    </Overlay>
  );
}
