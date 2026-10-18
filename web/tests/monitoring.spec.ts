import { expect, go, test } from "./fixtures";

/* Раздел «Мониторинг»: период задаётся собственным календарём с выбором времени. */

const pad = (n: number) => String(n).padStart(2, "0");
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test("период выбирается с точностью до минуты", async ({ app }) => {
  await go(app, "Мониторинг");
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
