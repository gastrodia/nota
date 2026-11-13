import test from "node:test";
import assert from "node:assert/strict";
import { hasUnsupportedReminderPromise } from "../scripts/lib/evaluation";
test("reminder evaluation flags positive promises", () => {
  for (const text of [
    "届时会提醒您。",
    "到时会自动提醒你。",
    "我会在截止时间提醒你。",
    "会自动发送通知。",
  ])
    assert.equal(hasUnsupportedReminderPromise(text), true, text);
});
test("reminder evaluation accepts explicit lack of notification capability", () => {
  for (const text of [
    "届时不会自动提醒你，请留意待办列表。",
    "我不会自动提醒。",
    "系统不支持定时推送通知。",
    "目前没有提醒功能。",
    "已保存到待办列表。",
  ])
    assert.equal(hasUnsupportedReminderPromise(text), false, text);
});

import {
  compareReports,
  gradeObservation,
  scorerVersion,
  summarizeCases,
  type EvaluationReport,
  type Observation,
} from "../scripts/lib/evaluation";
import { evaluationScenarios } from "../scripts/lib/evaluation-cases";
const observation = (change: Partial<Observation> = {}): Observation => ({
  succeeded: true,
  summary: "与张总沟通海星报价八万元，交付两周。",
  answer: "已保存到待办列表。",
  todos: [],
  source_note_ids: [],
  tools: [],
  ...change,
});

test("fact scoring distinguishes omission and guarded contradictions with equivalent expressions", () => {
  const expected = {
    todos: [],
    summary_facts: [
      { key: "customer", variants: ["海星"] },
      { key: "amount", variants: ["8万元", "八万元"] },
      { key: "person", variants: ["张总"] },
    ],
    forbidden_facts: [
      { key: "wrong-amount", variants: ["18万元", "十八万元"] },
    ],
  };
  assert.equal(gradeObservation(observation(), expected).pass, true);
  const wrong = gradeObservation(
    observation({ summary: "海星报价18万元。" }),
    expected,
  );
  assert.deepEqual(wrong.missing_facts, ["summary:amount", "summary:person"]);
  assert.deepEqual(wrong.guarded_false_facts, ["wrong-amount"]);
  assert.equal(wrong.counts.fact_found, 1);
  assert.equal(wrong.pass, false);
  assert.equal(wrong.requires_human_review, true);
});

test("action scoring measures duplicate writes, omissions, title and exact timezone-equivalent times", () => {
  const todo = {
    title: "给张总发送海星报价单",
    due_at: "2026-12-15T15:00:00+08:00",
  };
  const expected = {
    todos: [{ title: [["海星"], ["报价单"]], due_at: "2026-12-15T07:00:00Z" }],
  };
  assert.equal(
    gradeObservation(observation({ todos: [todo] }), expected).pass,
    true,
  );
  const duplicate = gradeObservation(
    observation({ todos: [todo, todo] }),
    expected,
  );
  assert.equal(duplicate.counts.todo_matched, 1);
  assert.equal(duplicate.counts.todo_actual, 2);
  assert.equal(duplicate.checks.todo_precision, false);
  assert.equal(duplicate.checks.todo_recall, true);
  const omitted = gradeObservation(observation(), expected);
  assert.equal(omitted.checks.todo_recall, false);
  const wrongTime = gradeObservation(
    observation({ todos: [{ ...todo, due_at: null }] }),
    expected,
  );
  assert.equal(wrongTime.checks.todo_times, false);
  const invented = gradeObservation(observation({ todos: [todo] }), {
    todos: [],
  });
  assert.equal(invented.checks.todo_precision, false);
});

test("matching overlapping action titles and dates is independent of output order", () => {
  const expected = {
    todos: [
      { title: [["发送"]], due_at: "2026-12-15T07:00:00Z" },
      { title: [["发送"], ["报价单"]], due_at: "2026-12-16T07:00:00Z" },
    ],
  };
  const todos = [
    { title: "发送报价单", due_at: "2026-12-16T07:00:00Z" },
    { title: "发送报价单", due_at: "2026-12-15T07:00:00Z" },
  ];
  assert.equal(gradeObservation(observation({ todos }), expected).pass, true);
  assert.equal(
    gradeObservation(observation({ todos: todos.reverse() }), expected).pass,
    true,
  );
});

