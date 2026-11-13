import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockModel } from "./fixtures/mock-model";
import { randomUUID } from "node:crypto";
import {
  register,
  login,
  createSession,
  currentUser,
  destroySession,
  sessionHeader,
  throttle,
} from "../src/server/auth";
import {
  createJob,
  claimJob,
  quota,
  getJob,
  failJob,
  listConversationJobs,
} from "../src/server/jobs";
import { runJob } from "../src/server/agent";
import { executeTool } from "../src/server/tools";
import {
  getNote,
  updateTodo,
  deleteNote,
  newNote,
  listNotes,
} from "../src/server/repository";
import { query, closeDatabase, ormTransaction } from "../src/server/db";
import { notes } from "../src/server/schema";
import { assertOrigin, AppError } from "../src/server/errors";
import {
  storeAudio,
  readAudio,
  cleanupAudio,
  type AudioStorage,
} from "../src/server/audio";
import { GET, POST, PATCH, DELETE } from "../src/app/api/[...path]/route";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgresql://nota_test:nota_local_test_only@127.0.0.1:55437/nota_test";
const target = new URL(url);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  target.pathname !== "/nota_test"
)
  throw new Error(
    "Tests only run against the isolated local nota_test database.",
  );
process.env.DATABASE_URL = url;
process.env.DASHSCOPE_API_KEY = "nota_test_key";
const provider = createMockModel();
before(async () => {
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (!address || typeof address === "string")
    throw new Error("provider start failed");
  process.env.QWEN_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  await query("SELECT 1");
});
after(async () => {
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await closeDatabase();
});
async function user() {
  return register(`test-${randomUUID()}@example.test`, "nota-test-password");
}
function input(
  text = "创建发送报价单的待办",
  extra: Record<string, unknown> = {},
) {
  return { kind: "note", input: text, idempotency_key: randomUUID(), ...extra };
}
async function expectCode(promise: Promise<unknown>, status: number) {
  await assert.rejects(
    promise,
    (e: unknown) => e instanceof AppError && e.status === status,
  );
}

test("ORM auth preserves duplicate-email errors, atomic throttling and session expiry", async () => {
  const u = await user();
  await expectCode(register(u.email, "nota-test-password"), 409);
  assert.deepEqual(await login(u.email, "nota-test-password"), u);
  await expectCode(login(u.email, "wrong-password"), 401);
  const key = `orm-throttle:${randomUUID()}`;
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () => throttle(key, 3)),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 3);
  for (const result of attempts) {
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof AppError);
      assert.equal(result.reason.status, 429);
    }
  }
  const token = await createSession(u.id);
  const request = new Request("http://localhost/api/me", {
    headers: { Cookie: `nota_session=${token}` },
  });
  assert.deepEqual(await currentUser(request), u);
  await query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [u.id],
  );
  assert.equal(await currentUser(request), null);
});

test("ORM notes preserve literal search, ownership, idempotency and date serialization", async () => {
  const a = await user(),
    b = await user();
  const id = randomUUID();
  const literal = "折扣100%_\\原文";
  const note = await newNote(a.id, { id, transcript: literal });
  await newNote(a.id, { transcript: "折扣100其他原文" });
  await newNote(b.id, { transcript: literal });
  assert.equal(note.source, "voice");
  assert.equal(note.duration_seconds, null);
  assert.equal(
    (await newNote(a.id, { id, transcript: "重试不得覆盖" })).transcript,
    literal,
  );
  await expectCode(newNote(b.id, { id }), 409);
  for (const term of ["%", "_", "\\", "100%_\\", "' OR 1=1 --"]) {
    const found = await listNotes(a.id, term);
    assert.deepEqual(
      found.map((n) => n.id),
      term.startsWith("'") ? [] : [id],
    );
  }
  const found = (await listNotes(a.id, literal))[0];
  assert.equal(found.has_audio, false);
  assert.equal(found.created_at.toISOString(), note.created_at.toISOString());
  assert.equal(
    JSON.parse(JSON.stringify(found)).created_at,
    note.created_at.toISOString(),
  );
});

