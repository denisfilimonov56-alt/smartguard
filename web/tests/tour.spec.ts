import type { Page } from "@playwright/test";

import { choose, expect, go, test, tour } from "./fixtures";

/* Обучение по интерфейсу: начинается само при первом входе, ведёт по
   разделам, проверяет пример по-настоящему, ставит отметку на сервере
   и повторяется из меню пользователя. Состав шагов зависит от роли. */

const count = (page: Page) => tour(page).locator(".tour-count");
const next = (page: Page) => tour(page).getByRole("button", { name: /^(Далее|Готово)$/ });
const hint = (page: Page) => page.locator(".tour-hint");

/** Шаг ждёт нажатия на подсвеченный элемент — нажать на него, как пользователь. */
async function pressHinted(page: Page) {
  await expect(hint(page)).toBeVisible();
  await expect(tour(page)).toHaveCount(0);
  await page.locator((await hint(page).getAttribute("data-target"))!).first().click();
}

/** Пройти обучение с шага from до конца (или до шага until), собрав заголовки шагов. */
async function walk(page: Page, from = 1, until?: string) {
  const titles: string[] = [];
  for (let i = from; ; i++) {
    await expect(page.locator(".tour-card, .tour-hint").first()).toBeVisible();
    if (await hint(page).count()) await pressHinted(page);
    await expect(count(page)).toContainText(`${i} из`);
    const title = await tour(page).getByRole("heading").innerText();
    titles.push(title);
    if (title === until) break;
    const button = next(page);
    const last = (await button.innerText()) === "Готово";
    await button.click();
    if (last) break;
  }
  return titles;
}

test.describe("первый вход", () => {
  test.use({ firstLogin: true });

  test("обучение начинается само, проверяет пример и ставит отметку", async ({ app, page }) => {
    const marks: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/auth/me/tour")) marks.push(r.url()); });
    await expect(tour(app)).toContainText("Добро пожаловать");
    await expect(count(app)).toHaveText("Обучение · 1 из 22");
    // Первый шаг держит панель раскрытой и показывает, где обучение запускается снова.
    await expect(app.locator(".side")).toHaveClass(/pinned/);
    await expect(app.locator(".tour-spot")).toBeVisible();
    await expect(tour(app)).toContainText("пункт «Обучение»");

    await next(app).click();
    await expect(tour(app)).toContainText("Разделы");
    // Щелчок мимо карточки не проходит сквозь затемнение: раздел не меняется.
    await expect(app.getByRole("tab", { name: "Приказы" }).click({ timeout: 1000 })).rejects.toThrow(/intercepts pointer events/);
    await expect(app.getByRole("tab", { name: "Приказы" })).toHaveAttribute("aria-selected", "false");

    const titles = await walk(app, 2);
    expect(titles).toEqual([
      "Разделы", "Поиск по каталогу",
      "Проверка цели", "Как читать ответ", "Что проверяется", "Не согласны с ответом?", "Несколько целей сразу",
      "Правила: где какое действует", "Новое правило", "Панель правила", "Приказы", "Подразделения", "Атрибуты",
      "Граф каталога", "Замечания к данным", "Проверка примеров на модели", "Мониторинг", "Пользователи",
      "Настройки", "Ключи доступа", "Готово",
    ]);
    // Пройденное обучение возвращает на главный экран, а форму проверки — такой, какой она была
    // до обучения (пустой): пример и ответ на него в ней не остаются, пакетный режим выключен.
    await expect(tour(app)).toHaveCount(0);
    expect(new URL(app.url()).pathname).toBe("/check");
    await expect(app.getByLabel("Формулировка цели")).toHaveValue("");
    await expect(app.locator("#checkResult")).toHaveCount(0);
    await expect(app.getByRole("button", { name: "Одна цель" })).toHaveAttribute("aria-pressed", "true");
    await expect(app.locator(".rule-panel")).toHaveCount(0);
    expect(marks).toHaveLength(1);

    // После перезагрузки обучение не повторяется: отметка на сервере.
    await app.reload();
    await expect(app.getByText("API на связи")).toBeVisible();
    await expect(tour(app)).toHaveCount(0);
  });
});

test.describe("читатель", () => {
  test.use({ role: "viewer", firstLogin: true });

  test("не видит шагов про правку и администрирование; пропуск ставит отметку, повтор — из меню", async ({ app, page }) => {
    const marks: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/auth/me/tour")) marks.push(r.url()); });
    await expect(count(app)).toHaveText("Обучение · 1 из 16");
    await tour(app).getByRole("button", { name: "Пропустить" }).click();
    await expect(tour(app)).toHaveCount(0);
    await expect.poll(() => marks.length).toBe(1);

    await app.getByRole("button", { name: "Меню пользователя" }).click();
    await app.getByRole("menuitem", { name: "Обучение" }).click();
    const titles = await walk(app);
    expect(titles).not.toContain("Не согласны с ответом?");
    expect(titles).not.toContain("Новое правило");
    expect(titles).not.toContain("Мониторинг");
    expect(titles).toContain("Панель правила");
    expect(titles).toHaveLength(16);
  });
});

