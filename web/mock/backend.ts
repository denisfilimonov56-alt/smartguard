/* Фейковый API в памяти: для `npm run dev:mock` и для e2e-тестов.

   Повторяет ровно то поведение настоящего API, на которое опирается
   интерфейс: форма ответов, 401/403/404/409, вход и роли, каскадное
   удаление, запрет удалять используемый атрибут, защита от двойников по
   написанию. Это не замена тестам API — те живут в api/tests и проверяют
   настоящий код.

   Учётки фейка: admin, editor, viewer — пароль у всех MOCK_PASSWORD.
   Сессия одна на весь экземпляр: фейк не различает браузеры. */

type Props = Record<string, unknown>;
type Role = "viewer" | "editor" | "admin";

export const MOCK_PASSWORD = "demo";
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
const ROLE_NAMES: Record<Role, string> = { viewer: "читатель", editor: "редактор", admin: "администратор" };
const LOGIN_FAILED = "Неверный логин или пароль, либо доступ к интерфейсу не назначен";

interface MockUser {
  login: string;
  role: Role;
  status: "active" | "blocked";
  displayName: string | null;
  builtin: boolean;
  createdAt: string | null;
  createdBy: string | null;
  lastLoginAt: string | null;
}
type Label = "Order" | "Clause" | "Rule" | "ViolationExample" | "CheckTarget" | "Department" | "JobDescription";

interface Node {
  id: string;
  label: Label;
  props: Props;
  parent?: string;          // CONTAINS / DEFINES / HAS_EXAMPLE / HAS_JOB_DESCRIPTION
}

export interface Reply {
  status: number;
  body: unknown;
}

const BUSINESS_KEYS: Partial<Record<Label, string>> = {
  Order: "orderId", Clause: "clauseId", Rule: "ruleId", ViolationExample: "exampleId", CheckTarget: "name",
  Department: "departmentId", JobDescription: "jobDescriptionId",
};

