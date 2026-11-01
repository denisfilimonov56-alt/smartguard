import { expect, test } from "@playwright/test";

import { createBackend } from "../mock/backend";

/* Фейковый API отвечает так же, как настоящий, — иначе e2e-тесты пропускают
   поведение прода. Здесь без браузера: запросы идут прямо в mock/backend.ts,
   с заголовками, как их шлёт интерфейс. */

const as = (login: string) => ({ authorization: "Bearer mock:" + login, "x-requested-with": "XMLHttpRequest" });

test("запрос из браузера без токена — 401, изменяющий без X-Requested-With — 403", () => {
  const backend = createBackend({ user: "admin" });
  expect(backend.handle("GET", "/catalog/tree", undefined, { accept: "application/json" }).status).toBe(401);
  expect(backend.handle("POST", "/catalog/orders", { number: "1", title: "t" }, { accept: "application/json" }).status)
    .toBe(403);
  // Вызовы из самих тестов без заголовков идут от имени options.user.
  expect(backend.handle("GET", "/catalog/tree").status).toBe(200);
});

test("/auth/me отдаёт пределы API", () => {
  const reply = createBackend().handle("GET", "/auth/me", undefined, as("viewer"));
  expect(reply.body).toMatchObject({ login: "viewer", limits: { maxGoalsPerRequest: 200, goalMaxChars: 4000 } });
});

test("одиночная проверка без подразделения — 422, как в API; число — строкой", () => {
  const backend = createBackend();
  expect(backend.handle("POST", "/check-goal", { goal: "Цель" }, as("viewer")).status).toBe(422);
  expect(backend.handle("POST", "/check-goal", { goal: "Цель", department_id: "  " }, as("viewer")).status).toBe(422);
  expect(backend.handle("POST", "/check-goal", { goal: "Цель", department_id: null }, as("viewer")).status).toBe(422);
  expect(backend.handle("POST", "/check-goal", { goal: "Цель", department_id: " UCT " }, as("viewer")).status).toBe(200);
});

test("цель: пустая и длиннее 4000 символов — 422, числовые id — строкой", () => {
  const backend = createBackend();
  expect(backend.handle("POST", "/check-goal", { goal: "   ", department_id: "UCT" }, as("viewer")).status).toBe(422);
  expect(backend.handle("POST", "/check-goal", { goal: "я".repeat(4001), department_id: "UCT" }, as("viewer")).status).toBe(422);
  expect(backend.handle("POST", "/check-goals", [{ goal: "", department_id: "UCT" }], as("viewer")).status).toBe(422);

  const reply = backend.handle("POST", "/check-goals",
    [{ goal: "  Цель без срока  ", department_id: 42, id: 7, is_student: "yes" }], as("viewer"));
  expect(reply.status).toBe(200);
  const [result] = (reply.body as { results: { id: string; goal: string; is_student: boolean }[] }).results;
  expect(result).toMatchObject({ id: "7", goal: "Цель без срока", is_student: true });
  expect(backend.handle("POST", "/check-goals", [{ goal: "x", department_id: "UCT", is_student: "maybe" }],
    as("viewer")).status).toBe(422);
});

test("предел длины цели — настройка goalMaxChars: /auth/me и 422 сразу после правки", () => {
  const backend = createBackend();
  expect(backend.handle("PUT", "/settings", { goalMaxChars: 99 }, as("admin")).status).toBe(422);
  expect(backend.handle("PUT", "/settings", { goalMaxChars: 100 }, as("admin")).status).toBe(200);
  expect(backend.handle("GET", "/auth/me", undefined, as("viewer")).body).toMatchObject({ limits: { goalMaxChars: 100 } });
  expect(backend.handle("POST", "/check-goal", { goal: "я".repeat(100), department_id: "UCT" }, as("viewer")).status).toBe(200);
  expect(backend.handle("POST", "/check-goal", { goal: "я".repeat(101), department_id: "UCT" }, as("viewer")).status).toBe(422);
  expect(backend.handle("POST", "/check-goals", [{ goal: "я".repeat(101), department_id: "UCT" }], as("viewer")).status)
    .toBe(422);
});

test("нарушение несёт nodeId правила", () => {
  const reply = createBackend().handle("POST", "/check-goal", { goal: "Сделать отчёт", department_id: "UCT" }, as("viewer"));
  const violations = (reply.body as { violations: { rule_id: string; rule_node_id: string }[] }).violations;
  expect(violations.find((v) => v.rule_id === "R-1.1")?.rule_node_id).toBe("r:1");
});

test("режим обслуживания: 503 всем, кроме администратора", () => {
  const backend = createBackend();
  expect(backend.handle("PUT", "/settings", { maintenance: true }, as("admin")).status).toBe(200);
  expect(backend.handle("GET", "/catalog/tree", undefined, as("editor")).status).toBe(503);
  expect(backend.handle("GET", "/auth/me", undefined, as("editor")).status).toBe(200);
  expect(backend.handle("GET", "/catalog/tree", undefined, as("admin")).status).toBe(200);
});

