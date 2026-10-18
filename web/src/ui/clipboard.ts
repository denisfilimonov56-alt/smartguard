/* Копирование в буфер обмена — общее для JSON ответа и нового ключа доступа. */

/** В буфер обмена: через Clipboard API, а где он закрыт (встроенные браузеры, http) — через скрытое поле и execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Запасной путь работает только внутри обработчика клика — отсюда он и вызывается.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