export const normalizeName = (name: string) =>
  String(name).replace(/ /g, " ").trim().toLowerCase().replace(/ё/g, "е")
    .replace(/[\s-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Начальные данные. Приказ ПР-02 заведён без бизнес-ключей — на такой
    конфигурации карточка приказа когда-то не раскрывалась. */
function seed() {
  const nodes: Node[] = [];
  const add = (id: string, label: Label, props: Props, parent?: string) =>
    nodes.push({ id, label, props, parent });

  add("t:1", "CheckTarget", { name: "проект", status: "active",
    description: "в цели явно назван проект, программа или инициатива, в рамках которой ведётся работа" });
  add("t:2", "CheckTarget", { name: "срок_исполнения", status: "active",
    description: "в цели указан проверяемый срок: конкретная дата, месяц, квартал или год" });
  add("t:3", "CheckTarget", { name: "обучение", status: "active", description: "" });

  add("o:1", "Order", { orderId: "PR-01", number: "ПР-01", title: "О порядке постановки целей",
    date: "2024-01-15", status: "active" });
  add("c:1", "Clause", { clauseId: "PR-01/1.1", code: "1.1", status: "active",
    text: "В цели должно быть упоминание проекта, в рамках которого производится работа" }, "o:1");
  add("r:1", "Rule", { ruleId: "R-1.1", type: "REQUIREMENT", status: "active",
    description: "Цель обязана содержать упоминание проекта",
    checkInstruction: "Проверь, указан ли в тексте цели проект." }, "c:1");
  add("e:1", "ViolationExample", { exampleId: "R-1.1-EX1", isViolation: false, status: "active",
    text: "В рамках проекта «Альфа» разработать API для интеграции до 01.06.2025" }, "r:1");
  add("e:2", "ViolationExample", { exampleId: "R-1.1-EX2", isViolation: true, status: "active",
    text: "Реализовать требования по автоматизации процесса в системе 1С:KPI" }, "r:1");
  add("c:2", "Clause", { clauseId: "PR-01/2.4", code: "2.4", status: "active",
    text: "Цель должна иметь конкретные сроки исполнения" }, "o:1");
  add("r:2", "Rule", { ruleId: "R-2.4", type: "REQUIREMENT", status: "active",
    description: "Цель обязана содержать конкретный срок исполнения",
    checkInstruction: "Формулировки 'в ближайшее время', 'по возможности' — нарушение." }, "c:2");
  add("e:3", "ViolationExample", { exampleId: "R-2.4-EX1", isViolation: false, status: "active",
    text: "Внедрить систему мониторинга в проекте «Бета» до 15.09.2025" }, "r:2");

  add("o:2", "Order", { number: "ПР-02", title: "Об обучении персонала" });
  add("c:3", "Clause", { code: "3.1", text: "Цель не должна сводиться к прохождению обучения" }, "o:2");
  add("r:3", "Rule", { type: "PROHIBITION", description: "Обучение само по себе целью не является" }, "c:3");

  add("d:1", "Department", { departmentId: "UCT", name: "УЦТ", status: "active" });
  add("d:2", "Department", { departmentId: "AGD", name: "АГД", status: "active" });
  add("d:3", "Department", { departmentId: "FIN", name: "Финансовое управление", status: "active" });

  const appliesTo: [string, string][] = [["r:1", "t:1"], ["r:2", "t:2"], ["r:3", "t:3"]];
  const references: [string, string][] = [["c:2", "c:1"]];
  // Проект обязателен только в УЦТ и АГД.
  const onlyIn: [string, string][] = [["r:1", "d:1"], ["r:1", "d:2"]];
  return { nodes, appliesTo, references, onlyIn };
}

export function createBackend(options: { user?: string } = {}) {
  const data = seed();
  const mockUser = (login: string, role: Role, displayName: string | null, builtin = false): MockUser =>
    ({ login, role, status: "active", displayName, builtin, createdAt: builtin ? null : "2025-01-10T09:00:00+00:00",
      createdBy: builtin ? null : "admin", lastLoginAt: null });
  const users = new Map<string, MockUser>([
    mockUser("admin", "admin", null, true),
    mockUser("editor", "editor", "Елена Редактор"),
    mockUser("viewer", "viewer", "Виктор Читатель"),
  ].map((u) => [u.login, u]));
  /** Кто вошёл. options.user — сразу вошедший пользователь, для e2e-тестов. */
  let current: string | null = options.user ?? null;

  const account = (u: MockUser) => ({ login: u.login, role: u.role, displayName: u.displayName });
  /** Вошедший пользователь с ролью не ниже указанной — как auth.require в API. */
  function need(role: Role) {
    const u = current ? users.get(current) : undefined;
    if (!u || u.status !== "active") { current = null; throw new HttpError(401, "Требуется вход"); }
    if (RANK[u.role] < RANK[role]) throw new HttpError(403, `Недостаточно прав: нужна роль «${ROLE_NAMES[role]}»`);
    return u;
  }
  const userOf = (login: string) => {
    const u = users.get(login);
    if (!u) throw new HttpError(404, `Пользователя '${login}' нет в реестре`);
    return u;
  };
  const guardBuiltin = (u: MockUser) => {
    if (u.builtin)
      throw new HttpError(409, `${u.login} — администратор из AUTH_ADMIN_LOGINS: меняется в настройках сервера`);
  };

  function authRoute(method: string, path: string, body: any): unknown {
    if (method === "POST" && path === "/auth/login") {
      const login = String(body?.login ?? "").trim().toLowerCase();
      const u = users.get(login);
      if (!u || u.status !== "active" || body?.password !== MOCK_PASSWORD) throw new HttpError(401, LOGIN_FAILED);
      current = login;
      u.lastLoginAt = new Date().toISOString();
      return account(u);
    }
    if (method === "POST" && path === "/auth/logout") { current = null; return null; }
    if (method === "GET" && path === "/auth/me") return account(need("viewer"));

    const me = need("admin");
    if (method === "GET" && path === "/auth/users")
      return { users: [...users.values()].sort((a, b) => a.login.localeCompare(b.login)) };
    if (method === "POST" && path === "/auth/users") {
      const login = String(body.login).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(login))
        throw new HttpError(409, "Логин — латинские буквы, цифры, точка, дефис и подчёркивание, до 64 символов");
      if (users.has(login)) throw new HttpError(409, `Пользователь '${login}' уже есть в реестре`);
      const created = { ...mockUser(login, body.role, String(body.displayName ?? "").trim() || null),
        createdAt: new Date().toISOString(), createdBy: me.login };
      users.set(login, created);
      return created;
    }
    const p = path.match(/^\/auth\/users\/([^/]+)$/);
    if (p && method === "PATCH") {
      const u = userOf(decodeURIComponent(p[1]));
      if (body.role !== undefined || body.status !== undefined) {
        guardBuiltin(u);
        if (u.login === me.login)
          throw new HttpError(409, "Свою роль и статус менять нельзя — попросите другого администратора");
      }
      if (body.role) u.role = body.role;
      if (body.status) u.status = body.status;
      if ("displayName" in body) u.displayName = String(body.displayName ?? "").trim() || null;
      return u;
    }
    if (p && method === "DELETE") {
      const u = userOf(decodeURIComponent(p[1]));
      guardBuiltin(u);
      if (u.login === me.login) throw new HttpError(409, "Свою учётную запись удалить нельзя");
      users.delete(u.login);
      return { deleted: u.login };
    }
    throw new HttpError(404, `Not Found: ${method} ${path}`);
  }
  const nodes = new Map(data.nodes.map((n) => [n.id, n]));
  let appliesTo = data.appliesTo;
  let references = data.references;
  let onlyIn = data.onlyIn;
  let counter = 100;

  const statusOf = (n: Node) => (n.props.status === "archived" ? "archived" : "active");
  const children = (id: string) => [...nodes.values()].filter((n) => n.parent === id);
  const keep = (n: Node, archived: boolean) => archived || statusOf(n) === "active";
  const get = (id: string) => {
    const n = nodes.get(id);
    if (!n) throw new HttpError(404, `Узел ${id} не найден`);
    return n;
  };
  const ofLabel = (id: string, label: Label) => {
    const n = get(id);
    if (n.label !== label) throw new HttpError(404, `Узел ${id} не найден`);
    return n;
  };
  const byCode = (a: Props, b: Props, key: string) => String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
  const targetName = (id: string) => String(nodes.get(id)?.props.name ?? "");
  const ruleTargets = (ruleId: string) =>
    appliesTo.filter(([r]) => r === ruleId).map(([, t]) => targetName(t)).sort();
  const departmentRef = (id: string) => ({
    departmentId: String(nodes.get(id)?.props.departmentId ?? ""), name: nodes.get(id)?.props.name ?? null,
  });
  const departmentById = (departmentId: string) =>
    [...nodes.values()].find((n) => n.label === "Department" && n.props.departmentId === departmentId);
  const withId = (n: Node): Props & { nodeId: string; status: string } =>
    ({ ...n.props, nodeId: n.id, status: statusOf(n) });
  const create = (prefix: string, label: Label, props: Props, parent?: string) => {
    const node: Node = { id: `${prefix}:${++counter}`, label, props: { ...props, status: "active" }, parent };
    nodes.set(node.id, node);
    return { nodeId: node.id, ...node.props };
  };

  function tree(archived: boolean) {
    const orderKey = (n: Node) => String(n.props.number ?? n.props.orderId ?? "");
    const orders = [...nodes.values()].filter((n) => n.label === "Order" && keep(n, archived))
      .sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
    return {
      orders: orders.map((o) => ({
        ...withId(o),
        clauses: children(o.id).filter((c) => keep(c, archived)).map((c) => ({
          ...withId(c),
          rules: children(c.id).filter((r) => keep(r, archived)).map((r) => ({
            ...withId(r),
            targets: ruleTargets(r.id),
            onlyIn: onlyIn.filter(([rule]) => rule === r.id).map(([, d]) => departmentRef(d)),
            examples: children(r.id).filter((e) => keep(e, archived)).map(withId),
          })).sort((a, b) => byCode(a, b, "ruleId")),
          references: references.filter(([from]) => from === c.id)
            .map(([, to]) => ({ nodeId: to, code: String(nodes.get(to)?.props.code ?? "?") })),
        })).sort((a, b) => byCode(a, b, "code")),
      })),
    };
  }

  function targets(archived: boolean) {
    return [...nodes.values()].filter((n) => n.label === "CheckTarget" && keep(n, archived))
      .sort((a, b) => String(a.props.name).localeCompare(String(b.props.name)))
      .map((t) => ({
        ...withId(t),
        description: String(t.props.description ?? ""),
        rules: appliesTo.filter(([, tid]) => tid === t.id)
          .map(([rid]) => String(nodes.get(rid)?.props.ruleId ?? "")).filter(Boolean).sort(),
      }));
  }

  function departments(archived: boolean) {
    const ruleId = (id: string) => String(nodes.get(id)?.props.ruleId ?? "(без ruleId)");
    return [...nodes.values()].filter((n) => n.label === "Department" && keep(n, archived))
      .sort((a, b) => String(a.props.departmentId).localeCompare(String(b.props.departmentId)))
      .map((d) => ({
        ...withId(d),
        name: String(d.props.name ?? ""),
        onlyRules: onlyIn.filter(([, dep]) => dep === d.id).map(([rule]) => ruleId(rule)),
        jobDescriptions: children(d.id).filter((j) => keep(j, archived)).map((j) => ({
          nodeId: j.id, jobDescriptionId: j.props.jobDescriptionId ?? null, title: String(j.props.title ?? ""),
          status: statusOf(j), chars: String(j.props.text ?? "").length,
          duties: ((j.props.duties as string[] | undefined) ?? []).length, dutiesReviewed: !!j.props.dutiesReviewed,
        })),
      }));
  }

  function setRuleScope(id: string, body: any) {
    ofLabel(id, "Rule");
    const only: string[] = body.only ?? [];
    const resolve = (departmentId: string) => {
      const d = departmentById(departmentId);
      if (!d) throw new HttpError(404, `Нет таких подразделений: ${departmentId}`);
      return d.id;
    };
    const nextOnly = only.map((d): [string, string] => [id, resolve(d)]);
    onlyIn = [...onlyIn.filter(([rule]) => rule !== id), ...nextOnly];
    return { only };
  }

  function descendants(id: string) {
    const all: Node[] = [];
    const walk = (pid: string) => children(pid).forEach((c) => { all.push(c); walk(c.id); });
    walk(id);
    return all;
  }

  function counts(id: string) {
    const d = descendants(id);
    return {
      clauses: d.filter((n) => n.label === "Clause").length,
      rules: d.filter((n) => n.label === "Rule").length,
      examples: d.filter((n) => n.label === "ViolationExample").length,
    };
  }

  function drop(id: string) {
    nodes.delete(id);
    appliesTo = appliesTo.filter(([r, t]) => r !== id && t !== id);
    references = references.filter(([a, b]) => a !== id && b !== id);
    onlyIn = onlyIn.filter(([rule, d]) => rule !== id && d !== id);
  }

  function remove(id: string, force: boolean) {
    const n = get(id);
    if (n.label === "ViolationExample") { drop(id); return { deleted: id, examples: 1 }; }
    if (!force && statusOf(n) !== "archived")
      throw new HttpError(409, "Удалять можно только архивированный узел. Сначала отправьте его в архив.");
    if (n.label === "CheckTarget") {
      const used = appliesTo.filter(([, t]) => t === id).map(([r]) => String(nodes.get(r)?.props.ruleId ?? r));
      if (used.length)
        throw new HttpError(409, `Атрибут используется правилами: ${used.join(", ")}. Сначала отвяжите его.`);
      drop(id);
      return { deleted: id };
    }
    if (n.label === "Department") {
      const used = onlyIn.filter(([, d]) => d === id).map(([rule]) => rule)
        .map((rule) => String(nodes.get(rule)?.props.ruleId ?? rule));
      if (used.length)
        throw new HttpError(409, `Подразделение задаёт область действия правил: ${[...new Set(used)].join(", ")}. `
          + "Сначала уберите его из этих правил.");
      descendants(id).forEach((j) => drop(j.id));
      drop(id);
      return { deleted: id };
    }
    const stats = counts(id);
    descendants(id).forEach((d) => drop(d.id));
    drop(id);
    return { deleted: id, ...stats };
  }

  function patch(id: string, properties: Props) {
    const n = get(id);
    const key = BUSINESS_KEYS[n.label];
    if ("status" in properties) throw new HttpError(409, "Свойство 'status' меняется отдельной операцией");
    if (key && key in properties) {
      const value = properties[key];
      if (value === null || value === "") throw new HttpError(409, `${key} — ключ узла, его нельзя очистить`);
      const clash = [...nodes.values()].find((o) => o.label === n.label && o.id !== id && o.props[key] === value);
      if (clash) throw new HttpError(409, `${key} '${value}' уже занят другим узлом :${n.label}`);
    }
    for (const [k, v] of Object.entries(properties)) {
      if (v === null || (k === "date" && v === "")) delete n.props[k];
      else n.props[k] = v;
    }
    return { nodeId: n.id, labels: [n.label], ...n.props };
  }

  function createTarget(name: string, description: string, source: string | null) {
    const clash = [...nodes.values()].find((n) => n.label === "CheckTarget"
      && normalizeName(String(n.props.name)) === normalizeName(name));
    if (clash)
      throw new HttpError(409, `Атрибут с таким написанием уже есть: "${clash.props.name}". `
        + "Двойники ломают проверку — используйте существующий.");
    return create("t", "CheckTarget", { name, description, ...(source ? { source } : {}) });
  }

  function setRuleTargets(id: string, names: string[]) {
    ofLabel(id, "Rule");
    const ids = names.map((name) => {
      const t = [...nodes.values()].find((n) => n.label === "CheckTarget" && n.props.name === name);
      if (!t) throw new HttpError(404, `Атрибут "${name}" не найден`);
      return t.id;
    });
    appliesTo = [...appliesTo.filter(([r]) => r !== id), ...ids.map((t): [string, string] => [id, t])];
    return { targets: ruleTargets(id) };
  }

  function diagnostics() {
    const all = [...nodes.values()];
    const active = (label: Label) => all.filter((n) => n.label === label && statusOf(n) === "active");
    const issues: unknown[] = [];
    const issue = (code: string, severity: string, title: string, detail: string,
      items: unknown[] = [], fix: unknown = null) => issues.push({ code, severity, title, detail, items, fix });
    const kindOf = (n: Node) => ({ label: `${n.label} ${n.props.number ?? n.props.code ?? n.props.ruleId ?? n.id}`,
      nodeId: n.id, kind: n.label });

    const noDescription = active("CheckTarget").filter((t) => !String(t.props.description ?? "").trim());
    if (noDescription.length)
      issue("check_targets_without_description", "error", "Атрибуты без описания",
        "Модель получает в промпте только имя и системно не распознаёт атрибут.",
        noDescription.map((t) => ({ label: String(t.props.name), nodeId: t.id, kind: "CheckTarget" })));

    const noTargets = active("Rule").filter((r) => !appliesTo.some(([rid]) => rid === r.id));
    if (noTargets.length)
      issue("rules_without_target", "error", "Правила без привязки к атрибуту",
        "Правило не участвует ни в одном запросе проверки.", noTargets.map(kindOf));

    const noKey = all.filter((n) => n.label !== "CheckTarget" && n.label !== "Department"
      && !n.props[BUSINESS_KEYS[n.label]!]);
    if (noKey.length)
      issue("missing_identifiers", "error", "Узлы без идентификатора",
        "Без бизнес-ключа узел не попадёт в выгрузку seed.cypher.", noKey.map(kindOf),
        { action: "repair_identifiers", label: "Проставить идентификаторы" });

    const orphans = active("CheckTarget").filter((t) => !appliesTo.some(([, tid]) => tid === t.id));
    if (orphans.length)
      issue("orphan_check_targets", "warning", "Атрибуты без правил",
        "Тратят контекст модели, ни на что не влияя.",
        orphans.map((t) => ({ label: String(t.props.name), nodeId: t.id, kind: "CheckTarget" })));

    const archived = all.filter((n) => statusOf(n) === "archived");
    if (archived.length)
      issue("archived_nodes", "info", "В архиве", "Архивные узлы не участвуют в проверках.",
        [{ label: `Узлов: ${archived.length}` }]);

    const count = (s: string) => issues.filter((i) => (i as { severity: string }).severity === s).length;
    return {
      issues,
      counts: { error: count("error"), warning: count("warning"), info: count("info") },
      check_targets: active("CheckTarget").length,
      ready: count("error") === 0,
      problems: [],
    };
  }

  /** Вместо модели: атрибуты по ключевым словам — и в проверке цели, и в проверке примеров. */
  /** Цитаты «модели»: слово цели, по которому сработало ключевое слово. */
  const quotesByKeywords = (goal: string) => {
    const words: [string, RegExp][] = [
      ["проект", /\S*проект\S*/i], ["срок_исполнения", /\d{2}\.\d{2}\.\d{4}|\S*квартал\S*|\b20\d{2}\b/i],
      ["обучение", /\S*(обучени|курс)\S*/i],
    ];
    return Object.fromEntries(words.flatMap(([name, re]) => { const m = re.exec(goal); return m ? [[name, m[0]]] : []; }));
  };

  const detectByKeywords = (text: string) => [
    /проект/.test(text) ? "проект" : null,
    /\d{2}\.\d{2}\.\d{4}|квартал|\b20\d{2}\b/.test(text) ? "срок_исполнения" : null,
    /обучени|курс/.test(text) ? "обучение" : null,
  ].filter((a): a is string => !!a);

  /* Проверка примеров на «модели», как api/examples_check.py. POST отвечает
     «идёт», готовый результат отдаёт следующий GET — так интерфейс проходит
     тот же путь с опросом, что и с настоящим API. */
  let catalogVersion = 0;
  let examplesRun: { report: Record<string, unknown>; version: number } | null = null;

  function runExamples() {
    const active = (n?: Node) => !!n && statusOf(n) === "active";
    const jobNames = [...nodes.values()].filter((n) => n.label === "CheckTarget" && active(n)
      && n.props.source === "job_descriptions").map((n) => String(n.props.name));
    const counts = { matched: 0, mismatched: 0, failed: 0, skipped: 0 };
    const items: Record<string, unknown>[] = [];
    for (const e of nodes.values()) {
      const rule = nodes.get(e.parent ?? "");
      const clause = nodes.get(rule?.parent ?? "");
      const order = nodes.get(clause?.parent ?? "");
      const text = String(e.props.text ?? "").trim();
      if (e.label !== "ViolationExample" || !text || ![e, rule, clause, order].every(active)) continue;
      const names = ruleTargets(rule!.id);
      const item = {
        nodeId: e.id, exampleId: e.props.exampleId ?? null, text, isViolation: !!e.props.isViolation,
        ruleNodeId: rule!.id, ruleId: rule!.props.ruleId ?? null, ruleType: rule!.props.type,
        ruleText: rule!.props.description ?? null, order: order!.props.number ?? null,
        clause: clause!.props.code ?? null, targets: names,
        outcome: "skipped", found: [] as string[], missing: [] as string[], reason: null as string | null,
      };
      if (!names.length) item.reason = "У правила нет действующих атрибутов";
      else if (names.some((n) => jobNames.includes(n)))
        item.reason = "Атрибут определяется по должностным инструкциям подразделения, а у примера подразделения нет";
      else {
        const detected = detectByKeywords(text.toLowerCase());
        item.found = names.filter((n) => detected.includes(n));
        item.missing = names.filter((n) => !detected.includes(n));
        const fires = rule!.props.type === "PROHIBITION" ? item.found.length > 0 : item.missing.length > 0;
        item.outcome = fires === item.isViolation ? "matched" : "mismatched";
      }
      counts[item.outcome as keyof typeof counts]++;
      if (item.outcome !== "matched") items.push(item);
    }
    const rank = { mismatched: 0, failed: 1, skipped: 2 };
    items.sort((a, b) => rank[a.outcome as keyof typeof rank] - rank[b.outcome as keyof typeof rank]);
    const now = new Date().toISOString();
    const total = counts.matched + counts.mismatched;
    examplesRun = {
      version: catalogVersion,
      report: { state: "done", startedAt: now, finishedAt: now, startedBy: current, total, done: total,
        error: null, counts, items },
    };
    return { ...examplesRun.report, state: "running", finishedAt: null, done: 0, stale: false,
      counts: { matched: 0, mismatched: 0, failed: 0, skipped: 0 }, items: [] };
  }

  const examplesStatus = () => examplesRun
    ? { ...examplesRun.report, stale: examplesRun.version !== catalogVersion }
    : { state: "idle", startedAt: null, finishedAt: null, startedBy: null, total: 0, done: 0, error: null,
      stale: false, counts: { matched: 0, mismatched: 0, failed: 0, skipped: 0 }, items: [] };

  /* Советчик, как api/advisor.py: «модель» дописывает обоснование к описанию,
     а предложение считается проверенным. Каталог не меняется. */
  function advice(body: any) {
    const goal = String(body?.goal ?? "");
    const expected = !!body?.expected;
    const target = [...nodes.values()].find((n) => n.label === "CheckTarget" && statusOf(n) === "active"
      && normalizeName(String(n.props.name)) === normalizeName(String(body?.attribute ?? "")));
    if (!target) throw new HttpError(404, `Действующего атрибута "${body?.attribute}" в графе нет`);
    const name = String(target.props.name);
    const present = detectByKeywords(goal.toLowerCase()).includes(name);
    const base = {
      attribute: name, nodeId: target.id, source: target.props.source ?? null, expected,
      current: { present, evidence: quotesByKeywords(goal)[name] ?? null }, already: present === expected,
      diagnosis: null, description: null, regression: null, examples: [],
      examplesInPrompt: !!settings.promptExamples, notes: [] as string[],
    };
    if (base.already)
      return { ...base, notes: ["Модель уже отвечает так, как вы ожидаете: менять граф не нужно. Если проверка "
        + "показала другое, повторите её — ответ мог быть получен до правки каталога."] };
    const rules = appliesTo.filter(([, t]) => t === target.id).map(([r]) => nodes.get(r)!)
      .filter((r) => statusOf(r) === "active" && ruleTargets(r.id).length === 1 && r.props.type);
    const old = String(target.props.description ?? "");
    const checked = rules.flatMap((r) => children(r.id)).filter((e) => statusOf(e) === "active"
      && String(e.props.text ?? "").trim() !== goal.trim()).length;
    return {
      ...base,
      diagnosis: `По текущему описанию атрибут ${present ? "найден" : "не найден"}; в описание добавлено уточнение из обоснования.`,
      description: { old, new: `${old ? old + "; " : ""}уточнение: ${String(body?.reason ?? "").trim()}`,
        verified: true, attempts: 1 },
      regression: { checked, broken: [], alreadyWrong: 0, failed: 0 },
      examples: rules.map((r) => ({
        ruleNodeId: r.id, ruleId: r.props.ruleId ?? null, ruleType: r.props.type, ruleText: r.props.description ?? null,
        isViolation: (r.props.type === "PROHIBITION") === expected,
      })),
      notes: settings.promptExamples ? [] : ["Примеры попадают в промпт только при включённой настройке "
        + "«Примеры в промпте»; без неё пример участвует лишь в проверке примеров."],
    };
  }

  /* Раздел «Настройки»: переключатели проверки и ключи внешних систем. На
     проверку по ключевым словам переключатели в фейке не влияют. */
  const settings: Record<string, boolean | number> = {
    promptExamples: false, injectionGuard: true, evidenceQuotes: true, promptExamplesPerKind: 2,
    checkCache: true, checkCacheTtlSeconds: 3600, bulkChecks: true, checkRatePerMinute: 600,
    historyEnabled: true, historyRetentionDays: 365, apiKeysEnabled: true, maintenance: false,
  };
  const settingLimits: Record<string, [number, number]> = {
    promptExamplesPerKind: [1, 10], checkCacheTtlSeconds: [0, 604800],
    checkRatePerMinute: [0, 100000], historyRetentionDays: [0, 3650],
  };
  const apiKeys = new Map<string, { keyId: string; name: string; createdAt: string; createdBy: string | null;
    lastUsedAt: string | null }>();

  function settingsRoute(method: string, path: string, body: any): unknown {
    if (path === "/settings" && method === "GET") return settings;
    if (path === "/settings" && method === "PUT") {
      const changes = Object.entries(body ?? {}).filter(([key]) => key in settings);
      for (const [key, value] of changes) {
        const limits = settingLimits[key];
        const ok = limits
          ? Number.isInteger(value) && (value as number) >= limits[0] && (value as number) <= limits[1]
          : typeof value === "boolean";
        if (!ok) throw new HttpError(422, `Недопустимое значение настройки ${key}`);
      }
      for (const [key, value] of changes) settings[key] = value as boolean | number;
      // Промпт стал другим — результат проверки примеров устарел.
      if (changes.some(([key]) => ["promptExamples", "injectionGuard", "evidenceQuotes", "promptExamplesPerKind"].includes(key)))
        catalogVersion++;
      return settings;
    }
    if (path === "/settings/api-keys" && method === "GET")
      return { keys: [...apiKeys.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    if (path === "/settings/api-keys" && method === "POST") {
      const name = String(body?.name ?? "").trim().replace(/\s+/g, " ");
      if (!name || name.length > 60) throw new HttpError(409, "Название ключа — от 1 до 60 символов");
      if ([...apiKeys.values()].some((k) => k.name.toLowerCase() === name.toLowerCase()))
        throw new HttpError(409, `Ключ с названием '${name}' уже есть`);
      const keyId = (++counter).toString(16).padStart(8, "0");
      const key = { keyId, name, createdAt: new Date().toISOString(), createdBy: current, lastUsedAt: null };
      apiKeys.set(keyId, key);
      return { ...key, key: `gc_${keyId}_mock-secret-${"x".repeat(24)}` };
    }
    const p = path.match(/^\/settings\/api-keys\/([^/]+)$/);
    if (p && method === "DELETE") {
      if (!apiKeys.delete(decodeURIComponent(p[1])))
        throw new HttpError(404, "Ключ не найден — возможно, его уже отозвали");
      return { deleted: p[1] };
    }
    throw new HttpError(404, `Not Found: ${method} ${path}`);
  }

  function repair() {
    const report = { orders: 0, clauses: 0, rules: 0, examples: 0, statuses: 0 };
    for (const n of nodes.values()) {
      const key = BUSINESS_KEYS[n.label]!;
      if (n.label !== "CheckTarget" && n.label !== "Department" && !n.props[key]) {
        n.props[key] = `${n.label.slice(0, 3).toUpperCase()}-${n.id}`;
        const field = { Order: "orders", Clause: "clauses", Rule: "rules", ViolationExample: "examples" }[
          n.label as "Order"] as keyof typeof report;
        report[field]++;
      }
      if (!n.props.status) { n.props.status = "active"; report.statuses++; }
    }
    return report;
  }

  /** «Модель» фейка: обязанность — строка или часть до точки с запятой. */
  const splitDuties = (text: string) => text.split(/[\n;]/).map((line) => line.trim()).filter(Boolean);
  const jobNode = (n: Node) => ({ nodeId: n.id, labels: [n.label], ...n.props, dutiesError: null });
  function extractDuties(n: Node) {
    n.props.duties = splitDuties(String(n.props.text ?? ""));
    n.props.dutiesReviewed = false;
    return jobNode(n);
  }

  /* ---- мониторинг: история в памяти, показатели считаются из неё ---- */
  interface MockRecord {
    at: string; ms: number; status: string; department_id: string | null; login: string | null;
    mode: "single" | "bulk"; batch_id: string | null; cached: boolean; llm_calls: number; llm_ms: number;
    queue_ms: number; violations: string[]; goal: string;
  }
  // Неделя пакетных проверок «от кадровой системы» — чтобы графикам было что показать.
  const history: MockRecord[] = Array.from({ length: 420 }, (_, i) => {
    const status = i % 7 === 0 ? "VIOLATIONS_FOUND" : i % 41 === 0 ? "NEEDS_MANUAL_REVIEW" : "ALLOWED";
    const cached = i % 5 === 0;
    return {
      at: new Date(Date.now() - (i * 24 + 5) * 60_000).toISOString(), ms: cached ? 2 : 900 + (i * 137) % 2600,
      status, department_id: ["UCT", "AGD", "FIN"][i % 3], login: "hr-system", mode: "bulk",
      batch_id: `b${Math.floor(i / 60)}`, cached, llm_calls: cached ? 0 : 2, llm_ms: cached ? 0 : 700 + (i * 91) % 1900,
      queue_ms: cached ? 0 : (i * 53) % 600, violations: status === "VIOLATIONS_FOUND" ? ["R-1.1"] : [],
      goal: `Цель №${i + 1} из пакетной проверки`,
    };
  });
  const TRUNCATE: Record<string, (d: Date) => void> = {
    minute: (d) => d.setSeconds(0, 0), hour: (d) => d.setMinutes(0, 0, 0), day: (d) => d.setHours(0, 0, 0, 0),
    week: (d) => { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); },
    month: (d) => { d.setHours(0, 0, 0, 0); d.setDate(1); },
  };
  const avg = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
  function aggregate(rows: MockRecord[]) {
    const computed = rows.filter((r) => !r.cached);
    const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
    return {
      total: rows.length, avg_ms: avg(rows.map((r) => r.ms)), avg_computed_ms: avg(computed.map((r) => r.ms)),
      p95_ms: sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.95)] : null, max_ms: sorted.at(-1) ?? null,
      avg_queue_ms: avg(computed.map((r) => r.queue_ms)), avg_llm_ms: avg(computed.map((r) => r.llm_ms)),
      llm_calls: rows.reduce((n, r) => n + r.llm_calls, 0), cached: rows.length - computed.length,
      allowed: rows.filter((r) => r.status === "ALLOWED").length,
      violations: rows.filter((r) => r.status === "VIOLATIONS_FOUND").length,
      manual_review: rows.filter((r) => r.status === "NEEDS_MANUAL_REVIEW").length,
    };
  }
  function monitoring(path: string, query: URLSearchParams) {
    if (path === "/monitoring/now") {
      const recent = history.filter((r) => Date.parse(r.at) > Date.now() - 300_000);
      return {
        llm: { capacity: 32, reserve: 4, running: 0, waiting: 0 },
        checks: { running: 0, queued: 0, batches: [] },
        recent: { window_seconds: 300, checks: recent.length, per_minute: recent.length / 5,
          avg_ms: aggregate(recent).avg_computed_ms, cached: recent.filter((r) => r.cached).length,
          manual_review: recent.filter((r) => r.status === "NEEDS_MANUAL_REVIEW").length },
        cache: { entries: 0, max_entries: 100000,
          ttl_seconds: settings.checkCache ? settings.checkCacheTtlSeconds : 0, hits: 0, misses: 0 },
        history: { pending: 0, dropped: 0, retention_days: settings.historyRetentionDays,
          enabled: settings.historyEnabled },
        vllm: { running: 0, waiting: 0, kv_cache_usage: 0.02 }, neo4j: true, uptime_seconds: 3600,
      };
    }
    const start = Date.parse(query.get("start") ?? ""), end = Date.parse(query.get("end") ?? "");
    if (Number.isNaN(start) || Number.isNaN(end)) throw new HttpError(422, "Укажите период: start и end");
    const mode = query.get("mode");
    const rows = history.filter((r) => Date.parse(r.at) >= start && Date.parse(r.at) < end && (!mode || r.mode === mode));
    if (path === "/monitoring/history")
    {
      const offset = Number(query.get("offset") ?? 0);
      return { total: rows.length, records: [...rows].sort((a, b) => b.at.localeCompare(a.at))
        .slice(offset, offset + Number(query.get("limit") ?? 10)) };
    }
    const step = query.get("step") ?? "day";
    if (!TRUNCATE[step]) throw new HttpError(422, `Недопустимая периодичность '${step}'`);
    const groups = new Map<string, MockRecord[]>();
    for (const r of rows) {
      const d = new Date(r.at);
      TRUNCATE[step](d);
      groups.set(d.toISOString(), [...(groups.get(d.toISOString()) ?? []), r]);
    }
    return {
      step, timezone: query.get("timezone") ?? "UTC", totals: aggregate(rows),
      buckets: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([bucket, group]) => ({ bucket, ...aggregate(group) })),
    };
  }

  const GRAPH_CAPTIONS: Record<Label, [string, string]> = {
    Order: ["number", "title"], Clause: ["code", "text"], Rule: ["ruleId", "description"],
    CheckTarget: ["name", "description"], ViolationExample: ["exampleId", "text"],
    Department: ["name", "departmentId"], JobDescription: ["title", "jobDescriptionId"],
  };
  const PARENT_EDGE: Partial<Record<Label, string>> = {
    Clause: "CONTAINS", Rule: "DEFINES", ViolationExample: "HAS_EXAMPLE", JobDescription: "HAS_JOB_DESCRIPTION",
  };
  function graph() {
    const edge = (source: string, target: string, type: string, status: string | null = null) =>
      ({ source, target, type, status });
    return {
      nodes: [...nodes.values()].map((n) => ({
        id: n.id, label: n.label, title: String(n.props[GRAPH_CAPTIONS[n.label][0]] ?? "?"),
        detail: String(n.props[GRAPH_CAPTIONS[n.label][1]] ?? "").slice(0, 300), status: statusOf(n),
        ...(n.label === "Rule" && n.props.type ? { type: n.props.type } : {}),
      })),
      edges: [
        ...[...nodes.values()].filter((n) => n.parent).map((n) => edge(n.parent!, n.id, PARENT_EDGE[n.label]!)),
        ...appliesTo.map(([r, t]) => edge(r, t, "APPLIES_TO")),
        ...references.map(([a, b]) => edge(a, b, "REFERENCES")),
        ...onlyIn.map(([r, d]) => edge(r, d, "ONLY_IN")),
      ],
    };
  }

  /** Упрощённая проверка цели: атрибуты «находятся» по ключевым словам, а
      дублирование обязанности — по вхождению её строки из инструкции в цель. */
  function checkGoal(goal: string, departmentId: string | null, batchId: string | null = null) {
    const notes = ["Ответ фейкового API: атрибуты определены по ключевым словам, без модели."];
    const allRules = "применены все правила, включая действующие только в отдельных "
      + "подразделениях.";
    const found = departmentId ? departmentById(departmentId.trim()) : undefined;
    let department: Node | undefined;
    if (!departmentId?.trim()) notes.push("Подразделение не передано: " + allRules);
    else if (!found) notes.push(`Подразделения "${departmentId}" нет в графе (:Department): ${allRules}`);
    else if (statusOf(found) !== "active") notes.push(`Подразделение "${departmentId}" находится в архиве: ${allRules}`);
    else department = found;

    const text = goal.toLowerCase();
    const detected = detectByKeywords(text);

    const applies = (r: Node) => {
      const clause = nodes.get(r.parent!)!;
      const order = nodes.get(clause.parent!)!;
      if (statusOf(clause) !== "active" || statusOf(order) !== "active") return false;
      const restricted = onlyIn.filter(([rule]) => rule === r.id).map(([, d]) => d);
      return !(department && restricted.length && !restricted.includes(department.id));
    };
    const activeRules = [...nodes.values()].filter((n) => n.label === "Rule" && statusOf(n) === "active" && applies(n));

    // Атрибуты, определяемые по должностным инструкциям: как agent.check_job_targets.
    const jobNames = [...nodes.values()].filter((n) => n.label === "CheckTarget" && statusOf(n) === "active"
      && n.props.source === "job_descriptions").map((n) => String(n.props.name));
    const jobRules = activeRules.filter((r) => ruleTargets(r.id).some((t) => jobNames.includes(t)));
    const matched: { job_description_id: unknown; title: unknown; duty: string }[] = [];
    let unverified = false;
    if (jobRules.length) {
      const docs = department ? children(department.id).filter((j) => statusOf(j) === "active") : [];
      const reason = !department ? "подразделение не определено."
        : !docs.length ? `для подразделения "${department.props.name}" они не загружены.` : null;
      if (reason) {
        notes.push(`Цель не сравнивалась с должностными инструкциями: ${reason} Правило проверьте вручную.`);
        unverified = true;
      }
      for (const doc of docs)
        for (const line of (doc.props.duties as string[] | undefined) ?? splitDuties(String(doc.props.text ?? ""))) {
          const duty = line.trim().replace(/[.,]$/, "");
          if (duty.length > 5 && text.includes(duty.toLowerCase()))
            matched.push({ job_description_id: doc.props.jobDescriptionId ?? null, title: doc.props.title ?? null, duty });
        }
      if (matched.length) detected.push(...jobNames);
    }

    const violations = [];
    for (const r of activeRules) {
      const clause = nodes.get(r.parent!)!;
      const order = nodes.get(clause.parent!)!;
      for (const name of ruleTargets(r.id)) {
        const present = detected.includes(name);
        const prohibition = r.props.type === "PROHIBITION";
        if (prohibition ? !present : present) continue;
        violations.push({
          order_number: order.props.number ?? null, order_title: order.props.title ?? null,
          clause_code: clause.props.code ?? null, clause_text: clause.props.text ?? null,
          rule_id: r.props.ruleId ?? null, rule_text: r.props.description ?? null,
          check_instruction: r.props.checkInstruction ?? null,
          violation_type: prohibition ? "PROHIBITION" : "MISSING_REQUIREMENT",
          attribute: name,
          example_kind: prohibition ? "violation" : "correct",
          examples: children(r.id).filter((e) => statusOf(e) === "active"
            && !!e.props.isViolation === prohibition).map((e) => e.props.text),
          ...(jobNames.includes(name) ? { matched_duties: matched } : {}),
        });
      }
    }
    const status = violations.length ? "VIOLATIONS_FOUND" : unverified ? "NEEDS_MANUAL_REVIEW" : "ALLOWED";
    history.push({
      at: new Date().toISOString(), ms: 1200, status, department_id: department ? String(department.props.departmentId) : null,
      login: current, mode: batchId ? "bulk" : "single", batch_id: batchId, cached: false, llm_calls: 1, llm_ms: 1100,
      queue_ms: 0,
      violations: violations.map((v) => String(v.rule_id ?? "?")), goal: goal.slice(0, 500),
    });
    return {
      goal, status, allowed: status === "ALLOWED",
      department: department
        ? { id: String(department.props.departmentId), name: String(department.props.name ?? "") } : null,
      detected_attributes: detected, attribute_quotes: settings.evidenceQuotes ? quotesByKeywords(goal) : {},
      violations, notes,
    };
  }

  /** Пакетная проверка — как main.check_many: предел размера, выключатель, обязательное подразделение. */
  function checkGoals(body: unknown) {
    if (!Array.isArray(body)) throw new HttpError(422, "Ожидался массив целей");
    if (body.length > 200)
      throw new HttpError(413, `За один раз можно проверить не более 200 целей, передано ${body.length}`);
    if (!settings.bulkChecks)
      throw new HttpError(503, "Пакетная проверка временно отключена администратором. Цели можно проверять по одной");
    for (const item of body) {
      if (typeof item?.goal !== "string" || !item.goal.length) throw new HttpError(422, "goal: String should have at least 1 character");
      if (typeof item?.department_id !== "string" || !item.department_id.length)
        throw new HttpError(422, "department_id: String should have at least 1 character");
    }
    const batchId = (++counter).toString(16);
    const results = body.map((item) => ({
      id: item.id == null ? null : String(item.id), ...checkGoal(item.goal, item.department_id, batchId),
    }));
    const count = (status: string) => results.filter((r) => r.status === status).length;
    return { results, summary: { total: results.length, allowed: count("ALLOWED"),
      violations: count("VIOLATIONS_FOUND"), manual_review: count("NEEDS_MANUAL_REVIEW") } };
  }

  function route(method: string, path: string, query: URLSearchParams, body: any): unknown {
    const archived = query.get("include_archived") === "true";
    const m = (re: RegExp) => path.match(re);
    let p: RegExpMatchArray | null;

    if (method === "GET" && path === "/health") return { status: "ok" };
    if (path.startsWith("/auth/")) return authRoute(method, path, body);
    // Те же права, что в api/routes.py: читать может любой вошедший, менять —
    // редактор, удалять навсегда и чинить идентификаторы — администратор.
    need(method === "DELETE" || path === "/catalog/repair-identifiers" || path.startsWith("/monitoring/")
      || path.startsWith("/settings") ? "admin"
      : method === "GET" || path === "/check-goal" || path === "/check-goals" ? "viewer" : "editor");
    if (path.startsWith("/settings")) return settingsRoute(method, path, body);
    if (method === "GET" && path === "/catalog/tree") return tree(archived);
    if (method === "GET" && path === "/catalog/check-targets") return { targets: targets(archived) };
    if (method === "GET" && path === "/catalog/clauses")
      return {
        clauses: [...nodes.values()].filter((n) => n.label === "Clause").map((c) => ({
          nodeId: c.id, code: String(c.props.code ?? "?"), status: statusOf(c),
          order_number: String(nodes.get(c.parent!)?.props.number ?? nodes.get(c.parent!)?.props.orderId ?? "?"),
        })).sort((a, b) => (a.order_number + a.code).localeCompare(b.order_number + b.code)),
      };
    if (method === "GET" && path === "/catalog/departments") return { departments: departments(archived) };
    if (method === "GET" && path === "/catalog/diagnostics") return diagnostics();
    if (method === "GET" && path === "/catalog/graph") return graph();
    if (path === "/catalog/examples-check") {
      if (method === "GET") return examplesStatus();
      if (method === "POST") return runExamples();
    }
    if (method === "POST" && path === "/catalog/advice") return advice(body);
    // Любая правка каталога делает результат проверки примеров устаревшим.
    if (method !== "GET" && path.startsWith("/catalog/")) catalogVersion++;
    if (method === "GET" && /^\/monitoring\/(now|stats|history)$/.test(path)) return monitoring(path, query);
    if (method === "POST" && path === "/catalog/repair-identifiers") return repair();
    if (method === "POST" && path === "/check-goal")
      return checkGoal(String(body?.goal ?? ""), body?.department_id ?? null);
    if (method === "POST" && path === "/check-goals") return checkGoals(body);

    if ((p = m(/^\/catalog\/nodes\/([^/]+)$/))) {
      const id = decodeURIComponent(p[1]);
      if (method === "GET") { const n = get(id); return { nodeId: n.id, labels: [n.label], ...n.props }; }
      if (method === "DELETE") return remove(id, query.get("force") === "true");
    }
    if ((p = m(/^\/catalog\/nodes\/([^/]+)\/(properties|status|descendants)$/))) {
      const id = decodeURIComponent(p[1]);
      if (p[2] === "properties" && method === "PATCH") return patch(id, body?.properties ?? {});
      if (p[2] === "status" && method === "POST") { get(id).props.status = body.status; return { nodeId: id, status: body.status }; }
      if (p[2] === "descendants" && method === "GET") { get(id); return counts(id); }
    }

    if (method === "POST" && path === "/catalog/orders") {
      const orderId = body.orderId || String(body.number).toUpperCase().replace(/[^\p{L}\p{N}]+/gu, "-");
      if ([...nodes.values()].some((n) => n.label === "Order" && n.props.orderId === orderId))
        throw new HttpError(409, `orderId '${orderId}' уже занят`);
      return create("o", "Order", { number: body.number, title: body.title, orderId,
        ...(body.date ? { date: body.date } : {}) });
    }
    if (method === "POST" && path === "/catalog/clauses") {
      const order = ofLabel(body.orderNodeId, "Order");
      return create("c", "Clause", { code: body.code, text: body.text,
        clauseId: `${order.props.orderId ?? "ORD"}/${body.code}` }, order.id);
    }
    if (method === "POST" && path === "/catalog/rules") {
      ofLabel(body.clauseNodeId, "Clause");
      const rule = create("r", "Rule", { type: body.type, description: body.description,
        checkInstruction: body.checkInstruction, ruleId: `R-${counter + 1}` }, body.clauseNodeId);
      setRuleTargets(rule.nodeId, body.targets ?? []);
      return rule;
    }
    if (method === "POST" && path === "/catalog/examples") {
      ofLabel(body.ruleNodeId, "Rule");
      return create("e", "ViolationExample", { text: body.text, isViolation: !!body.isViolation,
        exampleId: `EX-${counter + 1}` }, body.ruleNodeId);
    }
    if (method === "POST" && path === "/catalog/check-targets")
      return createTarget(String(body.name), String(body.description ?? ""), body.source ?? null);
    if (method === "POST" && path === "/catalog/job-descriptions") {
      const department = ofLabel(body.departmentNodeId, "Department");
      const title = String(body.title).trim();
      const created = create("j", "JobDescription", { title, text: String(body.text).trim(),
        jobDescriptionId: `${department.props.departmentId}/${normalizeName(title)}-${counter + 1}` }, department.id);
      return extractDuties(get(created.nodeId));
    }
    if ((p = m(/^\/catalog\/job-descriptions\/([^/]+)(\/extract-duties|\/duties)?$/))) {
      const n = ofLabel(decodeURIComponent(p[1]), "JobDescription");
      if (method === "PUT" && !p[2]) {
        const changed = String(body.text).trim() !== n.props.text;
        Object.assign(n.props, { title: String(body.title).trim(), text: String(body.text).trim() });
        return changed ? extractDuties(n) : jobNode(n);
      }
      if (method === "POST" && p[2] === "/extract-duties") return extractDuties(n);
      if (method === "PUT" && p[2] === "/duties") {
        n.props.duties = (body.duties as string[]).map((d) => d.trim()).filter(Boolean);
        n.props.dutiesReviewed = true;
        return jobNode(n);
      }
    }

    if (method === "POST" && path === "/catalog/departments") {
      const departmentId = String(body.departmentId).trim();
      if (departmentById(departmentId))
        throw new HttpError(409, `Подразделение с идентификатором '${departmentId}' уже существует`);
      return create("d", "Department", { departmentId, name: String(body.name).trim() });
    }

    if (method === "PUT" && (p = m(/^\/catalog\/rules\/([^/]+)\/departments$/)))
      return setRuleScope(decodeURIComponent(p[1]), body ?? {});
    if (method === "PUT" && (p = m(/^\/catalog\/rules\/([^/]+)\/targets$/)))
      return setRuleTargets(decodeURIComponent(p[1]), body.targets ?? []);
    if (method === "PUT" && (p = m(/^\/catalog\/clauses\/([^/]+)\/references$/))) {
      const id = decodeURIComponent(p[1]);
      ofLabel(id, "Clause");
      references = [...references.filter(([a]) => a !== id),
        ...(body.references as string[]).map((to): [string, string] => [id, to])];
      return { references: body.references };
    }
    if (method === "POST" && (p = m(/^\/catalog\/(clauses|rules)\/([^/]+)\/move$/))) {
      const [label, parentLabel]: [Label, Label] = p[1] === "clauses" ? ["Clause", "Order"] : ["Rule", "Clause"];
      const n = ofLabel(decodeURIComponent(p[2]), label);
      n.parent = ofLabel(body.parentNodeId, parentLabel).id;
      return { nodeId: n.id, parentNodeId: n.parent };
    }
    throw new HttpError(404, `Not Found: ${method} ${path}`);
  }

  return {
    handle(method: string, url: string, body?: unknown): Reply {
      const parsed = new URL(url, "http://mock");
      try {
        const result = route(method.toUpperCase(), parsed.pathname, parsed.searchParams, body);
        if (parsed.pathname === "/auth/logout") return { status: 204, body: null };
        return { status: method.toUpperCase() === "POST"
          && /^\/(catalog\/(orders|clauses|rules|examples|check-targets|departments|job-descriptions)|auth\/users|settings\/api-keys)$/
            .test(parsed.pathname) ? 201 : 200, body: result };
      } catch (err) {
        if (err instanceof HttpError) return { status: err.status, body: { detail: err.message } };
        return { status: 500, body: { detail: String(err) } };
      }
    },
  };
}