test("правило с неизвестным атрибутом или подразделением не создаётся; only задаётся сразу", () => {
  const backend = createBackend();
  const rule = (extra: object) => backend.handle("POST", "/catalog/rules",
    { clauseNodeId: "c:1", type: "REQUIREMENT", description: "Новое", checkInstruction: "", ...extra }, as("editor"));
  const before = JSON.stringify(backend.handle("GET", "/catalog/tree", undefined, as("editor")).body);
  expect(rule({ targets: ["нет_такого"] }).status).toBe(404);
  expect(rule({ targets: ["проект"], only: ["NOPE"] }).status).toBe(404);
  expect(rule({ targets: ["проект"], only: ["UCT", "UCT"] }).status).toBe(409);
  expect(JSON.stringify(backend.handle("GET", "/catalog/tree", undefined, as("editor")).body)).toBe(before);

  const created = rule({ targets: ["проект"], only: ["FIN"] });
  expect(created.status).toBe(201);
  const departments = backend.handle("GET", "/catalog/departments", undefined, as("editor")).body as
    { departments: { departmentId: string; onlyRules: string[] }[] };
  expect(departments.departments.find((d) => d.departmentId === "FIN")?.onlyRules).toHaveLength(1);
});

test("статус и перенос: 422 на неизвестный статус, 409 на архивного родителя", () => {
  const backend = createBackend();
  expect(backend.handle("POST", "/catalog/nodes/r:1/status", { status: "deleted" }, as("editor")).status).toBe(422);
  expect(backend.handle("POST", "/catalog/nodes/c:2/status", { status: "archived" }, as("editor")).status).toBe(200);
  expect(backend.handle("POST", "/catalog/rules/r:1/move", { parentNodeId: "c:2" }, as("editor")).status).toBe(409);
  expect(backend.handle("PUT", "/catalog/clauses/c:1/references", { references: ["c:1"] }, as("editor")).status)
    .toBe(409);
});

test("обязанности выписываются в фоне: 202 и pending, затем ready", () => {
  const backend = createBackend();
  const created = backend.handle("POST", "/catalog/job-descriptions",
    { departmentNodeId: "d:1", title: "Аналитик", text: "готовить отчёт;\nвести реестр" }, as("editor"));
  expect(created.status).toBe(202);
  const node = created.body as { nodeId: string; dutiesStatus: string };
  expect(node.dutiesStatus).toBe("pending");
  expect(backend.handle("POST", `/catalog/job-descriptions/${node.nodeId}/extract-duties`, undefined, as("editor")).status)
    .toBe(409);

  const polled = backend.handle("GET", `/catalog/job-descriptions/${node.nodeId}`, undefined, as("editor"));
  expect(polled.body).toMatchObject({ dutiesStatus: "ready", dutiesError: null, duties: ["готовить отчёт", "вести реестр"] });

  const counts = backend.handle("GET", "/catalog/nodes/d:1/descendants", undefined, as("editor"));
  expect(counts.body).toMatchObject({ jobDescriptions: 1 });
});

test("зависшая выписка: GET отдаёт error «Выписка прервана», POST перезапускает (202), а не 409", () => {
  const backend = createBackend();
  const created = backend.handle("POST", "/catalog/job-descriptions",
    { departmentNodeId: "d:1", title: "Аналитик", text: "готовить отчёт" }, as("editor"));
  const { nodeId } = created.body as { nodeId: string };
  backend.stallDuties(nodeId);
  expect(backend.handle("POST", `/catalog/job-descriptions/${nodeId}/extract-duties`, undefined, as("editor")).status)
    .toBe(202);
  expect(backend.handle("GET", `/catalog/job-descriptions/${nodeId}`, undefined, as("editor")).body)
    .toMatchObject({ dutiesStatus: "ready" });

  backend.stallDuties(nodeId);
  expect(backend.handle("GET", `/catalog/job-descriptions/${nodeId}`, undefined, as("editor")).body)
    .toMatchObject({ dutiesStatus: "error", dutiesError: expect.stringContaining("Выписка прервана") });
});

test("починка идентификаторов перечисляет то, что задаётся вручную; сведение двойников — пропущенные группы", () => {
  const backend = createBackend();
  const repair = backend.handle("POST", "/catalog/repair-identifiers", undefined, as("admin")).body;
  expect(repair).toMatchObject({ jobDescriptions: expect.any(Number), unnamedTargets: expect.any(Array),
    departmentsWithoutId: expect.any(Array) });
  expect(backend.handle("POST", "/catalog/merge-duplicate-targets", undefined, as("admin")).body)
    .toEqual({ merged: [], skipped: [] });
});

test("коды диагностики как у API, ошибки — в problems", () => {
  const body = createBackend().handle("GET", "/catalog/diagnostics", undefined, as("viewer")).body as
    { issues: { code: string }[]; problems: string[] };
  expect(body.issues.map((i) => i.code)).toContain("targets_without_description");
  expect(body.problems.some((p) => p.startsWith("Атрибуты без описания"))).toBe(true);
});

