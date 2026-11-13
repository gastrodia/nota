import { after } from "next/server";
import { query } from "./db";
import { runJob } from "./agent";
import { AppError } from "./errors";
import { failJob, type DbJob } from "./jobs";

// The database is the durable queue. A response callback is only a low-latency
// kick; an independent worker/scheduler also drains pending and expired work.
export function dispatchJob(
  userId: string,
  id: string,
  schedule: (callback: () => Promise<void>) => void = after,
) {
  try {
    schedule(async () => {
      await runJob(userId, id).catch(() => {
        // runJob persists the error, refund decision and retry classification.
      });
    });
    return true;
  } catch {
    // Direct handler tests and adapters without after() retain the durable job.
    // They can still execute it through the worker or authenticated /run route.
    return false;
  }
}

export async function drainJobs(options: { limit?: number } = {}) {
  const limit = Math.min(10, Math.max(1, options.limit ?? 2));
  const abandoned = await query<DbJob>(
    `SELECT *,quota_day::text AS quota_day FROM jobs
     WHERE status='running' AND lease_until<=now() AND attempt>=5
     ORDER BY updated_at LIMIT $1`,
    [limit],
  );
  for (const job of abandoned.rows)
    await failJob(
      job,
      new AppError(409, "RETRY_LIMIT", "任务多次中断，已停止自动重试。"),
    );

  const candidates = await query<{ id: string; user_id: string }>(
    `SELECT j.id,j.user_id FROM jobs j
     WHERE j.attempt<5 AND (
       j.status='pending'
       OR (j.status='running' AND j.lease_until<=now())
       OR (j.status='failed'
         AND (j.quota_state<>'refunded' OR COALESCE(
           (SELECT u.used FROM usage_daily u WHERE u.user_id=j.user_id AND u.day=j.quota_day),0)<10)
         AND j.updated_at <= now() - make_interval(secs => LEAST(300,15*power(2,GREATEST(j.attempt-1,0)))::int)
         AND (SELECT e.payload->>'retryable' FROM job_events e
              WHERE e.job_id=j.id AND e.type='failed' ORDER BY e.id DESC LIMIT 1)='true')
     ) ORDER BY j.updated_at,j.id LIMIT $1`,
    [limit],
  );
  const outcomes = await Promise.all(
    candidates.rows.map(async (job) => {
      try {
        await runJob(job.user_id, job.id);
      } catch {
        // Individual failures must not stop other accounts' queued jobs.
      }
      const current = await query<{ status: string }>(
        "SELECT status FROM jobs WHERE id=$1 AND user_id=$2",
        [job.id, job.user_id],
      );
      return current.rows[0]?.status ?? "deleted";
    }),
  );
  return {
    attempted: candidates.rowCount ?? 0,
    succeeded: outcomes.filter((status) => status === "succeeded").length,
    failed: outcomes.filter((status) => status === "failed").length,
    abandoned: abandoned.rowCount ?? 0,
  };
}
