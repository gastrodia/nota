import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { register } from "../src/server/auth";
import { createJob, getJob } from "../src/server/jobs";
import { runJob } from "../src/server/agent";
import { query, closeDatabase } from "../src/server/db";

const database =
  process.env.TEST_DATABASE_URL ??
  "postgresql://nota_test:nota_local_test_only@127.0.0.1:55437/nota_test";
const target = new URL(database);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  target.pathname !== "/nota_test"
)
  throw new Error(
    "Conversation tests require isolated local nota_test PostgreSQL.",
  );
process.env.DATABASE_URL = database;
process.env.DASHSCOPE_API_KEY = "nota_conversation_fixture";
const authorizations: Record<string, unknown>[] = [];
let failFinalOnce = false;
let failTodoFinalOnce = false;
const provider = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const users = body.messages.filter(
    (m: { role: string; content: string }) =>
      m.role === "user" && !m.content.startsWith("现在只输出最终JSON"),
  );
  const input = users.at(-1)?.content ?? "";
  const tools = body.messages
    .filter((m: { role: string }) => m.role === "tool")
    .map((m: { content: string }) => JSON.parse(m.content));
  const format = body.response_format?.json_schema?.name;
  let message: Record<string, unknown>;
  if (format === "nota_todo_authorization") {
    const context = JSON.parse(input);
    authorizations.push(context);
    const supplement = context.user_input === "2026年12月15日下午三点。";
    const pending =
      context.pending_action?.proposed_todo?.title === "发送报价单";
    const hasOriginal = context.conversation.some(
      (turn: { role: string; content: string }) =>
        turn.role === "user" && turn.content.includes("发送报价单"),
    );
    const ambiguous = context.user_input.includes("下午") && !supplement;
    message = {
      role: "assistant",
      content: JSON.stringify({
        decision: ambiguous
          ? "clarify"
          : supplement
            ? pending && hasOriginal
              ? "allow"
              : "deny"
            : context.user_input.includes("取消")
              ? "deny"
              : "allow",
        reason: "Deterministic protocol fixture",
        resolves_pending: supplement && pending && hasOriginal,
        question: ambiguous
          ? "请确认具体日期和几点发送报价单？目前仅保存待办，不推送提醒。"
          : null,
      }),
    };
  } else if (format) {
    const callIds = body.messages.flatMap(
      (m: { tool_calls?: { id: string }[] }) =>
        m.tool_calls?.map((call) => call.id) ?? [],
    );
    const replyIds = new Set(
      body.messages
        .filter((m: { role: string }) => m.role === "tool")
        .map((m: { tool_call_id: string }) => m.tool_call_id),
    );
    if (callIds.some((id: string) => !replyIds.has(id))) {
      response.writeHead(400);
      response.end("{}");
      return;
    }
    if (input.includes("直接调用") && !failFinalOnce) {
      failFinalOnce = true;
      response.writeHead(503);
      response.end("{}");
      return;
    }
    if (input.includes("查询待办后重试") && !failTodoFinalOnce) {
      failTodoFinalOnce = true;
      response.writeHead(503);
      response.end("{}");
      return;
    }
    const todos = tools.flatMap((r: { todo?: unknown }) =>
      r.todo ? [r.todo] : [],
    );
    const queried: { title: string }[] = tools.flatMap(
      (r: { todo_list?: { todos: { title: string }[] } }) =>
        r.todo_list?.todos ?? [],
    );
    message = {
      role: "assistant",
      content: JSON.stringify({
        title: "报价单",
        summary: input,
        answer: todos.length
          ? "已保存待办，不会推送通知。"
          : queried.length
            ? `未完成待办：${queried.map((todo) => todo.title).join("、")}`
            : "已整理。",
        source_note_ids: [],
      }),
    };
  } else if (tools.length || input.includes("取消")) {
    message = { role: "assistant", content: "已处理。" };
  } else if (input.includes("有哪些待办") || input.includes("查询待办")) {
    assert.ok(
      body.tools.some(
        (tool: { function: { name: string } }) =>
          tool.function.name === "list_todos",
      ),
    );
    message = {
      role: "assistant",
      content: null,
      tool_calls: [
        ...(input.includes("和历史")
          ? [
              {
                id: "empty-history",
                type: "function",
                function: {
                  name: "search_notes",
                  arguments: JSON.stringify({ query: "不存在的历史记录" }),
                },
              },
            ]
          : []),
        {
          id: "list",
          type: "function",
          function: { name: "list_todos", arguments: "{}" },
        },
      ],
    };
  } else if (input.includes("多调用检索")) {
    message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "search",
          type: "function",
          function: {
            name: "search_notes",
            arguments: JSON.stringify({
              query: "海星 报价",
              start_date: null,
              end_date: null,
            }),
          },
        },
        {
          id: "unexpected-write",
          type: "function",
          function: {
            name: "create_todo",
            arguments: JSON.stringify({ title: "发送报价单", due_at: null }),
          },
        },
      ],
    };
  } else if (input.includes("请先问我时间")) {
    message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "clarify",
          type: "function",
          function: {
            name: "ask_clarification",
            arguments: JSON.stringify({
              title: "发送报价单",
              question: "请问具体哪一天、几点发送报价单？",
            }),
          },
        },
      ],
    };
  } else {
    message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "create",
          type: "function",
          function: {
            name: "create_todo",
            arguments: JSON.stringify({
              title: "发送报价单",
              due_at: input.includes("不设截止时间")
                ? null
                : "2026-12-15T15:00:00+08:00",
            }),
          },
        },
      ],
    };
  }
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ choices: [{ message }] }));
});
before(async () => {
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture failed to start");
  process.env.QWEN_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
});
after(async () => {
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await closeDatabase();
});
async function owner() {
  return register(
    `conversation-${randomUUID()}@example.test`,
    "nota-test-password",
  );
}
async function turn(
  userId: string,
  conversationId: string,
  input: string,
  kind: "note" | "chat" = "chat",
) {
  const job = await createJob(userId, {
    kind,
    input,
    conversation_id: conversationId,
    idempotency_key: randomUUID(),
  });
  await runJob(userId, job.id);
  return getJob(userId, job.id);
}

