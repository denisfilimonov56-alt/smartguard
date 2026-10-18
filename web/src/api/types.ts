/* Формы ответов API. Повторяют api/catalog.py и api/diagnostics.py:
   у эндпоинтов нет response_model, поэтому OpenAPI ответы не описывает
   и сгенерировать эти типы из него нельзя. Меняете ответ API — меняйте здесь. */

export type Status = "active" | "archived";

/** Роли по возрастанию прав: читатель, редактор, администратор. */
export type Role = "viewer" | "editor" | "admin";
export type UserStatus = "active" | "blocked";

/** Тот, кто вошёл. */
export interface Account {
  login: string;
  role: Role;
  displayName: string | null;
  /** Когда пользователь прошёл обучение по интерфейсу; null — ещё не проходил. */
  tourSeenAt: string | null;
  /** Пределы API для интерфейса; старые версии API поле не отдают. */
  limits?: AccountLimits;
}

export interface AccountLimits {
  /** Сколько целей принимает один запрос /check-goals (MAX_GOALS_PER_REQUEST). */
  maxGoalsPerRequest: number;
  /** Предел длины цели в символах (настройка goalMaxChars). */
  goalMaxChars: number;
}

/** Запись реестра пользователей (api/users.py). */
export interface User extends Omit<Account, "role"> {
  /** null — доступ не назначен: запись хранит только отметки (обучение, привязку). */
  role: Role | null;
  status: UserStatus | null;
  /** Запись привязана к учётной записи Keycloak (sub): вход с другой учётной записью под тем же логином — отказ. */
  bound: boolean;
  /** Администратор из AUTH_ADMIN_LOGINS: в интерфейсе не меняется. */
  builtin: boolean;
  createdAt: string | null;
  createdBy: string | null;
  lastLoginAt: string | null;
}
export type RuleType = "PROHIBITION" | "REQUIREMENT";

/** Любые свойства узла, кроме служебных, приходят как есть. */
type Extra = { [key: string]: unknown };

export interface Example extends Extra {
  nodeId: string;
  status: Status;
  exampleId?: string;
  text?: string;
  isViolation?: boolean;
}

export interface DepartmentRef {
  departmentId: string;
  name: string | null;
}

export interface Rule extends Extra {
  nodeId: string;
  status: Status;
  ruleId?: string;
  type?: RuleType;
  description?: string;
  checkInstruction?: string;
  targets: string[];
  /** Действует только в этих подразделениях; пусто — для всех. */
  onlyIn: DepartmentRef[];
  /** Проверяется только у целей студентов (Rule.studentsOnly). */
  studentsOnly: boolean;
  examples: Example[];
}

export interface ClauseRef {
  nodeId: string;
  code: string;
}

export interface Clause extends Extra {
  nodeId: string;
  status: Status;
  clauseId?: string;
  code?: string;
  text?: string;
  rules: Rule[];
  references: ClauseRef[];
}

export interface Order extends Extra {
  nodeId: string;
  status: Status;
  orderId?: string;
  number?: string;
  title?: string;
  date?: string;
  clauses: Clause[];
}

/** Чем определяется атрибут; без source — по тексту цели. */
export type TargetSource = "job_descriptions";

export interface CheckTarget extends Extra {
  nodeId: string;
  status: Status;
  name: string;
  /** Для source = job_descriptions — критерий сравнения цели с инструкциями. */
  description: string;
  source?: TargetSource | null;
  rules: string[];
}

/** Должностная инструкция подразделения; текст читается отдельно по nodeId. */
export interface JobDescriptionRef {
  nodeId: string;
  jobDescriptionId: string | null;
  title: string;
  status: Status;
  /** Длина текста инструкции в символах. */
  chars: number;
  /** Сколько обязанностей выписано из текста; 0 — списка нет, сравнение идёт по тексту. */
  duties: number;
  /** Список обязанностей просмотрен редактором. */
  dutiesReviewed: boolean;
  /** Фоновая выписка обязанностей: pending — идёт, error — не удалась; старые API поле не отдают. */
  dutiesStatus?: "pending" | "ready" | "error";
}