test("ORM transaction rolls back writes on the checked-out PostgreSQL connection", async () => {
  const u = await user();
  const failure = new Error("rollback-test");
  await assert.rejects(
    ormTransaction(async (db) => {
      await db
        .insert(notes)
        .values({ user_id: u.id, transcript: "must roll back" });
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
  assert.equal(
    (await query("SELECT id FROM notes WHERE user_id=$1", [u.id])).rowCount,
    0,
  );
});

test("ORM conversation history isolates users and serializes events and dates", async () => {
  const a = await user(),
    b = await user();
  const conversation_id = randomUUID();
  const first = await createJob(
    a.id,
    input("只记录第一次交谈", { kind: "chat", conversation_id }),
  );
  await runJob(a.id, first.id);
  const second = await createJob(
    a.id,
    input("只记录第二次交谈", { kind: "chat", conversation_id }),
  );
  await runJob(a.id, second.id);
  await createJob(b.id, input("其他账户", { kind: "chat", conversation_id }));
  await createJob(a.id, input("不属于对话的便签", { conversation_id }));
  const history = await listConversationJobs(a.id, conversation_id);
  assert.deepEqual(
    history.map((j) => j.id),
    [first.id, second.id],
  );
  for (const job of history) {
    assert.equal(new Date(job.created_at).toISOString(), job.created_at);
    assert.ok(job.events.length > 0);
    assert.ok(job.events.every((e) => /^\d+$/.test(e.id)));
    assert.ok(
      job.events.every(
        (e) => new Date(e.created_at).toISOString() === e.created_at,
      ),
    );
  }
  assert.doesNotThrow(() => JSON.stringify(history));
});

test("conversation HTTP history restores note clarification questions after a reload", async () => {
  const a = await user(),
    b = await user();
  const conversation_id = randomUUID();
  const clarification = await createJob(
    a.id,
    input("下午发送报价单", { conversation_id }),
  );
  const hidden = await createJob(a.id, input("普通便签", { conversation_id }));
  const other = await createJob(
    b.id,
    input("其他账户的问题", { conversation_id }),
  );
  const result = {
    title: "发送报价单",
    summary: "下午发送报价单",
    answer: "请问具体日期和几点？",
    source_note_ids: [],
    sources: [],
    todos: [],
    needs_clarification: true,
  };
  await query(
    "UPDATE jobs SET status='succeeded',result=$1 WHERE id=ANY($2::uuid[])",
    [JSON.stringify(result), [clarification.id, other.id]],
  );
  const token = await createSession(a.id);
  const response = await GET(
    new Request(
      `http://localhost/api/jobs?conversation_id=${conversation_id}`,
      { headers: { Cookie: `nota_session=${token}` } },
    ),
  );
  assert.equal(response.status, 200);
  const history = (await response.json()).jobs as {
    id: string;
    result: typeof result;
  }[];
  assert.deepEqual(
    history.map((job) => job.id),
    [clarification.id],
  );
  assert.equal(history[0].result.answer, result.answer);
  assert.ok(!history.some((job) => job.id === hidden.id));
});

test("30 concurrent distinct jobs accept exactly 10, without orphan notes", async () => {
  const u = await user();
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, () => createJob(u.id, input())),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
  for (const rejected of results.filter((r) => r.status === "rejected"))
    assert.equal((rejected.reason as AppError).status, 429);
  assert.equal((await quota(u.id)).used, 10);
  assert.equal(
    Number(
      (await query("SELECT count(*) FROM notes WHERE user_id=$1", [u.id]))
        .rows[0].count,
    ),
    10,
  );
});
test("same idempotency key submitted concurrently creates one task and one charge", async () => {
  const u = await user();
  const request = input();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => createJob(u.id, request)),
  );
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal((await quota(u.id)).used, 1);
  await expectCode(
    createJob(u.id, { ...request, input: "另一段不同的内容" }),
    409,
  );
  assert.equal((await quota(u.id)).used, 1);
});

test("different request keys for one recording reserve once and retain every payload binding", async () => {
  const u = await user();
  const note = await newNote(u.id, { transcript: "原始录音", source: "voice" });
  const requests = Array.from({ length: 20 }, () =>
    input("创建发送报价单的待办", { note_id: note.id }),
  );
  const results = await Promise.all(
    requests.map((request) => createJob(u.id, request)),
  );
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(results.filter((result) => !result.reused).length, 1);
  assert.equal((await quota(u.id)).used, 1);
  assert.equal(
    Number(
      (
        await query("SELECT count(*) FROM job_requests WHERE user_id=$1", [
          u.id,
        ])
      ).rows[0].count,
    ),
    20,
  );
  await expectCode(
    createJob(u.id, { ...requests[1], input: "不同内容", note_id: undefined }),
    409,
  );
  await expectCode(
    createJob(u.id, input("修改后的内容", { note_id: note.id })),
    409,
  );
  assert.equal((await quota(u.id)).used, 1);
});

