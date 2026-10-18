import type { Page } from "@playwright/test";

import { MOCK_PASSWORD } from "../mock/backend";
import { check, choose, expect, go, optionsOf, matrixRow, menu, mockApi, modal, openRule, orderDoc, panel, PROJECT, test, toast } from "./fixtures";

/* Вход через фейковый Keycloak (/api/idp), выход и то, что интерфейс
   показывает каждой роли. Сами права проверяет API (api/tests/test_auth.py) —
   здесь только то, что читатель не видит кнопок, которые ему всё равно
   ответят отказом. */

const userRow = (page: Page, login: string) => page.locator(`#tab-users tr[data-user="${login}"]`);

/** Кнопка «Войти» уводит на страницу Keycloak; там логин и пароль, обратно — с кодом. */
async function signIn(page: Page, login: string, password = MOCK_PASSWORD) {
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page).toHaveURL(/\/api\/idp\/auth\?/);
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
    await expect(page.getByLabel("Пароль")).toHaveCount(0);
    expect(calls).toEqual([]);
  });

  test("Keycloak открывается с PKCE и возвращает на тот же раздел", async ({ page }) => {
    await mockApi(page, null);
    await page.goto("/rules");
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page).toHaveURL(/\/api\/idp\/auth\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:4173/");
    expect(url.searchParams.get("state")).toBeTruthy();

    await page.getByLabel("Логин").fill("admin");
    await page.getByLabel("Пароль").fill(MOCK_PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page.getByText("API на связи")).toBeVisible();
    await expect(page).toHaveURL(/\/rules$/);
    expect(page.url()).not.toContain("code=");
  });

  test("неверный пароль: Keycloak не выпускает, каталог не виден", async ({ app }) => {
    await signIn(app, "admin", "wrong");
    await expect(app.getByRole("alert")).toContainText("Неверный логин или пароль");
    await expect(app).toHaveURL(/\/api\/idp\/auth/);
    await expect(app.locator(".side")).toHaveCount(0);
  });

  test("вход и выход", async ({ app }) => {
    await signIn(app, "Editor");
    await expect(app.locator(".side .who")).toContainText("Елена Редактор");
    await expect(app.locator(".side .who")).toContainText("редактор");
    await expect(app.locator(".side .who")).not.toContainText("editor");
    await expect(app.getByText("API на связи")).toBeVisible();

    await app.getByRole("button", { name: "Меню пользователя" }).click();
    await app.getByRole("menuitem", { name: "Выйти" }).click();
    await app.getByRole("dialog").getByRole("button", { name: "Выйти" }).click();
    await expect(app.getByRole("button", { name: "Войти" })).toBeVisible();
    await expect(app.locator(".side")).toHaveCount(0);
    // Токены забыты: перезагрузка не возвращает в приложение.
    await app.reload();
    await expect(app.getByRole("button", { name: "Войти" })).toBeVisible();
  });

  test("пароль не попадает в адресную строку и хранилища браузера", async ({ app }) => {
    await signIn(app, "admin");
    await expect(app.getByText("API на связи")).toBeVisible();
    expect(app.url()).not.toContain(MOCK_PASSWORD);
    const stored = await app.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(stored).not.toContain(MOCK_PASSWORD);
    expect(stored).toContain("mock:admin");
  });

  test("вошедший в Keycloak без роли видит отказ, а не экран входа", async ({ app }) => {
    await signIn(app, "stranger");
    await expect(app.getByRole("alert")).toContainText("Доступ к интерфейсу не назначен");
    await expect(app.locator(".side")).toHaveCount(0);
    await app.getByRole("button", { name: "Войти другой учётной записью" }).click();
    await expect(app.getByRole("button", { name: "Войти" })).toBeVisible();
  });
});

test("закрытая в Keycloak сессия: окно входа поверх приложения, ввод переживает повторный вход", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  await page.goto("/");
  await expect(page.getByText("API на связи")).toBeVisible();
  const goal = "Черновик цели, набранный до конца сессии";
  await page.getByLabel("Формулировка цели").fill(goal);

  backend.revoke();   // сессия закончилась на стороне Keycloak
  await page.getByRole("button", { name: "Меню пользователя" }).click();
  await page.getByRole("menuitem", { name: "Обновить" }).click();
  const lost = page.getByRole("alertdialog", { name: "Сессия завершена" });
  await expect(lost).toBeVisible();
  // Приложение не размонтировано: раздел и ввод на месте.
  await expect(page.locator(".side")).toBeVisible();
  await expect(page.getByLabel("Формулировка цели")).toHaveValue(goal);

  // «Не сейчас» оставляет на странице: вместо окна — плашка; фоновые запросы окно не поднимают.
  await lost.getByRole("button", { name: "Не сейчас" }).click();
  await expect(lost).toHaveCount(0);
  const bar = page.locator(".session-bar");
  await expect(bar).toContainText("Сессия завершена");

  await page.getByRole("button", { name: "Меню пользователя" }).click();
  await page.getByRole("menuitem", { name: "Обновить" }).click();
  await expect(toast(page, "Не удалось получить данные")).toBeVisible();
  await expect(lost).toHaveCount(0);
  await expect(bar).toBeVisible();

  // Окно открывает сам пользователь — кнопкой на плашке.
  await bar.getByRole("button", { name: "Войти" }).click();
  await lost.getByRole("button", { name: "Войти снова" }).click();
  await relogin(page);
  await expect(page.getByLabel("Формулировка цели")).toHaveValue(goal);
  await expect(toast(page, "Несохранённый ввод восстановлен")).toBeVisible();
});

