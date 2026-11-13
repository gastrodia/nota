import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  compareReports,
  fingerprint,
  gradeObservation,
  scorerVersion,
  summarizeCases,
  type CaseResult,
  type EvaluationReport,
  type Observation,
} from "./lib/evaluation";
import { datasetId, evaluationScenarios } from "./lib/evaluation-cases";
import { register } from "../src/server/auth";
import { createJob, getJob } from "../src/server/jobs";
import {
  runJob,
  agentPromptVersion,
  agentPromptFingerprint,
} from "../src/server/agent";
import { query, closeDatabase } from "../src/server/db";
import { AppError } from "../src/server/errors";

// Only synthetic accounts in a dedicated local PostgreSQL database are permitted.
config({ path: ".env.local", quiet: true });
const local =
  process.env.TEST_DATABASE_URL ??
  "postgresql://nota_test:nota_local_test_only@127.0.0.1:55437/nota_test";
const target = new URL(local);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  target.pathname !== "/nota_test"
)
  throw new Error(
    "Live evaluation requires the isolated local nota_test database.",
  );
process.env.DATABASE_URL = local;
function option(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value for ${name}`);
  return value;
}
interface ModelExchange {
  case: string;
  request: unknown;
  response?: unknown;
  status?: number;
  duration_ms: number;
  error?: string;
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: tsx scripts/evaluate.ts [--label name] [--output report.json] [--baseline report.json]\nRequires an official Qwen key and isolated local nota_test PostgreSQL. Reports contain synthetic model messages, never credentials. Compare existing reports: tsx scripts/compare-evaluations.ts baseline.json candidate.json",
    );
    return;
  }
  if (!process.env.DASHSCOPE_API_KEY)
    throw new Error(
      "Configure DASHSCOPE_API_KEY before running live evaluation.",
    );
  const modelBase = new URL(
    process.env.QWEN_BASE_URL ??
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  if (
    process.env.NOTA_TEST_MODE === "1" ||
    !(
      modelBase.hostname === "aliyuncs.com" ||
      modelBase.hostname.endsWith(".aliyuncs.com")
    )
  )
    throw new Error(
      "Live evaluation requires an official Qwen endpoint, not a fixture.",
    );
  const migrationFiles = (await readdir("db/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrations = await Promise.all(
    migrationFiles.map(async (name) => ({
      name,
      checksum: fingerprint(await readFile(`db/migrations/${name}`, "utf8")),
    })),
  );
  const applied = await query<{ name: string; checksum: string }>(
    "SELECT name,checksum FROM schema_migrations",
  ).catch(() => {
    throw new Error(
      "Apply migrations to the isolated test database before evaluation.",
    );
  });
  const missing = migrations.filter(
    (migration) =>
      !applied.rows.some(
        (row) =>
          row.name === migration.name && row.checksum === migration.checksum,
      ),
  );
  if (missing.length)
    throw new Error(
      `Apply current repository migrations to the isolated test database before evaluation: ${missing.map((migration) => migration.name).join(", ")}`,
    );
  const label = option("--label") ?? "candidate";
  const output = option("--output") ?? `work/live-eval-${Date.now()}.json`;
  const baselinePath = option("--baseline");
  const at = new Date().toISOString();
  const sourcePaths = [
    "src/server/agent.ts",
    "src/server/tools.ts",
    "src/lib/contracts.ts",
  ];
  const sources = await Promise.all(
    sourcePaths.map(async (path) => ({
      path,
      sha256: fingerprint(await readFile(path, "utf8")),
    })),
  );
  const dataset = {
    id: datasetId,
    fingerprint: fingerprint(evaluationScenarios),
  };
  let baseline: EvaluationReport | undefined;
  if (baselinePath) {
    baseline = JSON.parse(
      await readFile(baselinePath, "utf8"),
    ) as EvaluationReport;
    if (
      baseline.report_version !== 2 ||
      baseline.scorer_version !== scorerVersion ||
      baseline.dataset.fingerprint !== dataset.fingerprint
    )
      throw new Error(
        "Baseline must use the current dataset and scorer; rerun it with the same suite.",
      );
  }
  const results: CaseResult[] = [];
  const exchanges: ModelExchange[] = [];
  const originalFetch = globalThis.fetch;
  let currentCase = "";
  // Capture synthetic model messages and raw outputs, never headers/API keys.
  globalThis.fetch = async (input, init) => {
    const url =
      input instanceof Request ? new URL(input.url) : new URL(String(input));
    if (
      url.origin !== modelBase.origin ||
      !url.pathname.endsWith("/chat/completions")
    )
      return originalFetch(input, init);
    const started = Date.now();
    const exchange: ModelExchange = {
      case: currentCase,
      request: null,
      duration_ms: 0,
    };
    try {
      const body = typeof init?.body === "string" ? init.body : "";
      exchange.request = body ? JSON.parse(body) : null;
      exchanges.push(exchange);
      const response = await originalFetch(input, init);
      exchange.status = response.status;
      const raw = await response.clone().text();
      try {
        exchange.response = JSON.parse(raw);
      } catch {
        exchange.response = raw;
      }
      return response;
    } catch (error) {
      exchange.error = error instanceof Error ? error.name : "TransportError";
      throw error;
    } finally {
      exchange.duration_ms = Date.now() - started;
    }
  };
  try {
    for (const scenario of evaluationScenarios) {
      // A new account per scenario keeps ordinary 10/day accounting intact.
      const user = await register(
        `eval-${randomUUID()}@example.test`,
        randomUUID(),
      );
      const conversationId = randomUUID();
      const ids = new Map<string, string>();
      try {
        for (const note of scenario.notes ?? []) {
          const id = randomUUID();
          ids.set(note.key, id);
          await query(
            "INSERT INTO notes(id,user_id,title,transcript,status,source,recorded_at) VALUES($1,$2,$3,$4,'ready','text',$5)",
            [id, user.id, note.title, note.transcript, note.recorded_at],
          );
        }
        for (const [index, turn] of scenario.turns.entries()) {
          currentCase = `${scenario.name}:${index + 1}`;
          const started = Date.now();
          const expected = {
            ...turn.expected,
            source_ids: (turn.source_keys ?? []).map((key) => {
              const id = ids.get(key);
              if (!id)
                throw new Error(
                  "Evaluation dataset has an unknown source key.",
                );
              return id;
            }),
          };
          let jobId: string | undefined;
          let observation: Observation = {
            succeeded: false,
            summary: "",
            answer: "",
            todos: [],
            source_note_ids: [],
            tools: [],
          };
          try {
            jobId = (
              await createJob(user.id, {
                kind: turn.kind,
                input: turn.input,
                ...(turn.kind === "chat"
                  ? { conversation_id: conversationId }
                  : {}),
                idempotency_key: randomUUID(),
              })
            ).id;
            await runJob(user.id, jobId);
            const job = await getJob(user.id, jobId);
            const result = job.result;
            const writtenTodos = await query<{
              title: string;
              due_at: Date | null;
            }>(
              "SELECT title,due_at FROM todos WHERE job_id=$1 ORDER BY created_at,id",
              [jobId],
            );
            observation = {
              succeeded: job.status === "succeeded",
              summary: result?.summary ?? "",
              answer: result?.answer ?? "",
              todos: writtenTodos.rows.map((todo) => ({
                title: todo.title,
                due_at: todo.due_at?.toISOString() ?? null,
              })),
              source_note_ids: result?.source_note_ids ?? [],
              tools: job.events
                .filter((event) => event.type === "tool_result")
                .map((event) => String(event.payload.name)),
            };
            const grade = gradeObservation(observation, expected);
            results.push({
              name: currentCase,
              category: scenario.category,
              input: turn.input,
              expected,
              observation,
              result,
              grade,
              pass: grade.pass,
              tools: job.events.filter((event) => event.type === "tool_result"),
              duration_ms: Date.now() - started,
            });
          } catch (error) {
            if (jobId) {
              // A failed final response can still leave committed actions.
              const persisted = await query<{
                title: string;
                due_at: Date | null;
              }>(
                "SELECT title,due_at FROM todos WHERE job_id=$1 ORDER BY created_at,id",
                [jobId],
              ).catch(() => null);
              if (persisted)
                observation.todos = persisted.rows.map((todo) => ({
                  title: todo.title,
                  due_at: todo.due_at?.toISOString() ?? null,
                }));
            }
            const grade = gradeObservation(observation, expected);
            results.push({
              name: currentCase,
              category: scenario.category,
              input: turn.input,
              expected,
              observation,
              grade,
              pass: false,
              error: error instanceof Error ? error.name : "ProcessingError",
              ...(error instanceof AppError
                ? { error_code: error.code, error_message: error.message }
                : {}),
              job_id: jobId,
              duration_ms: Date.now() - started,
            });
          }
          console.log(
            `${currentCase}: ${results.at(-1)?.pass ? "PASS" : "FAIL"}`,
          );
        }
      } finally {
        await query("DELETE FROM users WHERE id=$1", [user.id]);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  const report: EvaluationReport = {
    report_version: 2,
    at,
    label,
    scorer_version: scorerVersion,
    dataset,
    database_schema: migrations,
    model: process.env.QWEN_TEXT_MODEL ?? "qwen3.8-flash",
    provider: "real-qwen",
    endpoint: `${modelBase.origin}${modelBase.pathname}`,
    generation: { enable_thinking: false, stream: false },
    prompt_and_code: {
      version: agentPromptVersion,
      prompt_fingerprint: agentPromptFingerprint(),
      fingerprint: fingerprint(sources),
      files: sources,
      note: "Hash includes agent rules, authorization, tool definitions and result schemas. Exact model messages are retained in model_exchanges.",
    },
    scope:
      "Fixed synthetic text scenarios. Not a population accuracy estimate or microphone/ASR evaluation. Unenumerated semantic fidelity needs human review.",
    summary: summarizeCases(results),
    cases: results,
    model_exchanges: exchanges,
  };
  if (baseline) report.comparison = compareReports(baseline, report);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  const summary = summarizeCases(results);
  console.log(
    `Fixed real-Qwen cases: ${summary.passed}/${summary.total} passed. Report: ${output}`,
  );
  console.log(
    JSON.stringify(
      {
        metrics: summary.metrics,
        latency_ms: summary.latency_ms,
        failed: results.filter((item) => !item.pass).map((item) => item.name),
        ...(baseline ? { comparison: report.comparison } : {}),
      },
      null,
      2,
    ),
  );
  if (
    results.some((item) => !item.pass) ||
    (report.comparison as { has_regression?: boolean } | undefined)
      ?.has_regression
  )
    process.exitCode = 1;
}
main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Live evaluation failed.",
    );
    process.exitCode = 1;
  })
  .finally(closeDatabase);
