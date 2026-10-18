import type { Page } from "@playwright/test";

import { MOCK_PASSWORD } from "../mock/backend";
import { check, choose, expect, go, optionsOf, matrixRow, menu, mockApi, modal, openRule, orderDoc, panel, PROJECT, test, toast } from "./fixtures";

/* Вход, выход и то, что интерфейс показывает каждой роли. Сами права
   проверяет API (api/tests/test_auth.py) — здесь только то, что читатель
   не видит кнопок, которые ему всё равно ответят отказом. */

const userRow = (page: Page, login: string) => page.locator(`#tab-users tr[data-user="${login}"]`);

async function signIn(page: Page, login: string, password = MOCK_PASSWORD) {
  await page.getByLabel("Логин").fill(login);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
}

test.describe("вход", () => {
  test.use({ role: null });

  test("без входа каталог не виден и не запрашивается", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/")) calls.push(new URL(r.url()).pathname); });
    await mockApi(page, null);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Войти" })).toBeVisible();
    await expect(page.locator(".side")).toHaveCount(0);
    expect(calls).toEqual(["/api/auth/me"]);
  });

  test("неверный пароль: общая ошибка, поле пароля очищено", async ({ app }) => {
    await signIn(app, "admin", "wrong");
    await expect(app.getByRole("alert")).toContainText("Неверный логин или пароль");
    await expect(app.getByLabel("Пароль")).toHaveValue("");
    await expect(app.locator(".side")).toHaveCount(0);
  });

  test("вход и выход", async ({ app }) => {
    await signIn(app, "Editor");
    await expect(app.locator(".side .who")).toContainText("Елена Редактор");
    await expect(app.locator(".side .who")).toContainText("editor · редактор");
    await expect(app.getByText("API на связи")).toBeVisible();

    await app.getByRole("button", { name: "Меню пользователя" }).click();
    await app.getByRole("menuitem", { name: "Выйти" }).click();
    await expect(app.getByRole("button", { name: "Войти" })).toBeVisible();
    await expect(app.getByLabel("Пароль")).toHaveValue("");
  });

  test("пароль не попадает в адресную строку и хранилища браузера", async ({ app }) => {
    await signIn(app, "admin");
    await expect(app.getByText("API на связи")).toBeVisible();
    expect(app.url()).not.toContain(MOCK_PASSWORD);
    const stored = await app.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(stored).not.toContain(MOCK_PASSWORD);
  });
});

test("истёкшая сессия возвращает на экран входа", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  await page.goto("/");
  await expect(page.getByText("API на связи")).toBeVisible();

  backend.handle("POST", "/auth/logout");   // сессия закончилась на сервере
  await page.getByRole("button", { name: "Меню пользователя" }).click();
  await page.getByRole("menuitem", { name: "Обновить" }).click();
  await expect(page.getByText("Сессия завершена. Войдите снова.")).toBeVisible();
  await expect(page.locator(".side")).toHaveCount(0);
});

test.describe("читатель", () => {
  test.use({ role: "viewer" });

  test("видит каталог, но не видит изменяющих действий", async ({ app }) => {
    await expect(app.getByRole("tab", { name: "Пользователи" })).toHaveCount(0);
    await expect(app.getByRole("tab", { name: "Мониторинг" })).toHaveCount(0);

    // Граф каталога открыт всем ролям.
    await go(app, "Граф");
    await expect(app.locator("#tab-graph .node")).toHaveCount(14);
    await app.locator('#tab-graph .node[data-node="r:1"] .dot').click();
    await expect(app.locator("#tab-graph aside")).toContainText("действует только в");

    await go(app, "Правила");
    await expect(matrixRow(app, PROJECT)).toBeVisible();
    await expect(app.locator("#tab-rules").getByRole("button", { name: "+ Правило" })).toHaveCount(0);
    await expect(app.locator("#tab-rules .cell-btn").first()).toBeDisabled();

    await openRule(app, PROJECT);
    await expect(panel(app).getByRole("button", { name: "Изменить" })).toHaveCount(0);
    await expect(panel(app).getByRole("button", { name: "Действия" })).toHaveCount(0);
    await expect(panel(app).getByRole("button", { name: "+ Добавить пример" })).toHaveCount(0);
    await expect(panel(app).getByRole("button", { name: "Только выбранные" })).toBeDisabled();

    await go(app, "Приказы");
    await expect(orderDoc(app)).toContainText("О порядке постановки целей");
    for (const name of ["+ Добавить приказ", "+ Добавить пункт", "+ Правило", "Изменить", "Действия"])
      await expect(app.locator("#tab-orders").getByRole("button", { name })).toHaveCount(0);

    await go(app, "Атрибуты");
    await expect(app.locator("#tab-targets").getByRole("button")).toHaveCount(0);
    await go(app, "Подразделения");
    await expect(app.locator("#tab-departments").getByRole("button")).toHaveCount(0);
  });

  test("может проверить цель", async ({ app }) => {
    await app.getByLabel("Формулировка цели").fill("В рамках проекта «Альфа» внедрить мониторинг до 15.09.2025");
    await app.locator("#tab-check").getByRole("button", { name: "Проверить" }).click();
    await expect(app.locator("#checkResult")).toBeVisible();
  });

  test("чинить идентификаторы предлагают администратору", async ({ app }) => {
    await go(app, /Замечания/);
    await expect(app.getByText("Исправить может администратор.")).toBeVisible();
    await expect(app.getByRole("button", { name: "Проставить идентификаторы" })).toHaveCount(0);
  });
});

