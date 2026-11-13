import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { transaction, query, orm } from "./db";
import { jobs, jobEvents } from "./schema";
import { AppError } from "./errors";
import {
  jobInputSchema,
  type PublicJob,
  type Quota,
  type AgentResult,
} from "../lib/contracts";
export type DbJob = typeof jobs.$inferSelect;
export const timeZone = "Asia/Shanghai";
export async function event(
  client: PoolClient,
  jobId: string,
  type: string,
  payload: unknown,
) {
  await client.query(
    "INSERT INTO job_events(job_id,type,payload) VALUES($1,$2,$3)",
    [jobId, type, JSON.stringify(payload)],
  );
}
export async function quota(userId: string): Promise<Quota> {
  const r = await query<{ day: string; used: number }>(
    `SELECT to_char(now() AT TIME ZONE '${timeZone}','YYYY-MM-DD') AS day,COALESCE((SELECT used FROM usage_daily WHERE user_id=$1 AND day=(now() AT TIME ZONE '${timeZone}')::date),0) AS used`,
    [userId],
  );
  return {
    ...r.rows[0],
    limit: 10,
    remaining: 10 - r.rows[0].used,
    timezone: timeZone,
  };
}
async function reserve(client: PoolClient, userId: string, day: string) {
  await client.query(
    "INSERT INTO usage_daily(user_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [userId, day],
  );
  const r = await client.query(
    "UPDATE usage_daily SET used=used+1 WHERE user_id=$1 AND day=$2 AND used<10 RETURNING used",
    [userId, day],
  );
  if (!r.rowCount)
    throw new AppError(
      429,
      "DAILY_QUOTA_EXCEEDED",
      "今天的 10 次 AI 处理额度已用完。",
    );
}
export async function createJob(userId: string, raw: unknown) {
  const input = jobInputSchema.parse(raw);
  if (!process.env.DASHSCOPE_API_KEY)
    throw new AppError(503, "MODEL_NOT_CONFIGURED", "AI 服务尚未配置。");
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        kind: input.kind,
        input: input.input,
        note_id: input.note_id ?? null,
        conversation_id: input.conversation_id ?? null,
      }),
    )
    .digest("hex");
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${userId}:${input.idempotency_key}`,
    ]);
    const existing = await client.query(
      "SELECT job_id AS id,input_hash FROM job_requests WHERE user_id=$1 AND idempotency_key=$2",
      [userId, input.idempotency_key],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].input_hash !== hash)
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "此请求标识已用于其他内容，请新建请求。",
        );
      return { id: existing.rows[0].id as string, reused: true };
    }
    // A browser request key is not the identity of the recording being processed.
    // Serialize on the owned note before reserving quota, then reuse its original
    // task regardless of whether it is pending, failed or already completed.
    let noteId = input.note_id ?? null;
    if (input.kind === "chat" && noteId)
      throw new AppError(400, "INVALID_NOTE_LINK", "问答请求不能指定便签。");
    if (input.kind === "note" && noteId) {
      const n = await client.query(
        "SELECT status FROM notes WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [noteId, userId],
      );
      if (!n.rows[0]) throw new AppError(404, "NOTE_NOT_FOUND", "便签不存在。");
      const original = await client.query<{ id: string; input: string }>(
        "SELECT id,input FROM jobs WHERE user_id=$1 AND note_id=$2 AND kind='note' ORDER BY created_at,id LIMIT 1",
        [userId, noteId],
      );
      if (original.rows[0]) {
        if (original.rows[0].input !== input.input)
          throw new AppError(
            409,
            "NOTE_INPUT_CONFLICT",
            "此便签已开始处理，修改内容请新建便签；原任务可继续重试。",
          );
        await client.query(
          "INSERT INTO job_requests(user_id,idempotency_key,input_hash,job_id) VALUES($1,$2,$3,$4)",
          [userId, input.idempotency_key, hash, original.rows[0].id],
        );
        return { id: original.rows[0].id, reused: true };
      }
      if (n.rows[0].status !== "draft" && n.rows[0].status !== "failed")
        throw new AppError(
          409,
          "NOTE_ALREADY_PROCESSED",
          "此便签已提交处理，请查看原任务。",
        );
    }
    const d = await client.query<{ day: string }>(
      `SELECT to_char(now() AT TIME ZONE '${timeZone}','YYYY-MM-DD') AS day`,
    );
    const day = d.rows[0].day;
    await reserve(client, userId, day);
    if (input.kind === "note") {
      if (noteId) {
        await client.query(
          "UPDATE notes SET transcript=$1,status='processing',updated_at=now() WHERE id=$2",
          [input.input, noteId],
        );
      } else {
        const n = await client.query(
          "INSERT INTO notes(user_id,transcript,status,source) VALUES($1,$2,'processing','text') RETURNING id",
          [userId, input.input],
        );
        noteId = n.rows[0].id;
      }
    }
    const j = await client.query<{ id: string }>(
      "INSERT INTO jobs(user_id,idempotency_key,input_hash,kind,input,note_id,quota_day,conversation_id,business_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [
        userId,
        input.idempotency_key,
        hash,
        input.kind,
        input.input,
        noteId,
        day,
        input.conversation_id ?? null,
        input.kind === "note" ? `note:${noteId}` : null,
      ],
    );
    await client.query(
      "INSERT INTO job_requests(user_id,idempotency_key,input_hash,job_id) VALUES($1,$2,$3,$4)",
      [userId, input.idempotency_key, hash, j.rows[0].id],
    );
    await event(client, j.rows[0].id, "accepted", {
      kind: input.kind,
      note_id: noteId,
      quota_day: day,
    });
    return { id: j.rows[0].id, reused: false };
  });
}
export async function getJob(userId: string, id: string): Promise<PublicJob> {
  const [row] = await orm()
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.user_id, userId)));
  if (!row) throw new AppError(404, "JOB_NOT_FOUND", "任务不存在。");
  const events = await orm()
    .select({
      id: jobEvents.id,
      type: jobEvents.type,
      payload: jobEvents.payload,
      created_at: jobEvents.created_at,
    })
    .from(jobEvents)
    .where(eq(jobEvents.job_id, id))
    .orderBy(asc(jobEvents.id))
    .limit(200);
  return {
    id: row.id,
    kind: row.kind,
    input: row.input,
    conversation_id: row.conversation_id,
    note_id: row.note_id,
    status: row.status,
    attempt: row.attempt,
    result: row.result,
    error: row.error,
    created_at: row.created_at.toISOString(),
    lease_until: row.lease_until?.toISOString() ?? null,
    events: events.map((v) => ({
      ...v,
      id: v.id.toString(),
      created_at: v.created_at.toISOString(),
    })),
  };
}
export async function listConversationJobs(
  userId: string,
  conversationId: string,
) {
  const rows = await orm()
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.user_id, userId),
        eq(jobs.conversation_id, conversationId),
        or(
          eq(jobs.kind, "chat"),
          and(
            eq(jobs.kind, "note"),
            sql`${jobs.result}->>'needs_clarification' = 'true'`,
          ),
        ),
      ),
    )
    .orderBy(desc(jobs.created_at))
    .limit(20);
  return Promise.all(rows.reverse().map((row) => getJob(userId, row.id)));
}
export async function claimJob(
  userId: string,
  id: string,
): Promise<DbJob | null> {
  return transaction(async (client) => {
    const r = await client.query<DbJob & { lease_active: boolean }>(
      "SELECT *,quota_day::text AS quota_day,lease_until>now() AS lease_active FROM jobs WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [id, userId],
    );
    const row = r.rows[0];
    if (!row) throw new AppError(404, "JOB_NOT_FOUND", "任务不存在。");
    if (
      row.status === "succeeded" ||
      (row.status === "running" && row.lease_active)
    )
      return null;
    if (row.attempt >= 5)
      throw new AppError(
        409,
        "RETRY_LIMIT",
        "此任务已达到重试上限，请检查服务配置。",
      );
    if (row.quota_state === "refunded") {
      await reserve(client, userId, row.quota_day);
      await client.query("UPDATE jobs SET quota_state='reserved' WHERE id=$1", [
        id,
      ]);
    }
    const updated = await client.query<DbJob>(
      "UPDATE jobs SET status='running',attempt=attempt+1,fence=fence+1,lease_until=now()+interval '60 seconds',error=NULL,updated_at=now() WHERE id=$1 RETURNING *,quota_day::text AS quota_day",
      [id],
    );
    if (row.note_id)
      await client.query(
        "UPDATE notes SET status='processing',updated_at=now() WHERE id=$1 AND user_id=$2",
        [row.note_id, userId],
      );
    await event(client, id, "running", { attempt: updated.rows[0].attempt });
    return updated.rows[0];
  });
}
export async function guardJob(client: PoolClient, job: DbJob) {
  const r = await client.query(
    "SELECT id FROM jobs WHERE id=$1 AND user_id=$2 AND fence=$3 AND status='running' AND lease_until>now() FOR UPDATE",
    [job.id, job.user_id, job.fence],
  );
  if (!r.rowCount)
    throw new AppError(
      409,
      "LEASE_LOST",
      "任务已由另一个执行器接管，请刷新查看结果。",
    );
  await client.query(
    "UPDATE jobs SET lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1",
    [job.id],
  );
}
export async function saveState(job: DbJob, state: unknown) {
  await transaction(async (c) => {
    await guardJob(c, job);
    await c.query("UPDATE jobs SET agent_state=$1 WHERE id=$2", [
      JSON.stringify(state),
      job.id,
    ]);
  });
}
export async function completeJob(job: DbJob, result: AgentResult) {
  await transaction(async (c) => {
    await guardJob(c, job);
    const r = await c.query("SELECT note_id FROM jobs WHERE id=$1", [job.id]);
    const noteId = r.rows[0].note_id;
    if (noteId)
      await c.query(
        "UPDATE notes SET title=$1,summary=$2,status='ready',updated_at=now() WHERE id=$3 AND user_id=$4",
        [result.title, result.summary, noteId, job.user_id],
      );
    await c.query(
      "UPDATE jobs SET status='succeeded',quota_state='consumed',result=$1,lease_until=NULL,updated_at=now() WHERE id=$2",
      [JSON.stringify(result), job.id],
    );
    await event(c, job.id, "completed", {
      todo_count: result.todos.length,
      source_count: result.sources.length,
    });
  });
}
export async function failJob(job: DbJob, error: unknown) {
  await transaction(async (c) => {
    const owned = await c.query(
      "SELECT quota_state,note_id FROM jobs WHERE id=$1 AND fence=$2 AND status='running' FOR UPDATE",
      [job.id, job.fence],
    );
    if (!owned.rows[0]) return;
    const effects = await c.query(
      "SELECT 1 FROM tool_runs WHERE job_id=$1 AND has_effect=true LIMIT 1",
      [job.id],
    );
    const refund =
      !effects.rowCount && owned.rows[0].quota_state === "reserved";
    if (refund)
      await c.query(
        "UPDATE usage_daily SET used=used-1 WHERE user_id=$1 AND day=$2 AND used>0",
        [job.user_id, job.quota_day],
      );
    const message =
      error instanceof AppError ? error.message : "处理失败，请稍后重试。";
    const retryable =
      error instanceof AppError &&
      error.status >= 500 &&
      ![
        "MODEL_NOT_CONFIGURED",
        "DATABASE_NOT_CONFIGURED",
        "ASR_NOT_CONFIGURED",
        "MODEL_REQUEST_REJECTED",
      ].includes(error.code);
    await c.query(
      "UPDATE jobs SET status='failed',error=$1,quota_state=$2,lease_until=NULL,updated_at=now() WHERE id=$3",
      [message, refund ? "refunded" : "consumed", job.id],
    );
    if (owned.rows[0].note_id)
      await c.query(
        "UPDATE notes SET status='failed',updated_at=now() WHERE id=$1",
        [owned.rows[0].note_id],
      );
    await event(c, job.id, "failed", {
      message,
      refunded: refund,
      code: error instanceof AppError ? error.code : "PROCESSING_FAILED",
      retryable,
    });
  });
}
