import { config } from "dotenv";
import { cleanupAudio, audioConfigured } from "../src/server/audio";
import { closeDatabase } from "../src/server/db";

config({ path: ".env.local", quiet: true });
async function main() {
  if (!audioConfigured() || !process.env.DATABASE_URL)
    throw new Error("Database and private Blob configuration are required.");
  await cleanupAudio(100);
  console.log(
    "Processed up to 100 pending audio deletions; failed items remain queued.",
  );
}
main()
  .catch(() => {
    console.error("Audio cleanup failed. Check service configuration.");
    process.exitCode = 1;
  })
  .finally(closeDatabase);