test("expected: прежние значения и наборы связей — 409 при расхождении, ничего не записано", () => {
  const backend = createBackend();
  const patch = (body: object) => backend.handle("PATCH", "/catalog/nodes/r:2/properties", body, as("editor"));
  expect(patch({ properties: { checkInstruction: "x" }, expected: { checkInstruction: "не то" } }).status).toBe(409);
  const stale = patch({ properties: { description: "x" }, expected: { description: "не то", nope: 1 } });
  expect((stale.body as { detail: string }).detail)
    .toBe("Узел изменён другим пользователем — обновите страницу и повторите правку. Изменились: description, nope");
  expect(patch({ properties: { nope: "x" }, expected: { nope: null } }).status).toBe(200);
  expect(patch({ properties: { description: 5 } }).status).toBe(422);
  expect(patch({ properties: { description: "я".repeat(4001) } }).status).toBe(422);

  const put = (path: string, body: object) => backend.handle("PUT", path, body, as("editor"));
  expect(put("/catalog/rules/r:1/departments", { only: ["UCT"], expected: [] }).status).toBe(409);
  expect(put("/catalog/rules/r:1/departments", { only: ["UCT"], expected: ["AGD", "UCT"] }).status).toBe(200);
  expect(put("/catalog/rules/r:1/targets", { targets: ["проект"], expected: ["срок_исполнения"] }).status).toBe(409);
  expect(put("/catalog/clauses/c:2/references", { references: [], expected: [] }).status).toBe(409);
  expect(put("/catalog/clauses/c:2/references", { references: [], expected: ["c:1"] }).status).toBe(200);
});

test("инструкция и обязанности: expected — прежние значения, при расхождении 409 и ничего не записано", () => {
  const backend = createBackend();
  const created = backend.handle("POST", "/catalog/job-descriptions",
    { departmentNodeId: "d:1", title: "Аналитик", text: "готовить отчёт;\nвести реестр" }, as("editor"));
  const { nodeId } = created.body as { nodeId: string };
  backend.handle("GET", `/catalog/job-descriptions/${nodeId}`, undefined, as("editor"));
  const put = (path: string, body: object) => backend.handle("PUT", `/catalog/job-descriptions/${nodeId}${path}`, body, as("editor"));
  const node = () => backend.handle("GET", `/catalog/nodes/${nodeId}`, undefined, as("editor")).body as Record<string, unknown>;

  const stale = put("", { title: "Новое", text: "другое", expected: { title: "Старое", text: "готовить отчёт;\nвести реестр" } });
  expect(stale.status).toBe(409);
  expect((stale.body as { detail: string }).detail).toMatch(/^Узел изменён другим пользователем.*Изменились: title$/);
  expect(node()).toMatchObject({ title: "Аналитик", text: "готовить отчёт;\nвести реестр" });
  expect(put("", { title: "Новое", text: "готовить отчёт;\nвести реестр",
    expected: { title: "Аналитик", text: "готовить отчёт;\nвести реестр" } }).status).toBe(200);
  expect(put("", { title: "Без сверки", text: "готовить отчёт;\nвести реестр" }).status).toBe(200);

  const staleDuties = put("/duties", { duties: ["x"], expected: ["готовить отчёт"] });
  expect(staleDuties.status).toBe(409);
  expect((staleDuties.body as { detail: string }).detail).toMatch(/^Узел изменён другим пользователем/);
  expect(node().duties).toEqual(["готовить отчёт", "вести реестр"]);
  expect(put("/duties", { duties: ["x"], expected: ["готовить отчёт", "вести реестр"] }).status).toBe(200);
  expect(put("/duties", { duties: ["y"] }).status).toBe(200);
  expect(node().duties).toEqual(["y"]);
});

test("лимит проверок в минуту: скользящее окно, 429 с Retry-After, крупный запрос проходит при пустом окне", () => {
  const backend = createBackend();
  expect(backend.handle("PUT", "/settings", { checkRatePerMinute: 2 }, as("admin")).status).toBe(200);
  const goals = (n: number) => Array.from({ length: n }, () => ({ goal: "Цель", department_id: "UCT" }));
  expect(backend.handle("POST", "/check-goals", goals(5), as("viewer")).status).toBe(200);
  const refused = backend.handle("POST", "/check-goal", { goal: "Цель", department_id: "UCT" }, as("viewer"));
  expect(refused.status).toBe(429);
  expect(Number(refused.headers?.["Retry-After"])).toBeGreaterThan(0);
  // У другого пользователя своё окно.
  expect(backend.handle("POST", "/check-goal", { goal: "Цель", department_id: "UCT" }, as("editor")).status).toBe(200);
  backend.advanceClock(61);
  expect(backend.handle("POST", "/check-goal", { goal: "Цель", department_id: "UCT" }, as("viewer")).status).toBe(200);
});