test("clarification persists and supplemental date uses the same original conversation for authorization", async () => {
  const user = await owner();
  const conversationId = randomUUID();
  const first = await turn(
    user.id,
    conversationId,
    "帮我创建发送报价单的待办，请先问我时间。",
  );
  assert.equal(first.result!.todos.length, 0);
  assert.match(first.result!.answer, /哪一天.*几点/);
  const stored = (
    await query("SELECT agent_state FROM jobs WHERE id=$1", [first.id])
  ).rows[0].agent_state;
  assert.equal(stored.clarification.proposed_todo.title, "发送报价单");
  const second = await turn(
    user.id,
    conversationId,
    "2026年12月15日下午三点。",
  );
  assert.equal(second.result!.todos.length, 1);
  assert.equal(
    new Date(second.result!.todos[0].due_at!).toISOString(),
    "2026-12-15T07:00:00.000Z",
  );
  const context = authorizations.at(-1)!;
  assert.equal(
    (context.pending_action as { origin_job_id: string }).origin_job_id,
    first.id,
  );
  assert.ok(
    (context.conversation as { role: string; content: string }[]).some(
      (t) => t.role === "user" && t.content.includes("请先问我时间"),
    ),
  );
  const completed = (
    await query("SELECT agent_state FROM jobs WHERE id=$1", [second.id])
  ).rows[0].agent_state;
  assert.equal(completed.clarification, undefined);
});

test("independent validator blocks a guessed time and preserves clarification across failed finalization retry", async () => {
  const user = await owner();
  const conversationId = randomUUID();
  const created = await createJob(user.id, {
    kind: "chat",
    input: "下午发送报价单，直接调用创建工具。",
    conversation_id: conversationId,
    idempotency_key: randomUUID(),
  });
  await assert.rejects(runJob(user.id, created.id));
  assert.equal(
    Number(
      (await query("SELECT count(*) FROM todos WHERE user_id=$1", [user.id]))
        .rows[0].count,
    ),
    0,
  );
  await runJob(user.id, created.id);
  const result = await getJob(user.id, created.id);
  assert.equal(result.result!.todos.length, 0);
  assert.match(result.result!.answer, /具体日期.*几点/);
  assert.match(result.result!.answer, /不推送提醒/);
});

test("cancelled or other-conversation actions cannot supply authorization", async () => {
  const user = await owner();
  const conversationId = randomUUID();
  await turn(user.id, conversationId, "创建发送报价单的待办，请先问我时间。");
  const separate = await turn(
    user.id,
    randomUUID(),
    "2026年12月15日下午三点。",
  );
  assert.equal(separate.result!.todos.length, 0);
  await turn(user.id, conversationId, "取消这个待办，不要创建。");
  const cancelled = await turn(
    user.id,
    conversationId,
    "2026年12月15日下午三点。",
  );
  assert.equal(cancelled.result!.todos.length, 0);
  assert.equal(
    Number(
      (await query("SELECT count(*) FROM todos WHERE user_id=$1", [user.id]))
        .rows[0].count,
    ),
    0,
  );
});

test("an explicitly unscheduled todo is allowed without inventing a deadline", async () => {
  const user = await owner();
  const result = await turn(
    user.id,
    randomUUID(),
    "帮我创建发送报价单的待办，不设截止时间。",
  );
  assert.equal(result.result!.todos.length, 1);
  assert.equal(result.result!.todos[0].due_at, null);
});

test("a note clarification can be completed from the Agent and retains the original action source", async () => {
  const user = await owner();
  const conversationId = randomUUID();
  const first = await turn(
    user.id,
    conversationId,
    "帮我创建发送报价单的待办，请先问我时间。",
    "note",
  );
  assert.ok(first.note_id);
  assert.equal(first.result!.needs_clarification, true);
  const second = await turn(
    user.id,
    conversationId,
    "2026年12月15日下午三点。",
  );
  assert.equal(second.result!.todos.length, 1);
  assert.match(second.result!.todos[0].source_text, /发送报价单/);
  assert.match(second.result!.todos[0].source_text, /2026年12月15日/);
  assert.equal(second.result!.needs_clarification, undefined);
});