test("a failed recording replayed with a new request key resumes its original tool ledger", async () => {
  const u = await user();
  const text = `创建待办 fail-after ${randomUUID()}`;
  const note = await newNote(u.id, { transcript: text, source: "voice" });
  const first = await createJob(u.id, input(text, { note_id: note.id }));
  await assert.rejects(runJob(u.id, first.id));
  assert.equal((await getJob(u.id, first.id)).status, "failed");
  const replay = await createJob(u.id, input(text, { note_id: note.id }));
  assert.equal(replay.id, first.id);
  assert.equal(replay.reused, true);
  await runJob(u.id, replay.id);
  assert.equal((await getJob(u.id, first.id)).status, "succeeded");
  assert.equal((await quota(u.id)).used, 1);
  assert.equal(
    Number(
      (await query("SELECT count(*) FROM todos WHERE note_id=$1", [note.id]))
        .rows[0].count,
    ),
    1,
  );
  const completedReplay = await createJob(
    u.id,
    input(text, { note_id: note.id }),
  );
  assert.equal(completedReplay.id, first.id);
  assert.equal((await quota(u.id)).used, 1);
  const other = await user();
  await expectCode(createJob(other.id, input(text, { note_id: note.id })), 404);
  assert.equal((await quota(other.id)).used, 0);
});

test("failed recording without side effects reuses its task and reserves only when retried", async () => {
  const u = await user();
  const text = `fail-before ${randomUUID()}`;
  const note = await newNote(u.id, { transcript: text, source: "voice" });
  const first = await createJob(u.id, input(text, { note_id: note.id }));
  await assert.rejects(runJob(u.id, first.id));
  assert.equal((await quota(u.id)).used, 0);
  const replay = await createJob(u.id, input(text, { note_id: note.id }));
  assert.equal(replay.id, first.id);
  assert.equal((await quota(u.id)).used, 0);
  await runJob(u.id, replay.id);
  assert.equal((await quota(u.id)).used, 1);
  assert.equal((await getJob(u.id, replay.id)).status, "succeeded");
});

test("task failure events distinguish retryable transport errors from configuration failures", async () => {
  const u = await user();
  for (const [code, retryable] of [
    ["MODEL_UNAVAILABLE", true],
    ["MODEL_REQUEST_REJECTED", false],
    ["MODEL_NOT_CONFIGURED", false],
  ] as const) {
    const created = await createJob(u.id, input());
    const claimed = (await claimJob(u.id, created.id))!;
    await failJob(claimed, new AppError(502, code, "合成失败"));
    const failure = (await getJob(u.id, created.id)).events.find(
      (event) => event.type === "failed",
    )!;
    assert.equal(failure.payload.code, code);
    assert.equal(failure.payload.retryable, retryable);
  }
});