export interface Department extends Extra {
  nodeId: string;
  status: Status;
  departmentId?: string;
  name: string;
  onlyRules: string[];
  jobDescriptions: JobDescriptionRef[];
}

export interface FlatClause {
  nodeId: string;
  code: string;
  order_number: string;
  status: Status;
}

export interface NodeProps extends Extra {
  nodeId: string;
  labels: string[];
}

export interface Descendants {
  clauses: number;
  rules: number;
  examples: number;
  /** Должностные инструкции, которые удаляются вместе с подразделением. */
  jobDescriptions?: number;
}

export type NodeKind = "Order" | "Clause" | "Rule" | "ViolationExample" | "CheckTarget" | "Department"
  | "JobDescription";

export interface IssueItem {
  label: string;
  nodeId?: string;
  kind?: NodeKind;
}

export interface Issue {
  code: string;
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  items: IssueItem[];
  fix: { action: string; label: string } | null;
}

export interface Diagnostics {
  issues: Issue[];
  counts: { error: number; warning: number; info: number };
  check_targets: number;
  ready: boolean;
  problems: string[];
}

/** Настройки сервиса (api/settings.py). */
/** Кэши проверки, которые администратор очищает по отдельности (metrics.CACHES). */
export type CacheId = "results" | "jobDescriptions" | "smart" | "lookups";

/** Состояние одного кэша: GET /settings/caches. */
export interface CacheStats {
  id: CacheId;
  entries: number;
  max_entries: number;
  /** null — записи не устаревают, 0 — кэш выключен. */
  ttl_seconds: number | null;
  hits: number;
  misses: number;
}

/** Ответ на очистку кэша: сколько записей убрано из памяти и (для smart) оценок удалено из графа. */
export interface CacheCleared {
  cache: CacheId;
  entries: number;
  stored: number | null;
  departmentId: string | null;
}

export interface Settings {
  /** Примеры каталога в промпте извлечения атрибутов. */
  promptExamples: boolean;
  /** Цель с указаниями для модели автоматически не разрешается. */
  injectionGuard: boolean;
  /** Модель подтверждает каждый найденный атрибут цитатой из цели. */
  evidenceQuotes: boolean;
  /** Оценка цели по SMART отдельным запросом к модели. */
  smartCheck: boolean;
  /** Оценка по SMART и в пакетной проверке (при включённой smartCheck). */
  smartCheckBulk: boolean;
  /** Примеров «есть» и «нет» на атрибут в промпте. */
  promptExamplesPerKind: number;
  /** Помнить ответ на ту же цель того же подразделения. */
  checkCache: boolean;
  checkCacheTtlSeconds: number;
  /** Сколько секунд помнить должностные инструкции подразделения между проверками; 0 — не помнить. */
  jobDescriptionsCacheTtlSeconds: number;
  /** Пакетная проверка разрешена. */
  bulkChecks: boolean;
  /** Целей в минуту на пользователя или ключ; 0 — без ограничения. */
  checkRatePerMinute: number;
  /** Предел длины цели в символах для проверки, пакета и советчика (100–8000). */
  goalMaxChars: number;
  /** Одновременных запросов к модели на весь сервис; остальные ждут в очереди API. Действует сразу. */
  llmMaxConcurrency: number;
  /** Слотов из них, недоступных пакетной проверке; сервер обрезает до предела минус один. */
  llmInteractiveReserve: number;
  /** Проверки записываются в историю. */
  historyEnabled: boolean;
  /** Срок хранения истории в днях; 0 — не удалять. */
  historyRetentionDays: number;
  /** Проверка по ключам доступа разрешена. */
  apiKeysEnabled: boolean;
  /** Режим обслуживания: сервис открыт только администратору. */
  maintenance: boolean;
}