test("conflicting history stops remaining calls and completes every tool-call reply", async () => {
  const user = await owner();
  await query(
    "INSERT INTO notes(user_id,title,transcript,status,source) VALUES($1,'海星报价一','海星客户报价8万元。','ready','text'),($1,'海星报价二','海星客户报价9万元。','ready','text')",
    [user.id],
  );
  const result = await turn(
    user.id,
    randomUUID(),
    "查询海星报价，多调用检索。",
  );
  assert.equal(result.result!.needs_clarification, true);
  assert.match(result.result!.answer, /哪次|日期|版本/);
  assert.doesNotMatch(result.result!.answer, /请先询问用户/);
  assert.equal(result.result!.todos.length, 0);
  assert.equal(result.result!.source_note_ids.length, 2);
  const state = (
    await query("SELECT agent_state FROM jobs WHERE id=$1", [result.id])
  ).rows[0].agent_state;
  assert.ok(
    state.messages.some(
      (m: { role: string; tool_call_id?: string }) =>
        m.role === "tool" && m.tool_call_id === "unexpected-write",
    ),
  );
});

test("parallel supplements resolving one pending action create one todo", async () => {
  const user = await owner();
  const conversationId = randomUUID();
  await turn(user.id, conversationId, "创建发送报价单的待办，请先问我时间。");
  const jobs = await Promise.all(
    Array.from({ length: 2 }, () =>
      createJob(user.id, {
        kind: "chat",
        input: "2026年12月15日下午三点。",
        conversation_id: conversationId,
        idempotency_key: randomUUID(),
      }),
    ),
  );
  await Promise.all(jobs.map((job) => runJob(user.id, job.id)));
  const results = await Promise.all(jobs.map((job) => getJob(user.id, job.id)));
  assert.ok(results.every((job) => job.status === "succeeded"));
  assert.equal(new Set(results.map((job) => job.result!.todos[0]?.id)).size, 1);
  assert.equal(
    Number(
      (await query("SELECT count(*) FROM todos WHERE user_id=$1", [user.id]))
        .rows[0].count,
    ),
    1,
  );
});

test("Agent lists existing pending todos without creating them and persists query cards", async () => {
  const user = await owner();
  const other = await owner();
  await query(
    "INSERT INTO todos(user_id,title,completed) VALUES($1,'发送报价单',false),($1,'已经完成的事项',true),($2,'其他账户的事项',false)",
    [user.id, other.id],
  );
  const result = await turn(user.id, randomUUID(), "帮我看看有哪些待办");
  assert.equal(result.status, "succeeded");
  assert.match(result.result!.answer, /发送报价单/);
  assert.doesNotMatch(result.result!.answer, /已保存|已创建|其他账户|已经完成/);
  assert.deepEqual(result.result!.todos, []);
  assert.deepEqual(
    result.result!.queried_todos?.map((todo) => todo.title),
    ["发送报价单"],
  );
  assert.deepEqual(result.result!.sources, []);
  const events = result.events.filter((event) => event.type === "tool_result");
  assert.deepEqual(
    events.map((event) => event.payload.name),
    ["list_todos"],
  );
  assert.equal(
    Number(
      (await query("SELECT count(*) FROM todos WHERE user_id=$1", [user.id]))
        .rows[0].count,
    ),
    2,
  );
});

test("empty todo queries give an explicit answer and read-only results survive retry", async () => {
  const user = await owner();
  const empty = await turn(user.id, randomUUID(), "帮我看看有哪些待办");
  assert.equal(empty.result!.answer, "没有找到符合条件的待办。");
  assert.deepEqual(empty.result!.queried_todos, []);
  await query("INSERT INTO todos(user_id,title) VALUES($1,'发送报价单')", [
    user.id,
  ]);
  const job = await createJob(user.id, {
    kind: "chat",
    input: "查询待办后重试",
    conversation_id: randomUUID(),
    idempotency_key: randomUUID(),
  });
  await assert.rejects(runJob(user.id, job.id));
  await runJob(user.id, job.id);
  const result = await getJob(user.id, job.id);
  assert.equal(result.result!.queried_todos?.length, 1);
  assert.deepEqual(result.result!.todos, []);
  assert.equal(
    result.events.filter((event) => event.type === "tool_result").length,
    1,
  );
  assert.equal(
    (await query("SELECT has_effect FROM tool_runs WHERE job_id=$1", [job.id]))
      .rows[0].has_effect,
    false,
  );
});

test("empty note search does not overwrite a successful todo query in the same turn", async () => {
  const user = await owner();
  await query("INSERT INTO todos(user_id,title) VALUES($1,'发送报价单')", [
    user.id,
  ]);
  const result = await turn(user.id, randomUUID(), "查询待办和历史记录");
  assert.match(result.result!.answer, /发送报价单/);
  assert.deepEqual(result.result!.sources, []);
  assert.equal(result.result!.queried_todos?.length, 1);
  assert.deepEqual(
    result.events
      .filter((event) => event.type === "tool_result")
      .map((event) => event.payload.name),
    ["search_notes", "list_todos"],
  );
});