test("concurrent clarification resolutions share one action and conflicting or deleted actions are not recreated", async () => {
  const u = await user();
  const conversationId = randomUUID();
  const originalInput = "帮我创建发送报价单的待办，请先问我具体时间。";
  const origin = await createJob(u.id, {
    kind: "chat",
    input: originalInput,
    conversation_id: conversationId,
    idempotency_key: randomUUID(),
  });
  await query(
    "UPDATE jobs SET status='succeeded',quota_state='consumed',agent_state=$1 WHERE id=$2",
    [
      JSON.stringify({ clarification: { origin_job_id: origin.id } }),
      origin.id,
    ],
  );
  const supplement = "2026年12月15日下午三点。";
  async function followup(text = supplement) {
    const created = await createJob(u.id, {
      kind: "chat",
      input: text,
      conversation_id: conversationId,
      idempotency_key: randomUUID(),
    });
    return (await claimJob(u.id, created.id))!;
  }
  const [first, second] = await Promise.all([followup(), followup()]);
  const resolution = {
    origin_job_id: origin.id,
    source_text: "不可信的归纳来源",
  };
  const args = { title: "发送报价单", due_at: "2026-12-15T15:00:00+08:00" };
  const results = await Promise.all([
    executeTool(first, "create_todo", args, true, resolution),
    executeTool(
      second,
      "create_todo",
      { ...args, due_at: "2026-12-15T07:00:00Z" },
      true,
      resolution,
    ),
  ]);
  assert.equal(results[0].todo!.id, results[1].todo!.id);
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.ok(result.todo!.source_text.includes(originalInput));
    assert.ok(result.todo!.source_text.includes(supplement));
    assert.ok(!result.todo!.source_text.includes(resolution.source_text));
  }
  const count = async () =>
    Number(
      (await query("SELECT count(*) FROM todos WHERE user_id=$1", [u.id]))
        .rows[0].count,
    );
  assert.equal(await count(), 1);
  assert.equal(
    Number(
      (
        await query(
          "SELECT count(*) FROM tool_runs WHERE job_id=ANY($1::uuid[]) AND has_effect",
          [[first.id, second.id]],
        )
      ).rows[0].count,
    ),
    1,
  );
  const conflict = await executeTool(
    await followup("改为下午四点。"),
    "create_todo",
    { ...args, due_at: "2026-12-15T16:00:00+08:00" },
    true,
    resolution,
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.needs_clarification, true);
  assert.equal(await count(), 1);
  await query("DELETE FROM todos WHERE id=$1", [results[0].todo!.id]);
  const deleted = await executeTool(
    await followup(),
    "create_todo",
    args,
    true,
    resolution,
  );
  assert.equal(deleted.ok, false);
  assert.match(deleted.clarification!, /已删除/);
  assert.equal(await count(), 0);
  // An explicitly independent action has no inherited resolution identity.
  const independent = await executeTool(
    await followup("独立新建另一条发送报价单的待办。"),
    "create_todo",
    args,
    true,
  );
  assert.equal(independent.ok, true);
  assert.equal(await count(), 1);
});

