import { createHash } from "node:crypto";

export const scorerVersion = "nota-evaluation-v2";

// This rule is deliberately narrow; it is not a general natural-language judge.
export function hasUnsupportedReminderPromise(answer: string) {
  return /(?<!不)(?:我会|我将|会自动|将会|届时会|到时会|到时将).{0,12}(?:提醒|通知)/.test(
    answer,
  );
}
export function fingerprint(value: unknown) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}
export interface Fact {
  key: string;
  /** Any of these equivalent surface forms is acceptable. */
  variants: string[];
}
export interface ExpectedTodo {
  /** Every group must match; alternatives inside a group are equivalent. */
  title: string[][];
  due_at: string | null;
}
export interface Expectation {
  summary_facts?: Fact[];
  answer_facts?: Fact[];
  forbidden_facts?: Fact[];
  todos: ExpectedTodo[];
  tools?: string[];
  sources?: "required" | "none";
  source_ids?: string[];
  clarification?: boolean;
}
export interface Observation {
  succeeded: boolean;
  summary: string;
  answer: string;
  todos: { title: string; due_at: string | null }[];
  source_note_ids: string[];
  tools: string[];
}
export interface Counts {
  fact_expected: number;
  fact_found: number;
  forbidden_checked: number;
  forbidden_found: number;
  todo_expected: number;
  todo_actual: number;
  todo_matched: number;
  todo_correct_time: number;
  source_expected: number;
  source_actual: number;
  source_supported: number;
  source_recalled: number;
}
const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s，,。!！:：;；、]/g, "")
    .replace(/(?<!\d)\.|\.(?!\d)/g, "");