/** Ключ доступа внешней системы (api/apikeys.py). */
export interface ApiKey {
  keyId: string;
  name: string;
  createdAt: string | null;
  createdBy: string | null;
  lastUsedAt: string | null;
}
/** Ответ создания: сам ключ есть только в нём. */
export interface ApiKeyCreated extends ApiKey {
  key: string;
}

/** Пример, который проверка на модели не подтвердила, не смогла проверить или пропустила. */
export interface ExampleCheckItem {
  nodeId: string;
  exampleId: string | null;
  text: string;
  isViolation: boolean;
  ruleNodeId: string;
  ruleId: string | null;
  ruleType: RuleType;
  ruleText: string | null;
  order: string | null;
  clause: string | null;
  targets: string[];
  outcome: "mismatched" | "failed" | "skipped";
  /** Атрибуты правила, которые модель нашла и не нашла в тексте примера. */
  found: string[];
  missing: string[];
  /** Почему пример не проверен или пропущен. */
  reason: string | null;
}

/** Ход и результат проверки примеров на модели (api/examples_check.py). */
export interface ExamplesCheck {
  state: "idle" | "running" | "done" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  startedBy: string | null;
  total: number;
  done: number;
  error: string | null;
  /** Каталог правили после прогона: результат мог устареть. */
  stale: boolean;
  counts: { matched: number; mismatched: number; failed: number; skipped: number };
  items: ExampleCheckItem[];
}

export interface RepairReport {
  orders: number;
  clauses: number;
  rules: number;
  examples: number;
  jobDescriptions?: number;
  statuses: number;
  /** nodeId атрибутов без имени: имя не выводится автоматически — назвать вручную. */
  unnamedTargets?: string[];
  /** nodeId подразделений без departmentId: его тоже задают вручную. */
  departmentsWithoutId?: string[];
}

/** Ответ сведения двойников атрибутов. */
export interface MergeReport {
  merged: { kept: string; removed: string[] }[];
  /** Группы, которые не сводились, и почему (разный статус или источник). */
  skipped?: { names: string[]; reason: string }[];
}

/** Узел и связь каталога для визуального графа (api/catalog.py: graph_view). */
export interface GraphNode {
  id: string;
  label: NodeKind;
  title: string;
  detail: string;
  status: Status;
  type?: RuleType;
}
export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  status: string | null;
}

/** Мониторинг (api/monitoring.py) — только администратору. */
export interface MonitoringNow {
  llm: { capacity: number; reserve: number; running: number; waiting: number };
  checks: {
    running: number;
    queued: number;
    batches: { id: string; login: string | null; total: number; done: number; started_at: string }[];
  };
  recent: {
    window_seconds: number; checks: number; per_minute: number; avg_ms: number | null;
    cached: number; manual_review: number;
  };
  cache: { entries: number; max_entries: number; ttl_seconds: number; hits: number; misses: number };
  history: { pending: number; dropped: number; retention_days: number; enabled: boolean };
  /** null — vLLM не ответил. */
  vllm: { running?: number; waiting?: number; kv_cache_usage?: number } | null;
  neo4j: boolean;
  uptime_seconds: number;
}

export interface CheckAggregate {
  total: number;
  avg_ms: number | null;
  /** Среднее без ответов из кэша. */
  avg_computed_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
  avg_queue_ms: number | null;
  avg_llm_ms: number | null;
  llm_calls: number | null;
  cached: number;
  allowed: number;
  violations: number;
  manual_review: number;
}
export type StatsStep = "minute" | "hour" | "day" | "week" | "month";
export type CheckMode = "single" | "bulk";
export interface MonitoringStats {
  step: StatsStep;
  timezone: string;
  totals: CheckAggregate | null;
  buckets: (CheckAggregate & { bucket: string })[];
}
export interface CheckRecord {
  at: string;
  ms: number;
  status: CheckStatus;
  department_id: string | null;
  login: string | null;
  mode: CheckMode;
  batch_id: string | null;
  cached: boolean;
  llm_calls: number;
  llm_ms: number;
  queue_ms: number;
  violations: string[];
  goal: string;
}