test("a clarification identity cannot be borrowed from another account or conversation", async () => {
  const a = await user(),
    b = await user();
  const conversationId = randomUUID();
  const origin = await createJob(a.id, {
    kind: "chat",
    input: "创建待办并追问时间",
    conversation_id: conversationId,
    idempotency_key: randomUUID(),
  });
  await query("UPDATE jobs SET status='succeeded',agent_state=$1 WHERE id=$2", [
    JSON.stringify({ clarification: { origin_job_id: origin.id } }),
    origin.id,
  ]);
  for (const [owner, conversation] of [
    [b, conversationId],
    [a, randomUUID()],
  ] as const) {
    const created = await createJob(owner.id, {
      kind: "chat",
      input: "下午三点",
      conversation_id: conversation,
      idempotency_key: randomUUID(),
    });
    const result = await executeTool(
      (await claimJob(owner.id, created.id))!,
      "create_todo",
      { title: "发送报价单", due_at: null },
      true,
      { origin_job_id: origin.id, source_text: "" },
    );
    assert.equal(result.ok, false);
  }
  assert.equal(
    Number(
      (
        await query(
          "SELECT count(*) FROM todos WHERE user_id=ANY($1::uuid[])",
          [[a.id, b.id]],
        )
      ).rows[0].count,
    ),
    0,
  );
});
test("text pipeline creates a real todo and replay does not execute it twice", async () => {
  const u = await user();
  const job = await createJob(u.id, input());
  await runJob(u.id, job.id);
  const result = await getJob(u.id, job.id);
  assert.equal(result.status, "succeeded");
  assert.equal(result.result?.todos.length, 1);
  await runJob(u.id, job.id);
  assert.equal(
    Number(
      (await query("SELECT count(*) FROM todos WHERE user_id=$1", [u.id]))
        .rows[0].count,
    ),
    1,
  );
  assert.equal((await quota(u.id)).used, 1);
  assert.ok(result.events.some((e) => e.type === "tool_result"));
});
test("failure after a committed tool retains charge; retry resumes persisted state", async () => {
  const u = await user();
  const request = input(`创建待办 fail-after ${randomUUID()}`);
  const job = await createJob(u.id, request);
  await assert.rejects(runJob(u.id, job.id));
  assert.equal((await getJob(u.id, job.id)).status, "failed");
  assert.equal((await quota(u.id)).used, 1);
  await runJob(u.id, job.id);
  assert.equal((await getJob(u.id, job.id)).status, "succeeded");
  assert.equal(
    Number(
      (await query("SELECT count(*) FROM todos WHERE user_id=$1", [u.id]))
        .rows[0].count,
    ),
    1,
  );
  assert.equal((await quota(u.id)).used, 1);
});
test("failure without effects refunds once; retry reserves once and succeeds", async () => {
  const u = await user();
  const job = await createJob(u.id, input(`fail-before ${randomUUID()}`));
  await assert.rejects(runJob(u.id, job.id));
  assert.equal((await quota(u.id)).used, 0);
  await runJob(u.id, job.id);
  assert.equal((await quota(u.id)).used, 1);
  assert.equal((await getJob(u.id, job.id)).status, "succeeded");
});
test("old usage does not consume today and replay stays linked to its original day", async () => {
  const u = await user();
  await query(
    "INSERT INTO usage_daily(user_id,day,used) VALUES($1,(now() AT TIME ZONE 'Asia/Shanghai')::date-1,10)",
    [u.id],
  );
  assert.equal((await quota(u.id)).used, 0);
  const request = input();
  const job = await createJob(u.id, request);
  assert.equal((await quota(u.id)).used, 1);
  assert.equal((await createJob(u.id, request)).id, job.id);
  assert.equal((await quota(u.id)).used, 1);
});
test("search and all object access are isolated by user", async () => {
  const a = await user(),
    b = await user();
  const owned = (
    await query(
      "INSERT INTO notes(user_id,title,transcript,status) VALUES($1,'报价','基础版报价8万元','ready') RETURNING id",
      [a.id],
    )
  ).rows[0].id;
  const hidden = (
    await query(
      "INSERT INTO notes(user_id,title,transcript,status) VALUES($1,'报价','另一账户报价99万元','ready') RETURNING id",
      [b.id],
    )
  ).rows[0].id;
  const task = await createJob(a.id, input("查询之前的报价", { kind: "chat" }));
  await runJob(a.id, task.id);
  const result = await getJob(a.id, task.id);
  assert.deepEqual(
    result.result?.sources.map((s) => s.id),
    [owned],
  );
  assert.ok(!JSON.stringify(result.result).includes("99万元"));
  await expectCode(getNote(a.id, hidden), 404);
  await expectCode(getJob(b.id, task.id), 404);
  await expectCode(deleteNote(a.id, hidden), 404);
});
test("empty retrieval produces an explicit no-evidence answer", async () => {
  const u = await user();
  const job = await createJob(u.id, input("查询之前的报价", { kind: "chat" }));
  await runJob(u.id, job.id);
  const result = await getJob(u.id, job.id);
  assert.match(result.result!.answer, /没有找到/);
  assert.deepEqual(result.result!.sources, []);
});
test("lease fencing rejects the previous runner after takeover", async () => {
  const u = await user();
  const made = await createJob(u.id, input());
  const first = (await claimJob(u.id, made.id))!;
  assert.equal(await claimJob(u.id, made.id), null);
  await query(
    "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
    [made.id],
  );
  const second = (await claimJob(u.id, made.id))!;
  assert.equal(second.fence, first.fence + 1);
  await expectCode(
    executeTool(first, "create_todo", { title: "旧执行器写入" }),
    409,
  );
  await failJob(first, new Error("old error"));
  assert.equal((await getJob(u.id, made.id)).status, "running");
});
test("tool crash replay uses the same side-effect result", async () => {
  const u = await user();
  const made = await createJob(u.id, input());
  const job = (await claimJob(u.id, made.id))!;
  const a = await executeTool(
    job,
    "create_todo",
    {
      title: "发送报价单",
      due_at: null,
    },
    true,
  );
  const b = await executeTool(
    job,
    "create_todo",
    {
      due_at: null,
      title: "发送报价单",
    },
    true,
  );
  assert.equal(a.todo!.id, b.todo!.id);
  assert.equal(
    Number(
      (await query("SELECT count(*) FROM todos WHERE user_id=$1", [u.id]))
        .rows[0].count,
    ),
    1,
  );
});
test("invalid tool dates are rejected without aborting a recoverable transaction", async () => {
  const u = await user();
  const made = await createJob(u.id, input());
  const job = (await claimJob(u.id, made.id))!;
  const result = await executeTool(job, "search_notes", {
    query: "报价",
    start_date: "2026-99-99",
    end_date: null,
  });
  assert.equal(result.ok, false);
  assert.equal(
    (
      await executeTool(job, "search_notes", {
        query: "报价",
        start_date: null,
        end_date: null,
      })
    ).ok,
    true,
  );
});
test("todo updates cannot cross accounts", async () => {
  const a = await user(),
    b = await user();
  const made = await createJob(a.id, input());
  await runJob(a.id, made.id);
  const id = (await getJob(a.id, made.id)).result!.todos[0].id;
  await expectCode(updateTodo(b.id, id, { completed: true }), 404);
  assert.equal(
    (await updateTodo(a.id, id, { completed: true })).completed,
    true,
  );
});

