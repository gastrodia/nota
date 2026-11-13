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
} from "../src/server/auth";
import {
  createJob,
  claimJob,
  quota,
  getJob,
  failJob,
} from "../src/server/jobs";
import { runJob } from "../src/server/agent";
import { executeTool } from "../src/server/tools";
import {
  getNote,
  updateTodo,
  deleteNote,
  newNote,
} from "../src/server/repository";
import { query, closeDatabase } from "../src/server/db";
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
  const a = await executeTool(job, "create_todo", {
    title: "发送报价单",
    due_at: null,
  });
  const b = await executeTool(job, "create_todo", {
    due_at: null,
    title: "发送报价单",
  });
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
