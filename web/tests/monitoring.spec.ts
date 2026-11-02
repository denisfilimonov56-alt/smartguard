import { expect, go, test } from "./fixtures";

/* Раздел «Мониторинг»: период задаётся собственным календарём с выбором времени. */

const pad = (n: number) => String(n).padStart(2, "0");
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test("период выбирается с точностью до минуты", async ({ app }) => {
  await go(app, "Мониторинг");
  // Календарь появляется только для своего периода; по умолчанию выбраны 7 дней.
  await expect(app.getByRole("button", { name: "7 дней" })).toHaveAttribute("aria-pressed", "true");
  await app.getByRole("button", { name: "Свой период" }).click();
  const first = new Date(Date.now() - 6 * 86_400_000);
  const from = app.getByRole("button", { name: "Начало периода" });
  await expect(from).toHaveAttribute("data-value", `${key(first)}T00:00`);
  await expect(app.getByRole("button", { name: "Конец периода" })).toHaveAttribute("data-value", `${key(new Date())}T23:59`);

  await from.click();
  const calendar = app.getByRole("dialog", { name: "Начало периода" });
  const start = new Date(first.getFullYear(), first.getMonth(), 1);
  await calendar.locator(`[data-day="${key(start)}"]`).click();
  await calendar.getByLabel("Часы").fill("9");
  await calendar.getByLabel("Минуты").fill("30");
  await calendar.getByRole("button", { name: "Готово" }).click();
  await expect(calendar).toHaveCount(0);
  await expect(from).toHaveAttribute("data-value", `${key(start)}T09:30`);
  await expect(from).toContainText(`${pad(start.getDate())}.${pad(start.getMonth() + 1)}.${start.getFullYear()} 09:30`);

  const request = app.waitForRequest((r) => r.url().includes("/monitoring/stats"));
  await app.getByRole("button", { name: "Показать" }).click();
  const url = new URL((await request).url());
  expect(url.searchParams.get("start")).toBe(new Date(`${key(start)}T09:30`).toISOString());
  const end = new Date(`${key(new Date())}T23:59`);
  end.setMinutes(end.getMinutes() + 1);
  expect(url.searchParams.get("end")).toBe(end.toISOString());
});

test("календарь листается, не пускает за границу периода и закрывается по Escape", async ({ app }) => {
  await go(app, "Мониторинг");
  await app.getByRole("button", { name: "Свой период" }).click();
  await app.getByRole("button", { name: "Конец периода" }).click();
  const calendar = app.getByRole("dialog", { name: "Конец периода" });
  const first = new Date(Date.now() - 6 * 86_400_000);
  const before = new Date(first.getFullYear(), first.getMonth(), first.getDate() - 1);
  // День раньше начала периода концом периода быть не может.
  if (before.getMonth() !== new Date().getMonth())
    await calendar.getByRole("button", { name: "Предыдущий месяц" }).click();
  await expect(calendar.locator(`[data-day="${key(before)}"]`)).toBeDisabled();
  await expect(calendar.locator(`[data-day="${key(first)}"]`)).toBeEnabled();

  const month = await calendar.locator(".dt-month").innerText();
  await calendar.getByRole("button", { name: "Следующий месяц" }).click();
  await expect(calendar.locator(".dt-month")).not.toHaveText(month);

  await app.keyboard.press("Escape");
  await expect(calendar).toHaveCount(0);
  await expect(app.locator("#tab-monitoring")).toBeVisible();
});

test("у раздела свой адрес: прямая ссылка, «Назад» и только открытая страница", async ({ app }) => {
  await go(app, "Мониторинг");
  await expect(app).toHaveURL(/\/monitoring$/);
  await expect(app.locator("#tab-monitoring")).toBeVisible();
  await expect(app.locator("#tab-check")).toHaveCount(0);

  await app.goto("/rules");
  await expect(app.getByRole("tab", { name: "Правила" })).toHaveAttribute("aria-selected", "true");
  await expect(app.locator("#tab-monitoring")).toHaveCount(0);

  await app.goBack();
  await expect(app).toHaveURL(/\/monitoring$/);
  await expect(app.locator("#tab-monitoring")).toBeVisible();
});

test("возврат на вкладку, пока опрос «Сейчас» в пути, не запускает второй опрос", async ({ app }) => {
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await app.route("**/api/monitoring/now", async (route) => {
    calls++;
    if (calls === 1) await held;   // первый ответ задерживается
    await route.fallback();
  });
  await go(app, "Мониторинг");
  await expect.poll(() => calls).toBe(1);
  // Вкладку скрыли и вернули, пока запрос не ответил.
  for (let i = 0; i < 3; i++) await app.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await app.waitForTimeout(500);
  expect(calls).toBe(1);
  release();
  await expect(app.getByText("Запросов у модели")).toBeVisible();
  await app.waitForTimeout(500);
  expect(calls).toBe(1);
});

test("настройки раздела запоминаются в браузере", async ({ app }) => {
  await go(app, "Мониторинг");
  await app.getByRole("button", { name: "30 дней" }).click();
  await app.getByRole("combobox", { name: "Периодичность" }).click();
  await app.getByRole("option", { name: "По часам" }).click();
  await app.getByRole("combobox", { name: "Вид проверок" }).click();
  await app.getByRole("option", { name: "Только пакетные" }).click();
  // Выбор записывается эффектом после отрисовки — перезагружать только после записи.
  await expect.poll(() => app.evaluate(() => JSON.parse(localStorage.getItem("gc.monitoring:admin") ?? "{}")))
    .toMatchObject({ preset: 30, step: "hour", mode: "bulk" });

  // После перезагрузки раздел сразу считает по сохранённым настройкам.
  const request = app.waitForRequest((r) => r.url().includes("/monitoring/stats"));
  await app.reload();
  const url = new URL((await request).url());
  expect(url.searchParams.get("step")).toBe("hour");
  expect(url.searchParams.get("mode")).toBe("bulk");
  await expect(app.getByRole("button", { name: "30 дней" })).toHaveAttribute("aria-pressed", "true");
  await expect(app.getByRole("combobox", { name: "Периодичность" })).toContainText("По часам");
  await expect(app.getByRole("combobox", { name: "Вид проверок" })).toContainText("Только пакетные");
});

test("длинное слово в цели переносится и не растягивает историю", async ({ app }) => {
  const goal = "a".repeat(300);
  await app.route("**/api/monitoring/history*", (route) => route.fulfill({ json: { total: 1, records: [{
    at: new Date().toISOString(), goal, violations: [], department_id: "AGD", login: "key:load-test",
    mode: "single", batch_id: null, status: "VIOLATIONS_FOUND", ms: 17_500, cached: false, queue_ms: 0,
  }] } }));
  await go(app, "Мониторинг");
  const table = app.locator("#monitoringHistory");
  await expect(table).toContainText("aaaa");
  // Таблица помещается в карточку: прокрутки вбок нет.
  const fits = await table.evaluate((t) => t.parentElement!.scrollWidth <= t.parentElement!.clientWidth);
  expect(fits).toBe(true);
});
