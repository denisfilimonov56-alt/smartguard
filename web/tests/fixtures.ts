import { expect, test as base, type Locator, type Page } from "@playwright/test";

import { createBackend } from "../mock/backend";

/* Каждый тест получает свой фейковый API: перехватываются запросы к /api
   на том же origin — ровно туда интерфейс ходит и в настоящей сборке.
   По умолчанию пользователь уже вошёл администратором; другая роль —
   test.use({ role: "viewer" }), экран входа — test.use({ role: null }).

   В данных фейка: R-1.1 (проект) действует только в УЦТ и АГД;
   приказ ПР-02 заведён без бизнес-ключей. */

export type MockRole = "admin" | "editor" | "viewer" | null;

/** Запрос к API, а не к файлу сборки: /api/… на origin страницы. */
export const isApi = (url: URL) => url.pathname.startsWith("/api/");

/** Подключить к странице фейковый API; логин совпадает с названием роли. */
export async function mockApi(page: Page, role: MockRole) {
  const backend = createBackend({ user: role ?? undefined });
  await page.route(isApi, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const raw = request.postData();
    const reply = backend.handle(request.method(), url.pathname.replace(/^\/api/, "") + url.search,
      raw ? JSON.parse(raw) : undefined);
    if (reply.status === 204) await route.fulfill({ status: 204 });
    else await route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  return backend;
}

export const test = base.extend<{ app: Page; role: MockRole }>({
  role: ["admin", { option: true }],
  app: async ({ page, role }, use) => {
    await mockApi(page, role);
    await page.goto("/");
    if (role) await expect(page.getByText("API на связи")).toBeVisible();
    else await expect(page.getByRole("button", { name: "Войти" })).toBeVisible();
    await use(page);
  },
});

export { expect };

export const PROJECT = "упоминание проекта";
export const DEADLINE = "конкретный срок исполнения";
export const TRAINING = "Обучение само по себе";

/** Перейти в раздел через боковую панель. */
export const go = (page: Page, section: string | RegExp) => page.getByRole("tab", { name: section }).click();

/** Диалоги, формы и окно ячейки живут в одном корне. */
export const modal = (page: Page) => page.locator("#modalRoot");

export const panel = (page: Page) => page.locator(".rule-panel");

export const orderItem = (page: Page, number: string) =>
  page.getByRole("option").filter({ has: page.locator(".n", { hasText: number }) });

/** Открытый в разделе «Приказы» документ приказа. */
export const orderDoc = (page: Page) => page.locator("#tab-orders .orders > [data-node]");

export const clauseBlock = (page: Page, code: string) =>
  page.locator(".clause").filter({ has: page.locator(".num", { hasText: new RegExp(`^${code.replace(".", "\\.")}$`) }) });

export const ruleCard = (page: Page, text: string) => page.locator(".rule-card").filter({ hasText: text });

export const matrixRow = (page: Page, rule: string) => page.locator("#tab-rules tbody tr").filter({ hasText: rule });

/** Ячейка матрицы «правило × подразделение». */
export const cell = (page: Page, rule: string, department: string) =>
  page.locator("#tab-rules").getByRole("button", { name: new RegExp(`${rule}.* — ${department}:`) });

/** Открыть меню «⋯» у объекта и выбрать пункт. */
export async function menu(owner: Locator, item: string) {
  await owner.getByRole("button", { name: "Действия" }).first().click();
  await owner.page().getByRole("menuitem", { name: item, exact: true }).click();
}

/** Открытое меню выпадающего списка (ui/Select.tsx) — оно рендерится в body. */
export const selectMenu = (page: Page) => page.locator(".select-pop");

/** Выбрать значение в выпадающем списке: по подписи или по value. */
export async function choose(trigger: Locator, option: string | { value: string }) {
  await trigger.click();
  const menuList = selectMenu(trigger.page());
  await (typeof option === "string"
    ? menuList.getByRole("option", { name: option, exact: true })
    : menuList.locator(`[data-value="${option.value}"]`)).click();
  await expect(menuList).toHaveCount(0);
}

/** Подписи вариантов выпадающего списка. */
export async function optionsOf(trigger: Locator) {
  await trigger.click();
  const labels = await selectMenu(trigger.page()).getByRole("option").allTextContents();
  await trigger.press("Escape");
  return labels;
}

/** Последнее уведомление с таким текстом: одинаковые могут висеть одновременно. */
export const toast = (page: Page, text: string | RegExp) =>
  page.locator("#toasts .toast").filter({ hasText: text }).last();

/** Открыть панель правила из матрицы. */
export async function openRule(page: Page, rule: string) {
  await go(page, "Правила");
  await matrixRow(page, rule).locator("td.rule-col").click();
  await expect(panel(page)).toBeVisible();
}

/** Проверить цель на главном экране; возвращает карточку результата. */
export async function check(page: Page, goal: string, department: string | null = null) {
  await go(page, "Проверка цели");
  await page.getByLabel("Формулировка цели").fill(goal);
  await choose(page.locator("#departmentInput"), { value: department ?? "" });
  await page.locator("#tab-check").getByRole("button", { name: "Проверить" }).click();
  return page.locator("#checkResult");
}