export type CheckStatus = "ALLOWED" | "VIOLATIONS_FOUND" | "NEEDS_MANUAL_REVIEW";

export interface Violation {
  /** elementId правила: по нему нарушение сопоставляется с правилом и без ruleId. */
  rule_node_id?: string | null;
  order_number: string | null;
  order_title: string | null;
  clause_code: string | null;
  clause_text: string | null;
  rule_id: string | null;
  rule_text: string | null;
  check_instruction: string | null;
  violation_type: "PROHIBITION" | "MISSING_REQUIREMENT";
  attribute: string;
  example_kind: "violation" | "correct";
  examples: (string | null)[];
  /** Обязанности из должностных инструкций, с которыми совпала цель;
      есть только у атрибута, определяемого по инструкциям. */
  matched_duties?: { job_description_id: string | null; title: string | null; duty: string | null }[];
}

/** Одна цель пакетной проверки (api/schemas.py: GoalItem). */
export interface GoalItem {
  goal: string;
  department_id: string;
  /** Ставит ли цель студент; без поля применяются и правила только для студентов. */
  is_student?: boolean | null;
  /** Идентификатор вызывающей системы; возвращается как передан. */
  id?: string | null;
}

/** Ответ пакетной проверки /check-goals: порядок результатов совпадает с порядком целей. */
export interface BatchCheck {
  results: (CheckResult & { id: string | null })[];
  summary: { total: number; allowed: number; violations: number; manual_review: number };
}

export type SmartKey = "specific" | "measurable" | "achievable" | "relevant" | "time_bound";
/** Оценка по одному критерию SMART: 0–100 и пояснение модели одним предложением. */
export interface SmartScore { score: number; comment: string }
export type SmartScores = Record<SmartKey, SmartScore>;

export interface CheckResult {
  goal: string;
  status: CheckStatus;
  allowed: boolean;
  /** null — подразделение не передано или неизвестно: применены все правила. */
  department: { id: string; name: string } | null;
  /** Ставит ли цель студент; null — признак не передан: применены все правила. */
  is_student: boolean | null;
  detected_attributes: string[];
  /** Цитаты из цели, по которым атрибут найден; у атрибута без подтверждённой цитаты записи нет. */
  attribute_quotes?: Record<string, string>;
  /** Оценка по SMART — справка автору, на статус не влияет; null — выключена или модель не ответила. */
  smart?: SmartScores | null;
  violations: Violation[];
  notes: string[];
}

/** Правило, которому цель можно добавить примером (api/advisor.py). */
export interface AdviceExample {
  ruleNodeId: string;
  ruleId: string | null;
  ruleType: RuleType;
  ruleText: string | null;
  /** С какой пометкой добавлять: пример нарушения или корректный. */
  isViolation: boolean;
}

/** Совет: как поправить граф, чтобы атрибут по цели определялся иначе (api/advisor.py). */
export interface Advice {
  attribute: string;
  /** Узел атрибута — ему правится описание. */
  nodeId: string | null;
  source: TargetSource | null;
  /** Чего ждёт редактор: true — атрибут должен быть найден. */
  expected: boolean;
  /** Что модель отвечает сейчас; evidence — цитата цели или обязанность из инструкции. */
  current: { present: boolean; evidence: string | null };
  /** Модель уже отвечает как нужно: предложений нет. */
  already: boolean;
  diagnosis: string | null;
  /** verified — с новым описанием модель ответила на цель как нужно. */
  description: { old: string; new: string; verified: boolean; attempts: number } | null;
  /** Примеры каталога с новым описанием; null — не проверялись. */
  regression: {
    checked: number;
    broken: { text: string; expected: boolean }[];
    alreadyWrong: number;
    failed: number;
  } | null;
  examples: AdviceExample[];
  /** Включена ли настройка «Примеры в промпте». */
  examplesInPrompt: boolean;
  notes: string[];
}