test("блок, который открывается нажатием, ждёт нажатия пользователя", async ({ app }) => {
  await app.getByRole("button", { name: "Меню пользователя" }).click();
  await app.getByRole("menuitem", { name: "Обучение" }).click();
  await walk(app, 1, "Новое правило");
  await next(app).click();
  // Подсвечена строка матрицы с подписью; панели нет, карточки нет, и сами по себе они не появятся.
  await expect(hint(app)).toContainText("Нажмите на название правила");
  await expect(app.locator(".tour-click")).toBeVisible();
  await app.waitForTimeout(1500);
  await expect(app.locator(".rule-panel")).toHaveCount(0);
  await expect(tour(app)).toHaveCount(0);
  // Нажатие мимо подсветки не проходит, по подсветке — открывает панель этого правила.
  await expect(app.getByRole("tab", { name: "Приказы" }).click({ timeout: 1000 })).rejects.toThrow(/intercepts pointer events/);
  await app.locator("#tab-rules tbody tr[data-node] td.rule-col").first().click();
  await expect(app.locator(".rule-panel")).toContainText("Цель обязана содержать упоминание проекта");
  await expect(tour(app)).toContainText("Панель правила");
  await expect(hint(app)).toHaveCount(0);
  // Уход с шага назад закрывает панель; предыдущий шаг снова ждёт нажатия,
  // а стрелка вправо нажимает за пользователя — мастер открывается, потом панель.
  await app.keyboard.press("ArrowLeft");
  await expect(app.locator(".rule-panel")).toHaveCount(0);
  await expect(hint(app)).toContainText("Нажмите «+ Правило»");
  await app.keyboard.press("ArrowRight");
  await expect(app.locator("#tab-rules .wizard")).toBeVisible();
  await expect(tour(app)).toContainText("Новое правило");
  await next(app).click();
  await expect(app.locator("#tab-rules .wizard")).toHaveCount(0);
  await expect(hint(app)).toContainText("Нажмите на название правила");
  await app.keyboard.press("ArrowRight");
  await expect(app.locator(".rule-panel")).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(app.locator(".rule-panel")).toHaveCount(0);
});

test("обучение возвращает форму проверки такой, какой она была", async ({ app }) => {
  // Пустая форма: шаг «Проверка цели» подставляет в неё пример.
  await go(app, "Проверка цели");
  await expect(app.getByLabel("Формулировка цели")).toHaveValue("");
  await app.getByRole("button", { name: "Меню пользователя" }).click();
  await app.getByRole("menuitem", { name: "Обучение" }).click();
  await expect(tour(app)).toContainText("Добро пожаловать");
  for (const title of ["Разделы", "Поиск по каталогу", "Проверка цели"]) {
    await app.keyboard.press("ArrowRight");
    await expect(tour(app)).toContainText(title);
  }
  await expect(app.getByLabel("Формулировка цели")).not.toHaveValue("");
  await app.keyboard.press("Escape");
  await expect(tour(app)).toHaveCount(0);
  await expect(app.getByLabel("Формулировка цели")).toHaveValue("");
  await expect(app.locator("#checkResult")).toHaveCount(0);
});

test("пройденное обучение не показывается, Escape закрывает повторное", async ({ app }) => {
  await expect(tour(app)).toHaveCount(0);
  await go(app, "Приказы");
  await app.getByRole("button", { name: "Меню пользователя" }).click();
  await app.getByRole("menuitem", { name: "Обучение" }).click();
  await expect(count(app)).toHaveText("Обучение · 1 из 22");
  await app.keyboard.press("ArrowRight");
  await expect(tour(app)).toContainText("Разделы");
  await app.keyboard.press("ArrowLeft");
  await expect(tour(app)).toContainText("Добро пожаловать");
  await app.keyboard.press("Escape");
  await expect(tour(app)).toHaveCount(0);
  // Прерванное обучение оставляет там, где было.
  expect(new URL(app.url()).pathname).toBe("/orders");
});

test("пакет, закончившийся во время обучения, после обучения на месте", async ({ app }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await app.route("**/api/check-goals", async (route) => { await held; await route.fallback(); });
  await go(app, "Проверка цели");
  await app.locator("#checkMode").getByRole("button", { name: "Несколько целей" }).click();
  await app.getByRole("button", { name: "+ Строка" }).click();
  await app.getByLabel("Цель 1").fill("Снизить долю просроченных заявок до 5% к 31.12.2025");
  await choose(app.getByLabel("Подразделение 1"), "УЦТ");
  await app.locator("#batchRun").click();

  await app.getByRole("button", { name: "Меню пользователя" }).click();
  await app.getByRole("menuitem", { name: "Обучение" }).click();
  await expect(count(app)).toHaveText("Обучение · 1 из 22");
  release();
  // Ответ пакета пришёл, пока шло обучение.
  await expect(app.locator("#batchRun")).toBeEnabled();
  await app.keyboard.press("Escape");
  await expect(tour(app)).toHaveCount(0);
  await expect(app.locator("#batchResult").getByText("Проверено целей: 1")).toBeVisible();
});