/** Страница входа фейкового Keycloak после «Войти снова». */
async function relogin(page: Page) {
  await expect(page).toHaveURL(/\/api\/idp\/auth\?/);
  await page.getByLabel("Логин").fill("admin");
  await page.getByLabel("Пароль").fill(MOCK_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText("API на связи")).toBeVisible();
}

test("после «Не сейчас» отказ на действие пользователя (запись) снова открывает окно", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  await page.goto("/");
  await expect(page.getByText("API на связи")).toBeVisible();
  backend.revoke();
  await page.getByRole("button", { name: "Меню пользователя" }).click();
  await page.getByRole("menuitem", { name: "Обновить" }).click();
  const lost = page.getByRole("alertdialog", { name: "Сессия завершена" });
  await lost.getByRole("button", { name: "Не сейчас" }).click();
  await expect(page.locator(".session-bar")).toBeVisible();

  await page.getByLabel("Формулировка цели").fill("Улучшить работу с заявками");
  await page.locator("#tab-check").getByRole("button", { name: "Проверить" }).click();
  await expect(lost).toBeVisible();
});

test("черновики окна свойств и советчика переживают повторный вход", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  await page.goto("/");
  await expect(page.getByText("API на связи")).toBeVisible();

  // Окно свойств узла: правка значения, сессия кончилась на сохранении.
  await go(page, "Приказы");
  await menu(orderDoc(page), "Свойства");
  await modal(page).getByRole("button", { name: "+ Свойство" }).click();
  const row = modal(page).locator(".prop-row").last();
  await row.getByLabel("Имя свойства").fill("note");
  await row.getByLabel("Значение свойства").fill("введено до конца сессии");
  backend.revoke();
  await modal(page).getByRole("button", { name: "Сохранить" }).dispatchEvent("click");
  const lost = page.getByRole("alertdialog", { name: "Сессия завершена" });
  await lost.getByRole("button", { name: "Войти снова" }).click();
  await relogin(page);
  const props = modal(page).getByRole("dialog", { name: /Свойства узла/ });
  await expect(props).toBeVisible();
  await expect(props.locator(".prop-row").last().getByLabel("Значение свойства")).toHaveValue("введено до конца сессии");
  await props.getByRole("button", { name: "Сохранить" }).click();
  await expect(toast(page, "Свойства сохранены")).toBeVisible();

  // Советчик: набранное обоснование.
  const result = await check(page, "Снизить долю просроченных заявок до 5% к 31.12.2025");
  await result.locator(".violation").getByRole("button", { name: "Не согласен" }).click();
  const advice = modal(page).getByRole("dialog", { name: "Правка графа под ожидаемый ответ" });
  await advice.getByLabel("Обоснование").fill("обоснование до конца сессии");
  backend.revoke();
  // Фоновый запрос мог уже получить отказ и поднять окно поверх советчика: нажатие — событием.
  await advice.getByRole("button", { name: "Предложить правку" }).dispatchEvent("click");
  await lost.getByRole("button", { name: "Войти снова" }).click();
  await relogin(page);
  await expect(advice).toBeVisible();
  await expect(advice.getByLabel("Обоснование")).toHaveValue("обоснование до конца сессии");
  await expect(advice.locator("#adviceAttribute")).toContainText("проект");
});

test("сбои API посреди работы: 503 не выкидывает из сессии, оборванный ответ — ошибка, а не пустые данные", async ({ page }) => {
  await mockApi(page, "admin");
  await page.goto("/");
  await expect(page.getByText("API на связи")).toBeVisible();
  const refresh = async () => {
    await page.getByRole("button", { name: "Меню пользователя" }).click();
    await page.getByRole("menuitem", { name: "Обновить" }).click();
  };

  // Ротация ключей подписи: API отвечает 503, пока не прочитал новый ключ.
  let unavailable = true;
  await page.route("**/api/catalog/tree*", (route) => unavailable
    ? route.fulfill({ status: 503, contentType: "application/json", headers: { "Retry-After": "1" },
      body: JSON.stringify({ detail: "Ключ подписи ещё не прочитан" }) })
    : route.fallback());
  await refresh();
  await expect(toast(page, "Ключ подписи ещё не прочитан")).toBeVisible();
  await expect(page.getByRole("alertdialog", { name: "Сессия завершена" })).toHaveCount(0);
  await expect(page.locator(".session-bar")).toHaveCount(0);
  // Повтор проходит, токены на месте.
  unavailable = false;
  await refresh();
  await expect(page.getByText("API на связи")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("gc.oidc"))).toContain("mock:admin");

  // Ответ 200, оборванный посередине.
  await page.unroute("**/api/catalog/tree*");
  await page.route("**/api/catalog/tree*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"orders": [{"nodeId": "o:1", ' }));
  await refresh();
  await expect(toast(page, "API вернул неразборчивый ответ")).toBeVisible();
  await expect(page.locator(".crash")).toHaveCount(0);
});

