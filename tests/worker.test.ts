import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMockModel } from "./fixtures/mock-model";
import { register } from "../src/server/auth";
import {
  createJob,
  claimJob,
  failJob,
  getJob,
  quota,
} from "../src/server/jobs";
import { drainJobs, dispatchJob } from "../src/server/worker";
import { query, closeDatabase } from "../src/server/db";
import { AppError } from "../src/server/errors";
import { GET as scheduledWorker } from "../src/app/api/internal/worker/route";

const target = new URL(
  process.env.TEST_DATABASE_URL ??
    "postgresql://nota_test:nota_local_test_only@127.0.0.1:55437/nota_test",
);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  target.pathname !== "/nota_test"
)
  throw new Error("Worker tests require isolated local nota_test PostgreSQL.");
process.env.DATABASE_URL = target.toString();
process.env.DASHSCOPE_API_KEY = "nota_test_key";
const provider = createMockModel();
before(async () => {
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture failed.");
  process.env.QWEN_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
});
after(async () => {
  await closeDatabase();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});

async function pending(text = "创建发送报价单的待办") {
  const user = await register(
    `worker-${randomUUID()}@example.test`,
    randomUUID(),
  );
  const job = await createJob(user.id, {
    kind: "note",
    input: `${text} ${randomUUID()}`,
    idempotency_key: randomUUID(),
  });
  return { user, job };
}

test("response callback can execute durable work without a browser /run request", async () => {
  const { user, job } = await pending();
  const callbacks: (() => Promise<void>)[] = [];
  assert.equal(
    dispatchJob(user.id, job.id, (callback) => callbacks.push(callback)),
    true,
  );
  assert.equal((await getJob(user.id, job.id)).status, "pending");
  await callbacks[0]();
  assert.equal((await getJob(user.id, job.id)).status, "succeeded");
  assert.equal((await quota(user.id)).used, 1);
});

test("worker retries a transient failure after backoff and preserves its logical job", async () => {
  const { user, job } = await pending("创建待办 fail-before");
  await drainJobs({ limit: 10 });
  assert.equal((await getJob(user.id, job.id)).status, "failed");
  assert.equal((await quota(user.id)).used, 0);
  await drainJobs({ limit: 10 });
  assert.equal((await getJob(user.id, job.id)).attempt, 1);
  await query(
    "UPDATE jobs SET updated_at=now()-interval '10 minutes' WHERE id=$1",
    [job.id],
  );
  await drainJobs({ limit: 10 });
  const completed = await getJob(user.id, job.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.attempt, 2);
  assert.equal(completed.result?.todos.length, 1);
  assert.equal((await quota(user.id)).used, 1);
});

test("worker skips active leases and reclaims an expired one", async () => {
  const { user, job } = await pending();
  const first = await claimJob(user.id, job.id);
  assert.ok(first);
  await drainJobs({ limit: 10 });
  assert.equal((await getJob(user.id, job.id)).attempt, 1);
  await query(
    "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
    [job.id],
  );
  await drainJobs({ limit: 10 });
  assert.equal((await getJob(user.id, job.id)).status, "succeeded");
  assert.equal((await getJob(user.id, job.id)).attempt, 2);
});

test("permanent provider rejection is not automatically replayed", async () => {
  const { user, job } = await pending();
  const claimed = await claimJob(user.id, job.id);
  assert.ok(claimed);
  await failJob(
    claimed,
    new AppError(
      502,
      "MODEL_REQUEST_REJECTED",
      "Provider rejected configuration.",
    ),
  );
  await query(
    "UPDATE jobs SET updated_at=now()-interval '10 minutes' WHERE id=$1",
    [job.id],
  );
  await drainJobs({ limit: 10 });
  assert.equal((await getJob(user.id, job.id)).attempt, 1);
  assert.equal((await quota(user.id)).used, 0);
});

test("exhausted crashed jobs settle reserved quota without another model call", async () => {
  const { user, job } = await pending();
  await claimJob(user.id, job.id);
  await query(
    "UPDATE jobs SET attempt=5,lease_until=now()-interval '1 second' WHERE id=$1",
    [job.id],
  );
  await drainJobs({ limit: 10 });
  assert.equal((await getJob(user.id, job.id)).status, "failed");
  assert.equal((await quota(user.id)).used, 0);
});

test("a refunded retry with no quota cannot starve already reserved work", async () => {
  const { user, job } = await pending();
  const claimed = await claimJob(user.id, job.id);
  assert.ok(claimed);
  await failJob(
    claimed,
    new AppError(502, "MODEL_UNAVAILABLE", "Transient failure"),
  );
  await query(
    "UPDATE jobs SET updated_at=now()-interval '10 minutes' WHERE id=$1",
    [job.id],
  );
  const reserved = [];
  for (let index = 0; index < 10; index++)
    reserved.push(
      await createJob(user.id, {
        kind: "note",
        input: `只记录队列测试${index}`,
        idempotency_key: randomUUID(),
      }),
    );
  const result = await drainJobs({ limit: 2 });
  assert.equal(result.succeeded, 2);
  assert.equal((await getJob(user.id, job.id)).attempt, 1);
  assert.equal((await getJob(user.id, reserved[0].id)).status, "succeeded");
  // Finish this scenario's synthetic queue before later global worker tests.
  for (let index = 0; index < 4; index++) await drainJobs({ limit: 2 });
});

test("scheduler refuses missing configuration and wrong bearer tokens", async () => {
  delete process.env.CRON_SECRET;
  const request = new Request("http://localhost/api/internal/worker");
  assert.equal((await scheduledWorker(request)).status, 503);
  process.env.CRON_SECRET = "worker-test-secret";
  assert.equal((await scheduledWorker(request)).status, 401);
  assert.equal(
    (
      await scheduledWorker(
        new Request(request, { headers: { authorization: "Bearer wrong" } }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await scheduledWorker(
        new Request(request, {
          headers: { authorization: "Bearer worker-test-secret" },
        }),
      )
    ).status,
    200,
  );
  delete process.env.CRON_SECRET;
});