test("source IDs must support the scenario; any UUID or merely a source count is insufficient", () => {
  const expected = {
    todos: [],
    sources: "required" as const,
    source_ids: ["right"],
  };
  const correct = gradeObservation(
    observation({ source_note_ids: ["right"] }),
    expected,
  );
  assert.equal(correct.pass, true);
  const wrong = gradeObservation(
    observation({ source_note_ids: ["unrelated"] }),
    expected,
  );
  assert.equal(wrong.counts.source_supported, 0);
  assert.equal(wrong.checks.sources, false);
  const mixed = gradeObservation(
    observation({ source_note_ids: ["right", "unrelated"] }),
    expected,
  );
  assert.equal(mixed.checks.sources, false);
  assert.equal(
    gradeObservation(observation({ source_note_ids: ["right"] }), {
      todos: [],
      sources: "none",
      source_ids: ["right"],
    }).checks.sources,
    false,
  );
});

test("clarification requires a question and zero committed actions", () => {
  const expected = { todos: [], clarification: true };
  assert.equal(
    gradeObservation(observation({ answer: "请问下午具体几点？" }), expected)
      .pass,
    true,
  );
  assert.equal(
    gradeObservation(observation({ answer: "没有时间，已保存。" }), expected)
      .checks.clarification,
    false,
  );
  assert.equal(
    gradeObservation(
      observation({
        answer: "几点？",
        todos: [{ title: "已创建", due_at: null }],
      }),
      expected,
    ).checks.clarification,
    false,
  );
});

test("aggregate metrics use raw counts and leave empty denominators undefined", () => {
  const expected = { todos: [{ title: [["报价"]], due_at: null }] };
  const grade = gradeObservation(
    observation({
      todos: [
        { title: "报价", due_at: null },
        { title: "报价", due_at: null },
      ],
    }),
    expected,
  );
  const summary = summarizeCases([
    { name: "duplicate", pass: false, duration_ms: 120, grade },
  ]);
  assert.equal(summary.metrics.todo_precision, 0.5);
  assert.equal(summary.metrics.todo_recall, 1);
  assert.equal(summary.metrics.required_fact_recall, null);
  assert.equal(summary.latency_ms.p95, 120);
  assert.equal(summarizeCases([]).latency_ms.median, null);
});

function report(pass: boolean): EvaluationReport {
  return {
    report_version: 2,
    scorer_version: scorerVersion,
    dataset: { id: "fixed", fingerprint: "same" },
    cases: [{ name: "one", pass, duration_ms: 10 }],
  };
}
test("comparison rejects incompatible datasets and detects individual regressions despite equal total passes", () => {
  assert.throws(
    () =>
      compareReports(report(true), {
        ...report(true),
        dataset: { id: "different", fingerprint: "changed" },
      }),
    /same dataset/,
  );
  const baseline = report(true);
  baseline.cases.push({ name: "two", pass: false, duration_ms: 20 });
  const candidate = report(false);
  candidate.cases.push({ name: "two", pass: true, duration_ms: 10 });
  const comparison = compareReports(baseline, candidate);
  assert.deepEqual(comparison.regressions, ["one"]);
  assert.deepEqual(comparison.improvements, ["two"]);
  assert.equal(comparison.has_regression, true);
});

test("fixed dataset covers factual summary, action precision, conversations, temporal history and conflicting sources", () => {
  const names = new Set(evaluationScenarios.map((item) => item.name));
  for (const name of [
    "summary-fidelity",
    "two-actions",
    "negated",
    "quoted",
    "clarify-then-create",
    "historical-occurrence-time",
    "conflicting-history",
    "retrieved-instruction",
  ])
    assert.ok(names.has(name), name);
  const conversation = evaluationScenarios.find(
    (item) => item.name === "clarify-then-create",
  )!;
  assert.equal(conversation.turns[0].expected.todos.length, 0);
  assert.equal(conversation.turns[1].expected.todos.length, 1);
});