test.describe("редактор", () => {
  test.use({ role: "editor" });

  test("правит каталог, но не удаляет навсегда", async ({ app }) => {
    await expect(app.getByRole("tab", { name: "Пользователи" })).toHaveCount(0);
    await go(app, "Подразделения");
    const row = app.locator("#tab-departments tr").filter({ has: app.locator(".mono", { hasText: "FIN" }) });
    await row.getByRole("button", { name: "Действия" }).click();
    await expect(app.getByRole("menuitem", { name: "В архив" })).toBeVisible();
    await expect(app.getByRole("menuitem", { name: "Удалить" })).toHaveCount(0);
    await app.getByRole("menuitem", { name: "Изменить", exact: true }).click();
    await modal(app).getByLabel("Название").fill("Финансы");
    await modal(app).getByRole("button", { name: "Сохранить" }).click();
    await expect(toast(app, "Подразделение обновлено")).toBeVisible();
  });
});

test.describe("администратор", () => {
  test("заводит пользователя, меняет роль, блокирует и удаляет", async ({ app }) => {
    await go(app, "Пользователи");
    await expect(userRow(app, "admin")).toContainText("это вы");
    await expect(userRow(app, "admin")).toContainText("задан в настройках сервера");
    await expect(userRow(app, "admin").getByRole("button", { name: "Действия" })).toHaveCount(0);

    await app.getByRole("button", { name: "+ Пользователь" }).click();
    await modal(app).getByLabel("Логин").fill("viewer");
    await modal(app).getByRole("button", { name: "Добавить" }).click();
    await expect(toast(app, "уже есть в реестре")).toBeVisible();
    await modal(app).getByLabel("Логин").fill("I.Ivanov");
    await modal(app).getByLabel("Имя").fill("Иванов Иван");
    await modal(app).getByRole("button", { name: "Добавить" }).click();
    await expect(userRow(app, "i.ivanov")).toContainText("читатель");

    await menu(userRow(app, "i.ivanov"), "Изменить");
    await modal(app).locator("#f_role").click();
    await app.locator(".select-pop").getByRole("option", { name: /Редактор/ }).click();
    await modal(app).getByRole("button", { name: "Сохранить" }).click();
    await expect(userRow(app, "i.ivanov")).toContainText("редактор");

    await menu(userRow(app, "i.ivanov"), "Заблокировать");
    await expect(userRow(app, "i.ivanov")).toContainText("заблокирован");

    await menu(userRow(app, "i.ivanov"), "Удалить");
    await modal(app).getByRole("button", { name: "Удалить" }).click();
    await expect(userRow(app, "i.ivanov")).toHaveCount(0);
  });

  test("заблокированный пользователь войти не может", async ({ page }) => {
    const backend = await mockApi(page, "admin");
    backend.handle("PATCH", "/auth/users/editor", { status: "blocked" });
    backend.handle("POST", "/auth/logout");
    await page.goto("/");
    await signIn(page, "editor");
    await expect(page.getByRole("alert")).toContainText("доступ к интерфейсу не назначен");
  });
});

test.describe("мониторинг", () => {
  test.use({ role: "admin" });

  test("администратор видит нагрузку, показатели за период и историю", async ({ app }) => {
    await check(app, "Улучшить работу с заявками");
    await go(app, "Мониторинг");
    const tab = app.locator("#tab-monitoring");
    await expect(tab.getByText("Запросов у модели")).toBeVisible();
    await expect(tab.getByText("Проверок за интервал")).toBeVisible();
    await expect(tab.locator("#monitoringHistory tbody tr").first()).toContainText("Улучшить работу с заявками");

    // Таблицы листаются, размер страницы меняется.
    await expect(tab.locator("#monitoringHistory tbody tr")).toHaveCount(10);
    await expect(tab.locator("#historyPager")).toContainText("1–10 из");
    await tab.locator("#historyPager").getByRole("button", { name: "Вперёд" }).click();
    await expect(tab.locator("#historyPager")).toContainText("Страница 2 из");
    await choose(tab.locator("#historyPagerSize"), { value: "100" });
    await expect(tab.locator("#monitoringHistory tbody tr")).toHaveCount(100);
    await expect(tab.locator("#historyPager")).toContainText("1–100 из");
    expect(await optionsOf(tab.locator("#historyPagerSize"))).toEqual(["10", "25", "50", "100"]);

    await choose(tab.locator("#monitoringMode"), { value: "single" });
    await tab.getByRole("button", { name: "Показать" }).click();
    await expect(tab.locator("#monitoringHistory tbody tr")).toHaveCount(1);
  });
});