test("todo query isolates accounts, filters status and literal keywords, and reports pagination", async () => {
  const a = await user();
  const b = await user();
  await query(
    `INSERT INTO todos(user_id,title,completed,due_at) VALUES
     ($1,'报价 100%_\\ 版本',false,'2026-12-16T15:00:00+08:00'),
     ($1,'普通报价',false,'2026-12-15T15:00:00+08:00'),
     ($1,'已完成报价',true,NULL),($2,'其他账户报价',false,NULL)`,
    [a.id, b.id],
  );
  const made = await createJob(
    a.id,
    input("帮我看看有哪些待办", { kind: "chat" }),
  );
  const job = (await claimJob(a.id, made.id))!;
  const first = await executeTool(job, "list_todos", { limit: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.todo_list!.total, 2);
  assert.equal(first.todo_list!.has_more, true);
  assert.equal(first.todo_list!.todos[0].title, "普通报价");
  const second = await executeTool(job, "list_todos", { limit: 1, offset: 1 });
  assert.equal(second.todo_list!.total, 2);
  assert.equal(second.todo_list!.has_more, false);
  assert.equal(second.todo_list!.todos[0].title, "报价 100%_\\ 版本");
  const beyond = await executeTool(job, "list_todos", { offset: 10 });
  assert.equal(beyond.todo_list!.total, 2);
  assert.deepEqual(beyond.todo_list!.todos, []);
  const completed = await executeTool(job, "list_todos", {
    status: "completed",
  });
  assert.deepEqual(
    completed.todo_list!.todos.map((todo) => todo.title),
    ["已完成报价"],
  );
  const all = await executeTool(job, "list_todos", { status: "all" });
  assert.equal(all.todo_list!.total, 3);
  for (const keyword of ["%", "_", "\\"]) {
    const literal = await executeTool(job, "list_todos", { query: keyword });
    assert.equal(literal.todo_list!.total, 1);
    assert.equal(literal.todo_list!.todos[0].id, second.todo_list!.todos[0].id);
  }
  const empty = await executeTool(job, "list_todos", { query: "不存在" });
  assert.equal(empty.todo_list!.total, 0);
  assert.deepEqual(empty.todo_list!.todos, []);
  const replay = await executeTool(job, "list_todos", { limit: 1 });
  assert.deepEqual(replay, first);
  const effects = await query(
    "SELECT has_effect FROM tool_runs WHERE job_id=$1",
    [job.id],
  );
  assert.ok(effects.rows.every((row) => row.has_effect === false));
});

test("todo query rejects invalid or account-supplied parameters without poisoning its transaction", async () => {
  const u = await user();
  const made = await createJob(u.id, input("查询待办", { kind: "chat" }));
  const job = (await claimJob(u.id, made.id))!;
  for (const args of [
    { status: "invalid" },
    { limit: 0 },
    { limit: 51 },
    { offset: -1 },
    { offset: 1.5 },
    { query: 123 },
    { user_id: randomUUID() },
  ]) {
    const result = await executeTool(job, "list_todos", args);
    assert.equal(result.ok, false);
    assert.equal(result.todo_list, undefined);
  }
  assert.equal((await executeTool(job, "list_todos", {})).ok, true);
});
test("sessions are revocable; password hash and cookie attributes are enforced", async () => {
  const u = await user();
  const data = (
    await query("SELECT password_hash FROM users WHERE id=$1", [u.id])
  ).rows[0];
  assert.ok(!data.password_hash.includes("nota-test-password"));
  assert.equal((await login(u.email, "nota-test-password")).id, u.id);
  await expectCode(login(u.email, "wrong-password"), 401);
  const token = await createSession(u.id);
  const request = new Request("https://nota.example/api/me", {
    headers: { cookie: `nota_session=${token}` },
  });
  assert.equal((await currentUser(request))?.id, u.id);
  assert.match(sessionHeader(request, token), /HttpOnly; SameSite=Lax/);
  assert.match(sessionHeader(request, token), /Secure/);
  await destroySession(request);
  assert.equal(await currentUser(request), null);
});
test("cross-origin mutation is rejected", () => {
  assert.throws(
    () =>
      assertOrigin(
        new Request("https://nota.example/api/jobs", {
          headers: { Origin: "https://evil.example" },
        }),
      ),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
});

test("draft creation can retry a lost response without duplicate notes or owner disclosure", async () => {
  const a = await user(),
    b = await user();
  const id = randomUUID();
  const draft = { id, transcript: "需要保留的原文", source: "voice" };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => newNote(a.id, draft)),
  );
  assert.deepEqual(new Set(results.map((n) => n.id)), new Set([id]));
  await expectCode(newNote(b.id, draft), 409);
  assert.equal((await quota(a.id)).used, 0);
});