const numericCharacters = "0-9零〇一二两三四五六七八九十百千万亿点.";
function includesFact(text: string, fact: Fact) {
  return fact.variants.some((variant) => {
    const normalized = normalize(variant);
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const numeric = new RegExp(`[${numericCharacters}]`);
    const prefix = numeric.test(normalized[0] ?? "")
      ? `(?<![${numericCharacters}])`
      : "";
    const suffix = numeric.test(normalized.at(-1) ?? "")
      ? `(?![${numericCharacters}])`
      : "";
    return new RegExp(prefix + escaped + suffix).test(normalize(text));
  });
}
function sameTime(actual: string | null, expected: string | null) {
  if (actual === null || expected === null) return actual === expected;
  return (
    Number.isFinite(Date.parse(actual)) &&
    Date.parse(actual) === Date.parse(expected)
  );
}
export function gradeObservation(actual: Observation, expected: Expectation) {
  const missingFacts = [
    ...(expected.summary_facts ?? [])
      .filter((fact) => !includesFact(actual.summary, fact))
      .map((fact) => `summary:${fact.key}`),
    ...(expected.answer_facts ?? [])
      .filter((fact) => !includesFact(actual.answer, fact))
      .map((fact) => `answer:${fact.key}`),
  ];
  const forbiddenFacts = (expected.forbidden_facts ?? [])
    .filter((fact) => includesFact(actual.summary + "\n" + actual.answer, fact))
    .map((fact) => fact.key);
  // Maximum bipartite matching prevents duplicate predictions from scoring twice
  // and avoids greedy ordering penalising overlapping expected titles.
  function matchTodos(requireTime: boolean) {
    const matches = new Map<number, number>();
    function assign(expectedIndex: number, seen: Set<number>): boolean {
      const todo = expected.todos[expectedIndex];
      for (let i = 0; i < actual.todos.length; i++) {
        if (
          seen.has(i) ||
          (requireTime && !sameTime(actual.todos[i].due_at, todo.due_at)) ||
          !todo.title.every((group) =>
            group.some((token) =>
              normalize(actual.todos[i].title).includes(normalize(token)),
            ),
          )
        )
          continue;
        seen.add(i);
        const previous = matches.get(i);
        if (previous === undefined || assign(previous, seen)) {
          matches.set(i, expectedIndex);
          return true;
        }
      }
      return false;
    }
    expected.todos.forEach((_, index) => assign(index, new Set()));
    return matches.size;
  }
  const titleMatches = matchTodos(false);
  const timedMatches = matchTodos(true);
  const expectedIds = new Set(expected.source_ids ?? []);
  const actualIds = new Set(actual.source_note_ids);
  const supported = [...actualIds].filter((id) => expectedIds.has(id));
  const count: Counts = {
    fact_expected:
      (expected.summary_facts?.length ?? 0) +
      (expected.answer_facts?.length ?? 0),
    fact_found: 0,
    forbidden_checked: expected.forbidden_facts?.length ?? 0,
    forbidden_found: forbiddenFacts.length,
    todo_expected: expected.todos.length,
    todo_actual: actual.todos.length,
    todo_matched: titleMatches,
    todo_correct_time: timedMatches,
    source_expected: expectedIds.size,
    source_actual: actualIds.size,
    source_supported: supported.length,
    source_recalled: supported.length,
  };
  count.fact_found = count.fact_expected - missingFacts.length;
  const checks = {
    succeeded: actual.succeeded,
    required_facts: missingFacts.length === 0,
    no_guarded_false_facts: forbiddenFacts.length === 0,
    todo_precision: count.todo_matched === count.todo_actual,
    todo_recall: count.todo_matched === count.todo_expected,
    todo_times: count.todo_correct_time === count.todo_matched,
    tools: (expected.tools ?? []).every((name) => actual.tools.includes(name)),
    sources:
      expected.sources === "none"
        ? actualIds.size === 0
        : expected.sources === "required"
          ? actualIds.size > 0 && actualIds.size === supported.length
          : actualIds.size === 0 || actualIds.size === supported.length,
    clarification:
      !expected.clarification ||
      (actual.todos.length === 0 &&
        /[?？]|请.{0,12}(?:确认|补充|选择|说明)|需要.{0,10}(?:哪|几|具体)|(?:哪个|哪条|哪次|几点|什么时间|具体时间)/.test(
          actual.answer,
        )),
    no_unsupported_reminder: !hasUnsupportedReminderPromise(actual.answer),
    summary_without_internal_ids:
      !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
        actual.summary,
      ),
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    counts: count,
    missing_facts: missingFacts,
    guarded_false_facts: forbiddenFacts,
    // Anything outside the enumerated facts still needs human semantic review.
    requires_human_review: true,
  };
}
export type Grade = ReturnType<typeof gradeObservation>;
export interface CaseResult {
  name: string;
  pass: boolean;
  duration_ms: number;
  grade?: Grade;
  error?: string;
  [key: string]: unknown;
}
const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? null : numerator / denominator;
export function summarizeCases(cases: CaseResult[]) {
  const counts: Counts = {
    fact_expected: 0,
    fact_found: 0,
    forbidden_checked: 0,
    forbidden_found: 0,
    todo_expected: 0,
    todo_actual: 0,
    todo_matched: 0,
    todo_correct_time: 0,
    source_expected: 0,
    source_actual: 0,
    source_supported: 0,
    source_recalled: 0,
  };
  for (const item of cases)
    if (item.grade)
      for (const key of Object.keys(counts) as (keyof Counts)[])
        counts[key] += item.grade.counts[key];
  const times = cases.map((item) => item.duration_ms).sort((a, b) => a - b);
  return {
    passed: cases.filter((item) => item.pass).length,
    total: cases.length,
    counts,
    metrics: {
      required_fact_recall: ratio(counts.fact_found, counts.fact_expected),
      guarded_false_fact_rate: ratio(
        counts.forbidden_found,
        counts.forbidden_checked,
      ),
      todo_precision: ratio(counts.todo_matched, counts.todo_actual),
      todo_recall: ratio(counts.todo_matched, counts.todo_expected),
      todo_time_accuracy: ratio(counts.todo_correct_time, counts.todo_matched),
      source_precision: ratio(counts.source_supported, counts.source_actual),
      source_recall: ratio(counts.source_recalled, counts.source_expected),
    },
    latency_ms: {
      median: times.length ? times[Math.floor(times.length / 2)] : null,
      p95: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null,
    },
  };
}
export interface EvaluationReport {
  report_version: 2;
  scorer_version: string;
  dataset: { id: string; fingerprint: string };
  cases: CaseResult[];
  [key: string]: unknown;
}
export function compareReports(
  baseline: EvaluationReport,
  candidate: EvaluationReport,
) {
  if (
    baseline.report_version !== 2 ||
    candidate.report_version !== 2 ||
    baseline.scorer_version !== candidate.scorer_version ||
    baseline.dataset.fingerprint !== candidate.dataset.fingerprint ||
    baseline.cases.length !== candidate.cases.length ||
    new Set(baseline.cases.map((item) => item.name)).size !==
      baseline.cases.length ||
    new Set(candidate.cases.map((item) => item.name)).size !==
      candidate.cases.length ||
    baseline.cases.some(
      (item) => !candidate.cases.some((other) => other.name === item.name),
    )
  )
    throw new Error(
      "Reports must use the same dataset, scorer and distinct case names.",
    );
  const before = summarizeCases(baseline.cases);
  const after = summarizeCases(candidate.cases);
  const regressions = candidate.cases
    .filter(
      (item) =>
        !item.pass &&
        baseline.cases.some(
          (previous) => previous.name === item.name && previous.pass,
        ),
    )
    .map((item) => item.name);
  const improvements = candidate.cases
    .filter(
      (item) =>
        item.pass &&
        baseline.cases.some(
          (previous) => previous.name === item.name && !previous.pass,
        ),
    )
    .map((item) => item.name);
  const metrics = Object.fromEntries(
    Object.entries(before.metrics).map(([key, value]) => {
      const next = after.metrics[key as keyof typeof after.metrics];
      return [
        key,
        {
          baseline: value,
          candidate: next,
          delta: value === null || next === null ? null : next - value,
        },
      ];
    }),
  );
  return {
    regressions,
    improvements,
    baseline: before,
    candidate: after,
    metrics,
    // Changes in latency are reported, not used to claim semantic quality.
    has_regression:
      regressions.length > 0 ||
      Object.entries(metrics).some(
        ([key, value]) =>
          value.delta !== null &&
          (key === "guarded_false_fact_rate"
            ? value.delta > 0
            : value.delta < 0),
      ),
  };
}