test("черновик другого пользователя после входа не показывается", async ({ page }) => {
  await mockApi(page, null);
  await page.addInitScript(() => sessionStorage.setItem("gc.drafts", JSON.stringify({
    owner: "editor", savedAt: Date.now(), items: { check: { mode: "single", goal: "чужой черновик", departmentId: "", isStudent: false, rows: [] } },
  })));
  await page.goto("/");
  await signIn(page, "admin");
  await expect(page.getByText("API на связи")).toBeVisible();
  await expect(page.getByLabel("Формулировка цели")).toHaveValue("");
});

test("ошибка из адресной строки без начатого входа не показывается", async ({ page }) => {
  await mockApi(page, null);
  await page.goto("/rules?error=access_denied&error_description=" + encodeURIComponent("Позвоните по номеру") + "&state=чужой");
  await expect(page.getByRole("button", { name: "Войти" })).toBeVisible();
  await expect(page.getByText("Позвоните по номеру")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page).toHaveURL(/\/rules$/);
});

test("Keycloak недоступен при обновлении токена: токены не стираются, вход не теряется", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  await page.addInitScript(() => {
    const raw = sessionStorage.getItem("gc.oidc");
    if (raw) sessionStorage.setItem("gc.oidc", JSON.stringify({ ...JSON.parse(raw), expiresAt: Date.now() - 1 }));
  });
  await page.route("**/api/idp/token", (route) => route.abort("connectionrefused"));
  await page.goto("/");
  await expect(page.getByText("Сервис входа недоступен").first()).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("gc.oidc"))).toContain("mock-refresh:admin");

  // Keycloak вернулся: «Повторить» входит с теми же токенами, без страницы входа.
  await page.unroute("**/api/idp/token");
  await page.getByRole("button", { name: "Повторить" }).click();
  await expect(page.getByText("API на связи")).toBeVisible();
  expect(backend.handle("GET", "/auth/me", undefined, { authorization: "Bearer mock:admin" }).status).toBe(200);
});

test("Keycloak ответил 429 при обновлении токена: это не «сессия закрыта», токены не стираются", async ({ page }) => {
  await mockApi(page, "admin");
  await page.addInitScript(() => {
    const raw = sessionStorage.getItem("gc.oidc");
    if (raw) sessionStorage.setItem("gc.oidc", JSON.stringify({ ...JSON.parse(raw), expiresAt: Date.now() - 1 }));
  });
  let limited = true;
  await page.route("**/api/idp/token", (route) => limited
    ? route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "too_many_requests" }) })
    : route.fallback());
  await page.goto("/");
  await expect(page.getByText("Сервис входа недоступен").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("gc.oidc"))).toContain("mock-refresh:admin");

  limited = false;
  await page.getByRole("button", { name: "Повторить" }).click();
  await expect(page.getByText("API на связи")).toBeVisible();
});

test("истёкший токен обновляется незаметно", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  const refreshes: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/idp/token")) refreshes.push(r.postData() ?? ""); });
  await page.addInitScript(() => {
    const raw = sessionStorage.getItem("gc.oidc");
    if (raw) sessionStorage.setItem("gc.oidc", JSON.stringify({ ...JSON.parse(raw), expiresAt: Date.now() - 1 }));
  });
  await page.goto("/");
  await expect(page.getByText("API на связи")).toBeVisible();
  expect(refreshes.length).toBeGreaterThanOrEqual(1);
  expect(refreshes[0]).toContain("grant_type=refresh_token");
  expect(backend.handle("GET", "/auth/me", undefined, { authorization: "Bearer mock:admin" }).status).toBe(200);
});

test.describe("читатель", () => {
  test.use({ role: "viewer" });

  test("видит каталог, но не видит изменяющих действий", async ({ app }) => {
    await expect(app.getByRole("tab", { name: "Пользователи" })).toHaveCount(0);
    await expect(app.getByRole("tab", { name: "Мониторинг" })).toHaveCount(0);

    // Граф каталога открыт всем ролям.
    await go(app, "Граф");
    await expect(app.locator("#tab-graph .node")).toHaveCount(17);
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

  test("заблокированный пользователь в интерфейс не попадает", async ({ page }) => {
    const backend = await mockApi(page, null);
    backend.handle("PATCH", "/auth/users/editor", { status: "blocked" }, { authorization: "Bearer mock:admin" });
    await page.goto("/");
    await signIn(page, "editor");
    await expect(page.getByRole("alert")).toContainText("Доступ к интерфейсу не назначен");
    await expect(page.locator(".side")).toHaveCount(0);
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
