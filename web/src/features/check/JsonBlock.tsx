import { memo, useMemo, useState, type MouseEvent } from "react";

import { copyText } from "../../ui/clipboard";
import { useToast } from "../../ui/Toasts";

/* Ответ API как есть — под вердиктом одиночной и пакетной проверки. Свёрнут
   по умолчанию; кнопка в заголовке копирует JSON, не разворачивая блок.
   Ответ пакета — мегабайты текста: он сериализуется, только когда блок
   раскрыт или JSON копируют, и не на каждую перерисовку страницы. */

export const JsonBlock = memo(function JsonBlock({ id, value }: { id: string; value: unknown }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const text = useMemo(() => (open ? JSON.stringify(value, null, 2) : ""), [open, value]);

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    // Кнопка внутри <summary>: клик по ней не должен сворачивать и разворачивать блок.
    event.preventDefault();
    event.stopPropagation();
    if (await copyText(text || JSON.stringify(value, null, 2))) toast("JSON скопирован", "ok");
    else toast("Не удалось скопировать — разверните блок, выделите текст и скопируйте вручную", "err");
  }

  return (
    <details className="card pad json-block" id={id} style={{ marginTop: 16 }}
      onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span>Ответ API (JSON)</span>
        <button type="button" className="btn sm ghost" onClick={(e) => void copy(e)}>Скопировать JSON</button>
      </summary>
      {open && <pre className="mono json">{text}</pre>}
    </details>
  );
});