test("audio requires ownership before storage access and deletion retries remain durable", async () => {
  process.env.BLOB_READ_WRITE_TOKEN = "isolated-test-token";
  const a = await user(),
    b = await user();
  const note = await newNote(a.id, { transcript: "音频原文" });
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
  const file = new File([bytes], "recording.webm", { type: "audio/webm" });
  const objects = new Map<string, Uint8Array>();
  let reads = 0,
    writes = 0,
    failDelete = true;
  const storage: AudioStorage = {
    async write(path, f) {
      writes++;
      const pathname = `${path}-${randomUUID()}`;
      objects.set(pathname, new Uint8Array(await f.arrayBuffer()));
      return { pathname };
    },
    async read(path) {
      reads++;
      const data = objects.get(path);
      return data
        ? {
            stream: new Blob([data as Uint8Array<ArrayBuffer>]).stream(),
            size: data.length,
            contentType: "audio/webm",
          }
        : null;
    },
    async remove(path) {
      if (failDelete) throw new Error("transient");
      objects.delete(path);
    },
  };
  await expectCode(storeAudio(b.id, note.id, file, storage), 404);
  assert.equal(writes, 0);
  await expectCode(
    storeAudio(a.id, note.id, new File(["not-audio"], "a.mp3"), storage),
    400,
  );
  await storeAudio(a.id, note.id, file, storage);
  await expectCode(readAudio(b.id, note.id, null, storage), 404);
  assert.equal(reads, 0);
  const response = await readAudio(a.id, note.id, null, storage);
  assert.match(response.headers.get("cache-control")!, /private, no-store/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const partial = await readAudio(a.id, note.id, "bytes=1-3", storage);
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 1-3/8");
  assert.deepEqual(
    new Uint8Array(await partial.arrayBuffer()),
    bytes.slice(1, 4),
  );
  const suffix = await readAudio(a.id, note.id, "bytes=-2", storage);
  assert.equal((await suffix.arrayBuffer()).byteLength, 2);
  assert.equal(
    (await readAudio(a.id, note.id, "bytes=99-", storage)).status,
    416,
  );
  const job = await createJob(a.id, input("音频摘要", { note_id: note.id }));
  await expectCode(storeAudio(a.id, note.id, file, storage), 409);
  await runJob(a.id, job.id);
  await deleteNote(a.id, note.id);
  await expectCode(readAudio(a.id, note.id, null, storage), 404);
  await cleanupAudio(100, storage);
  assert.equal(objects.size, 1);
  const path = [...objects.keys()][0];
  assert.ok(
    (
      await query("SELECT attempts FROM blob_deletions WHERE pathname=$1", [
        path,
      ])
    ).rows[0].attempts > 0,
  );
  failDelete = false;
  await cleanupAudio(100, storage);
  assert.equal(objects.size, 0);
  assert.equal(
    (await query("SELECT 1 FROM blob_deletions WHERE pathname=$1", [path]))
      .rowCount,
    0,
  );
});

test("HTTP handlers complete login, job, tool, todo, source and logout flow", async () => {
  const origin = "http://127.0.0.1:3109";
  let cookie = "";
  async function request(path: string, method = "GET", body?: unknown) {
    const headers = {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
      "x-forwarded-for": `test-${randomUUID()}`,
    };
    const req = new Request(`${origin}/api/${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return (
      method === "GET"
        ? GET
        : method === "PATCH"
          ? PATCH
          : method === "DELETE"
            ? DELETE
            : POST
    )(req);
  }
  assert.equal((await request("notes")).status, 401);
  const auth = await request("auth/register", "POST", {
    email: `http-${randomUUID()}@example.test`,
    password: "nota-test-password",
  });
  assert.equal(auth.status, 201);
  cookie = auth.headers.get("set-cookie")!.split(";")[0];
  const me = await (await request("me")).json();
  assert.equal(me.quota.remaining, 10);
  const created = await request("jobs", "POST", input("创建发送报价单待办"));
  assert.equal(created.status, 201);
  const job = (await created.json()).job;
  const completed = await request(`jobs/${job.id}/run`, "POST");
  assert.equal(completed.status, 200);
  const result = (await completed.json()).job;
  assert.equal(result.status, "succeeded");
  assert.ok(
    result.events.some((e: { type: string }) => e.type === "tool_result"),
  );
  const todo = (await (await request("todos")).json()).todos[0];
  assert.equal(
    (await request(`todos/${todo.id}`, "PATCH", { completed: true })).status,
    200,
  );
  assert.equal((await request(`notes/${result.note_id}`)).status, 200);
  assert.equal((await (await request("me")).json()).quota.used, 1);
  assert.equal(
    (await request(`notes/${result.note_id}`, "DELETE")).status,
    200,
  );
  assert.equal((await (await request("todos")).json()).todos.length, 0);
  await request("auth/logout", "POST");
  assert.equal((await request("notes")).status, 401);
  assert.equal(
    (
      await POST(
        new Request(`${origin}/api/jobs`, {
          method: "POST",
          headers: { Origin: "https://evil.example" },
          body: "{}",
        }),
      )
    ).status,
    403,
  );
});

test("a proposed write rejected by intent validation never creates a todo", async () => {
  const u = await user();
  const job = await createJob(u.id, input("不要创建待办，只记录客户的安排"));
  await runJob(u.id, job.id);
  const result = await getJob(u.id, job.id);
  assert.equal(result.status, "succeeded");
  assert.equal(result.result!.todos.length, 0);
  assert.equal(
    Number(
      (await query("SELECT count(*) FROM todos WHERE user_id=$1", [u.id]))
        .rows[0].count,
    ),
    0,
  );
  assert.ok(
    result.events.some(
      (e) =>
        e.type === "tool_result" &&
        e.payload.name === "create_todo" &&
        (e.payload.result as { ok: boolean }).ok === false,
    ),
  );
});

test("search retains a missing entity instead of returning records matching only a generic word", async () => {
  const u = await user();
  await query(
    "INSERT INTO notes(user_id,title,transcript,status) VALUES($1,'海星客户报价','客户报价8万元','ready')",
    [u.id],
  );
  const made = await createJob(
    u.id,
    input("查询ZX999客户账号", { kind: "chat" }),
  );
  const job = (await claimJob(u.id, made.id))!;
  const result = await executeTool(job, "search_notes", {
    query: "ZX999 客户",
    start_date: null,
    end_date: null,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.sources, []);
});

test("origin validation accepts actual host after Next normalizes an internal localhost URL", () => {
  const request = new Request("http://localhost:3107/api/jobs", {
    headers: { Host: "127.0.0.1:3107", Origin: "http://127.0.0.1:3107" },
  });
  assert.doesNotThrow(() => assertOrigin(request));
  assert.throws(
    () =>
      assertOrigin(
        new Request("http://localhost:3107/api/jobs", {
          headers: { Host: "127.0.0.1:3107", Origin: "https://evil.example" },
        }),
      ),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
});
