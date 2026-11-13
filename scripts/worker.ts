import { config } from "dotenv";
import { setTimeout } from "node:timers/promises";
import { drainJobs } from "../src/server/worker";
import { cleanupAudio } from "../src/server/audio";
import { closeDatabase } from "../src/server/db";

config({ path: ".env.local", quiet: true });
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

async function main() {
  if (!process.env.DATABASE_URL || !process.env.DASHSCOPE_API_KEY)
    throw new Error("Database and model configuration are required.");
  do {
    try {
      const result = await drainJobs({ limit: 2 });
      await cleanupAudio(20);
      if (result.attempted || result.abandoned)
        console.log(JSON.stringify({ type: "worker_batch", ...result }));
    } catch {
      console.error("Worker batch failed; queued work remains in PostgreSQL.");
      if (process.argv.includes("--once")) process.exitCode = 1;
    }
    if (process.argv.includes("--once") || controller.signal.aborted) break;
    await setTimeout(5000, undefined, { signal: controller.signal }).catch(
      () => {},
    );
  } while (!controller.signal.aborted);
}

main()
  .catch(() => {
    console.error(
      "Worker could not start. Check database and model configuration.",
    );
    process.exitCode = 1;
  })
  .finally(closeDatabase);
