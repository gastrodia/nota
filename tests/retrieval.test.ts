import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { register } from "../src/server/auth";
import { query, closeDatabase } from "../src/server/db";
import { createJob, claimJob } from "../src/server/jobs";
import { executeTool } from "../src/server/tools";
import { newNote, getNote, listNotes } from "../src/server/repository";
import { evidenceExcerpt, retrievalTerms } from "../src/server/retrieval";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgresql://nota_test:nota_local_test_only@127.0.0.1:55437/nota_test";
const target = new URL(url);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  target.pathname !== "/nota_test"
)
  throw new Error(
    "Retrieval tests require the isolated local nota_test database.",
  );
process.env.DATABASE_URL = url;
process.env.DASHSCOPE_API_KEY = "nota_test_retrieval_key";
const owners: string[] = [];
before(async () => {
  await query("SELECT 1");
});
after(async () => {
  if (owners.length)
    await query("DELETE FROM users WHERE id=ANY($1::uuid[])", [owners]);
  await closeDatabase();
});
async function owner() {
  const user = await register(
    `retrieval-${randomUUID()}@example.test`,
    "nota-test-password",
  );
  owners.push(user.id);
  return user;
}
async function ready(
  userId: string,
  text: string,
  recordedAt = "2026-11-13T02:00:00.000Z",
) {
  const note = await newNote(userId, {
    transcript: text,
    source: "text",
    recorded_at: recordedAt,
  });
  await query("UPDATE notes SET title=$1,status='ready' WHERE id=$2", [
    text.slice(0, 40),
    note.id,
  ]);
  return note;
}
async function search(
  userId: string,
  text: string,
  start: string | null = null,
  end: string | null = null,
) {
  const { id } = await createJob(userId, {
    kind: "chat",
    input: "检索测试",
    idempotency_key: randomUUID(),
  });
  const job = await claimJob(userId, id);
  assert.ok(job);
  return executeTool(job, "search_notes", {
    query: text,
    start_date: start,
    end_date: end,
  });
}

test("capture date remains distinct from upload date and drives historical filtering and order", async () => {
  const user = await owner();
  const old = await ready(
    user.id,
    "海星客户基础版报价8万元",
    "2026-10-15T07:00:00Z",
  );
  const current = await ready(
    user.id,
    "海星客户基础版报价9万元",
    "2026-11-01T07:00:00Z",
  );
  // Deliberately make the upload order disagree with the recording order.
  await query(
    "UPDATE notes SET created_at='2026-11-13T07:00:00Z' WHERE id=$1",
    [old.id],
  );
  await query(
    "UPDATE notes SET created_at='2026-11-12T07:00:00Z' WHERE id=$1",
    [current.id],
  );
  const result = await search(user.id, "海星 报价", "2026-10-01", "2026-10-31");
  assert.deepEqual(
    result.sources?.map((source) => source.id),
    [old.id],
  );
  assert.equal(
    new Date(result.sources![0].recorded_at!).toISOString(),
    "2026-10-15T07:00:00.000Z",
  );
  assert.equal(
    new Date((await getNote(user.id, old.id)).created_at).toISOString(),
    "2026-11-13T07:00:00.000Z",
  );
  assert.deepEqual(
    (await listNotes(user.id)).map((note) => note.id),
    [current.id, old.id],
  );
});

test("bounded synonyms improve price recall without dropping customer anchors or leaking accounts", async () => {
  const user = await owner();
  const other = await owner();
  const wanted = await ready(
    user.id,
    "海星客户基础版报价8万元，交付周期两周。",
  );
  await ready(user.id, "青山客户基础版价格6万元，交付周期一周。");
  await ready(other.id, "海星客户基础版报价99万元。");
  const found = await search(user.id, "海星 价格");
  assert.deepEqual(
    found.sources?.map((source) => source.id),
    [wanted.id],
  );
  assert.equal((await search(user.id, "火星ZX999 价格")).sources?.length, 0);
  assert.equal((await search(user.id, "海星 工期")).sources?.[0].id, wanted.id);
});

test("literal wildcard characters stay literal during expanded retrieval", async () => {
  const user = await owner();
  const literal = await ready(user.id, "合同编号A_100%报价8万元");
  await ready(user.id, "合同编号AB1009报价99万元");
  const result = await search(user.id, "A_100% 价格");
  assert.deepEqual(
    result.sources?.map((source) => source.id),
    [literal.id],
  );
});

test("conflicting quotation candidates request clarification rather than assuming latest means correct", async () => {
  const user = await owner();
  const first = await ready(
    user.id,
    "海星客户基础版报价8万元",
    "2026-10-15T07:00:00Z",
  );
  const second = await ready(
    user.id,
    "海星客户基础版报价9万元",
    "2026-10-20T07:00:00Z",
  );
  const result = await search(user.id, "海星 价格");
  assert.equal(result.needs_clarification, true);
  assert.match(result.clarification!, /日期|版本/);
  assert.deepEqual(
    new Set(result.sources?.map((source) => source.id)),
    new Set([first.id, second.id]),
  );
  const exactDate = await search(
    user.id,
    "海星 报价",
    "2026-10-15",
    "2026-10-15",
  );
  assert.equal(exactDate.needs_clarification, undefined);
});

test("repeated identical quotes are not falsely marked conflicting and empty audio drafts remain possible", async () => {
  const user = await owner();
  await ready(user.id, "海星客户报价八万元");
  await ready(user.id, "海星客户报价8万元");
  assert.equal(
    (await search(user.id, "海星 价格")).needs_clarification,
    undefined,
  );
  const draft = await newNote(user.id, {
    source: "voice",
    recorded_at: "2026-10-01T07:00:00Z",
  });
  assert.equal(draft.transcript, "");
  assert.equal(draft.status, "draft");
  assert.equal(
    new Date(draft.recorded_at).toISOString(),
    "2026-10-01T07:00:00.000Z",
  );
});

test("long evidence selects a window containing all matched concepts and explicitly marks truncation", () => {
  const text =
    "海星开场。" +
    "背景信息。".repeat(650) +
    "海星客户报价8万元，交付周期两周。";
  const row = {
    id: randomUUID(),
    title: "海星会议",
    transcript: text,
    created_at: new Date().toISOString(),
  };
  const excerpt = evidenceExcerpt(row, retrievalTerms("海星 价格"));
  assert.match(excerpt.transcript, /报价8万元/);
  assert.equal(excerpt.excerpt_truncated, true);
  assert.ok(excerpt.transcript.length <= 2500);
});
