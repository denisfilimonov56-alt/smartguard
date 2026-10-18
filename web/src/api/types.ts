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
}

/** Запись реестра пользователей (api/users.py). */
export interface User extends Account {
  status: UserStatus;
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
export interface Settings {
  /** Примеры каталога в промпте извлечения атрибутов. */
  promptExamples: boolean;
  /** Цель с указаниями для модели автоматически не разрешается. */
  injectionGuard: boolean;
  /** Модель подтверждает каждый найденный атрибут цитатой из цели. */
  evidenceQuotes: boolean;
  /** Примеров «есть» и «нет» на атрибут в промпте. */
  promptExamplesPerKind: number;
  /** Помнить ответ на ту же цель того же подразделения. */
  checkCache: boolean;
  checkCacheTtlSeconds: number;
  /** Пакетная проверка разрешена. */
  bulkChecks: boolean;
  /** Целей в минуту на пользователя или ключ; 0 — без ограничения. */
  checkRatePerMinute: number;
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
  statuses: number;
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
  /** Идентификатор вызывающей системы; возвращается как передан. */
  id?: string | null;
}

/** Ответ пакетной проверки /check-goals: порядок результатов совпадает с порядком целей. */
export interface BatchCheck {
  results: (CheckResult & { id: string | null })[];
  summary: { total: number; allowed: number; violations: number; manual_review: number };
}

export interface CheckResult {
  goal: string;
  status: CheckStatus;
  allowed: boolean;
  /** null — подразделение не передано или неизвестно: применены все правила. */
  department: { id: string; name: string } | null;
  detected_attributes: string[];
  /** Цитаты из цели, по которым атрибут найден; у атрибута без подтверждённой цитаты записи нет. */
  attribute_quotes?: Record<string, string>;
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
