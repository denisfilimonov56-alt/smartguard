/* Тема интерфейса: светлая или тёмная. Выбор хранится в localStorage и
   применяется атрибутом data-theme на <html> — токены цветов в styles.css
   переопределяются под ним. Пока пользователь не выбирал, берётся тема
   системы. Применяется до первого рендера (main.tsx), чтобы экран входа
   не мигал светлым. */

export type Theme = "light" | "dark";
const KEY = "theme";

export function readTheme(): Theme {
  return savedTheme() ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch { /* приватный режим: тема живёт до перезагрузки */ }
  applyTheme(theme);
}

applyTheme(readTheme());

/* Пока пользователь не выбирал тему, она следует за системой и при смене
   системной темы на ходу (вечером ОС переключилась на тёмную). */
function savedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" ? saved : null;
  } catch {
    return null;
  }
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (!savedTheme()) applyTheme(e.matches ? "dark" : "light");
});
